import { z } from "zod";
import { UPI_ID } from "./settings";
import { BUSINESS_CATEGORIES, PRODUCT_CODES, type ProductCode } from "@/config/catalog";
import { isISODate, todayIST } from "@/lib/dates";
import type { Tx } from "../db";
import { conflict } from "../http/errors";
import { hashPassword } from "../auth/password";
import { isValidBusinessCode, temporaryPassword } from "./ids";
import { createSubscription } from "./subscriptions";
import { inviteAccount } from "./invitations";

const isoDate = z.string().refine(isISODate, "Use YYYY-MM-DD");

export const productSelectionSchema = z.object({
  productCode: z.enum(PRODUCT_CODES),
  tier: z.enum(["BASIC", "GROWTH"]),
  billingCycle: z.enum(["MONTHLY", "ANNUAL"]),
  /** Paise. Defaults to the plan's configured setup fee. */
  setupFee: z.number().int().min(0).optional(),
  startDate: isoDate.optional(),
  expiryDate: isoDate.optional(),
  graceDays: z.number().int().min(0).max(90).nullable().optional(),
  markSetupPaid: z.boolean().optional(),
  markSubscriptionPaid: z.boolean().optional(),
});

export const paymentMethodSchema = z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER", "CHEQUE", "CASHFREE", "OTHER"]);

export const businessProfileSchema = z.object({
  name: z.string().trim().min(2).max(120),
  category: z.enum(BUSINESS_CATEGORIES),
  ownerName: z.string().trim().min(2).max(100),
  phone: z.string().trim().regex(/^[+\d][\d\s-]{6,18}$/, "Enter a valid phone number"),
  email: z.string().trim().email().max(120).optional().or(z.literal("")),
  address: z.string().trim().max(300).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  pincode: z.string().trim().max(10).optional(),
  gstin: z.string().trim().max(20).optional(),
  /** Business's own UPI ID: customers pay bills to it (QR with the amount). */
  upiId: z.string().trim().max(320).regex(UPI_ID, "Enter a valid UPI ID, e.g. shopname@okaxis").optional().or(z.literal("")),
  upiPayeeName: z.string().trim().max(60).optional(),
});

export const newBusinessSchema = businessProfileSchema.extend({
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine(isValidBusinessCode, "Business code must be 2-12 letters/digits, start with a letter, and not be reserved."),
  products: z
    .array(productSelectionSchema)
    .min(1, "Select at least one SAF product")
    .max(3)
    .refine((a) => new Set(a.map((p) => p.productCode)).size === a.length, "Each product can be selected once"),
  paymentMethod: paymentMethodSchema.optional(),
  paymentReference: z.string().max(100).optional(),
  /** Branches besides the main one (step 4 of onboarding). */
  branches: z.array(z.object({
    name: z.string().trim().min(2).max(80),
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,12}$/, "Branch code: 2-12 letters or digits"),
    address: z.string().trim().max(300).optional(),
    phone: z.string().trim().max(20).optional(),
  })).max(20).default([]),
  /**
   * Owner account (step 5). "invite": the owner gets an email invitation and
   * sets their own password (needs the business email). "login_id": a
   * CODE@manager login with a one-time temporary password.
   */
  owner: z.object({
    method: z.enum(["invite", "login_id"]).default("login_id"),
    delivery: z.enum(["email", "link"]).default("email"),
  }).default({ method: "login_id", delivery: "email" }),
  /** SAF Team members to assign to the new business right away. */
  assignStaffIds: z.array(z.uuid()).max(20).default([]),
});

export type NewBusinessInput = z.infer<typeof newBusinessSchema>;

/** Gives every tenant owner (manager account) the manager role in a product. */
export async function grantOwnerAccess(db: Tx, tenantId: string, productCode: ProductCode) {
  const role = await db.role.findUniqueOrThrow({ where: { productCode_code: { productCode, code: "manager" } } });
  const owners = await db.user.findMany({ where: { tenantId, isTenantOwner: true } });
  for (const u of owners) {
    await db.userProductAccess.upsert({
      where: { userId_productCode: { userId: u.id, productCode } },
      create: { tenantId, userId: u.id, productCode, roleId: role.id },
      update: { roleId: role.id, isActive: true },
    });
  }
}

/** Product defaults created when a product is activated for a tenant. */
export async function bootstrapProduct(db: Tx, tenantId: string, productCode: ProductCode) {
  if (productCode === "bill") {
    const main = await db.branch.findFirst({ where: { tenantId, isMain: true } });
    if (main && !(await db.billCounter.findFirst({ where: { tenantId, branchId: main.id } })))
      await db.billCounter.create({ data: { tenantId, branchId: main.id, name: "Counter 1" } });
  }
}

export async function addProductToTenant(
  db: Tx,
  tenantId: string,
  sel: z.infer<typeof productSelectionSchema>,
  payment: { method?: z.infer<typeof paymentMethodSchema>; reference?: string },
  actor: { id: string } | null,
) {
  const sub = await createSubscription(db, tenantId, {
    productCode: sel.productCode,
    tier: sel.tier,
    billingCycle: sel.billingCycle,
    startDate: sel.startDate ?? todayIST(),
    expiryDate: sel.expiryDate,
    setupFee: sel.setupFee,
    graceDays: sel.graceDays ?? null,
    paid: { setup: sel.markSetupPaid, subscription: sel.markSubscriptionPaid, method: payment.method, reference: payment.reference },
  }, actor);
  await grantOwnerAccess(db, tenantId, sel.productCode);
  await bootstrapProduct(db, tenantId, sel.productCode);
  return sub;
}

/**
 * Super Admin "Add New Business": tenant + business profile + main branch +
 * one subscription per selected product + the manager account.
 * Returns the one-time credentials to hand over to the owner.
 */
export async function createBusiness(db: Tx, input: NewBusinessInput, actor: { id: string } | null) {
  if (await db.tenant.findUnique({ where: { code: input.code } }))
    throw conflict(`Business code ${input.code} is already in use.`);

  const tenant = await db.tenant.create({
    data: {
      code: input.code,
      business: {
        create: {
          name: input.name, category: input.category, ownerName: input.ownerName, phone: input.phone,
          email: input.email || null, address: input.address || null, city: input.city || null,
          state: input.state || null, pincode: input.pincode || null, gstin: input.gstin || null,
          upiId: input.upiId || null, upiPayeeName: input.upiPayeeName || null,
        },
      },
      branches: { create: { name: "Main Branch", code: "MAIN", isMain: true, address: input.address || null, phone: input.phone } },
    },
  });

  const mainCode = "MAIN";
  for (const b of input.branches) {
    if (b.code === mainCode) throw conflict("Branch code MAIN is used by the main branch.");
    await db.branch.create({ data: { tenantId: tenant.id, name: b.name, code: b.code, address: b.address || null, phone: b.phone || null } });
  }

  let username: string;
  let password: string | null = null;
  let invitation: { delivery: "email" | "link"; link: string | null } | null = null;
  if (input.owner.method === "invite") {
    if (!input.email) throw conflict("Enter the owner email to send an invitation.");
    const r = await inviteAccount(db, {
      email: input.email, fullName: input.ownerName, phone: input.phone, kind: "TENANT", tenantId: tenant.id,
      isTenantOwner: true, delivery: input.owner.delivery, invitedById: actor?.id ?? null,
    });
    username = r.user.username;
    invitation = { delivery: r.delivery, link: r.link };
  } else {
    password = temporaryPassword();
    username = `${input.code}@manager`;
    await db.user.create({
      data: {
        tenantId: tenant.id, kind: "TENANT", username, passwordHash: await hashPassword(password),
        fullName: input.ownerName, phone: input.phone, email: input.email || null,
        isTenantOwner: true, mustChangePassword: true,
      },
    });
  }

  for (const sel of input.products) {
    await addProductToTenant(db, tenant.id, sel, { method: input.paymentMethod, reference: input.paymentReference }, actor);
  }

  return { tenantId: tenant.id, code: tenant.code, managerUsername: username, temporaryPassword: password, invitation };
}
