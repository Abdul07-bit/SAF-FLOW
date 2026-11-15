import { z } from "zod";
import { PRODUCTS, PRODUCT_CODES, isProductCode, type ProductCode } from "@/config/catalog";
import { route, type Ctx } from "../http/router";
import { registerCrud } from "../http/crud";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../http/errors";
import { nextSeq, withPlatform, withTenant, type Tx } from "../db";
import { hashPassword } from "../auth/password";
import { revokeUserSessions } from "../auth/session";
import { emailPasswordReset, looksLikeEmail } from "../auth/identity";
import { inviteAccount, resendInvite } from "../core/invitations";
import { isValidHandle, temporaryPassword } from "../core/ids";
import { isUsable, summarize } from "../core/access";
import { getPlatformSettings, productSettingsSchemas, saveProductSettings } from "../core/settings";
import { fileUrl, saveImage, storage } from "../core/storage";
import { businessProfileSchema } from "../core/tenancy";
import { writeAudit } from "../core/audit";
import { invoiceDue, submitReceipt, upiPayLink, UTR } from "../payments/upi";
import QRCode from "qrcode";
import { shopUpi } from "../payments/shop-upi";
import { branches } from "@/shared/resources";

// ---------------------------------------------------------------------------
// Team: staff login IDs and per-product roles
// ---------------------------------------------------------------------------

const TEAM = { product: ":product", feature: "staff_logins", permission: "staff.manage" } as const;

const accessInput = z.array(z.object({ product: z.enum(PRODUCT_CODES), roleCode: z.string().max(40).nullable() })).max(3);

/** Products for which the acting user may grant access (needs <product>.staff.manage). */
async function grantableProducts(db: Tx, ctx: Ctx): Promise<Set<ProductCode>> {
  const rows = await db.userProductAccess.findMany({
    where: { userId: ctx.user.id, isActive: true },
    include: { role: { include: { permissions: true } } },
  });
  const subs = await db.productSubscription.findMany({ where: { tenantId: ctx.tenantId }, include: { plan: true } });
  const out = new Set<ProductCode>();
  for (const r of rows) {
    const code = r.productCode as ProductCode;
    const sub = subs.find((s) => s.productCode === code);
    if (!sub || !isUsable(summarize({ ...sub, pendingPlan: null }).state)) continue;
    if (r.role.permissions.some((p) => p.permissionKey === `${code}.staff.manage`)) out.add(code);
  }
  return out;
}

async function applyAccess(db: Tx, ctx: Ctx, userId: string, access: z.infer<typeof accessInput>) {
  const grantable = await grantableProducts(db, ctx);
  for (const a of access) {
    if (!grantable.has(a.product))
      throw forbidden("PERMISSION_DENIED", `You cannot manage ${PRODUCTS[a.product].name} access (not subscribed or no permission).`);
    if (a.roleCode === null) {
      await db.userProductAccess.updateMany({ where: { userId, productCode: a.product }, data: { isActive: false } });
      continue;
    }
    const role = await db.role.findUnique({ where: { productCode_code: { productCode: a.product, code: a.roleCode } } });
    if (!role) throw badRequest(`Unknown role ${a.roleCode} for ${PRODUCTS[a.product].name}.`);
    if (role.code === "manager" && !ctx.user.isTenantOwner)
      throw forbidden("PERMISSION_DENIED", "Only the business owner can create manager accounts.");
    await db.userProductAccess.upsert({
      where: { userId_productCode: { userId, productCode: a.product } },
      create: { tenantId: ctx.tenantId, userId, productCode: a.product, roleId: role.id },
      update: { roleId: role.id, isActive: true },
    });
  }
}

/**
 * Restricts a staff member to specific branches ([] = every branch).
 * A branch-restricted manager can only grant branches they have themselves
 * and can never lift a restriction.
 */
async function applyBranches(ctx: Ctx, userId: string, branchIds: string[]) {
  const ids = [...new Set(branchIds)];
  if (ctx.access.branchRestricted) {
    if (!ids.length) throw forbidden("PERMISSION_DENIED", "You can only give access to your own branches.");
    const mine = new Set(ctx.access.branches.map((b) => b.id));
    if (ids.some((id) => !mine.has(id))) throw forbidden("PERMISSION_DENIED", "You can only give access to your own branches.");
  }
  if (ids.length) {
    const found = await ctx.db.branch.count({ where: { tenantId: ctx.tenantId, id: { in: ids } } });
    if (found !== ids.length) throw badRequest("Unknown branch.");
  }
  await ctx.db.userBranchAccess.deleteMany({ where: { userId, tenantId: ctx.tenantId } });
  if (ids.length) await ctx.db.userBranchAccess.createMany({ data: ids.map((branchId) => ({ tenantId: ctx.tenantId, userId, branchId })) });
}

async function loadMember(ctx: Ctx) {
  const u = await ctx.db.user.findFirst({ where: { id: ctx.params.userId, tenantId: ctx.tenantId } });
  if (!u) throw notFound("Staff member");
  if (u.isTenantOwner && !ctx.user.isTenantOwner) throw forbidden("PERMISSION_DENIED", "Only the business owner can change the owner account.");
  // Managers cannot act on other manager accounts (reset their password, disable
  // them, change their roles): that would let one manager take over another.
  if (!ctx.user.isTenantOwner && u.id !== ctx.user.id && (await isManagerAccount(ctx.db, u.id)))
    throw forbidden("PERMISSION_DENIED", "Only the business owner can change another manager's account.");
  return u;
}

/** True when the user holds the manager role in any SAF product of this business. */
async function isManagerAccount(db: Tx, userId: string): Promise<boolean> {
  return (await db.userProductAccess.count({ where: { userId, isActive: true, role: { code: "manager" } } })) > 0;
}

route({
  method: "GET", path: "/:product/team", tag: "team", summary: "Staff login accounts with access to this product", auth: TEAM,
  handler: async (ctx) => {
    const [users, roles, grantable] = await Promise.all([
      ctx.db.user.findMany({
        where: { tenantId: ctx.tenantId, productAccess: { some: { productCode: ctx.product } } },
        include: {
          productAccess: { include: { role: true } }, employeeProfile: { select: { id: true, employeeCode: true } },
          branchAccess: { select: { branchId: true } },
          invitations: { where: { status: "PENDING" }, take: 1, select: { sentAt: true, delivery: true } },
        },
        orderBy: [{ isTenantOwner: "desc" }, { fullName: "asc" }],
      }),
      ctx.db.role.findMany({ where: { productCode: { in: [...PRODUCT_CODES] } }, orderBy: { name: "asc" } }),
      grantableProducts(ctx.db, ctx),
    ]);
    return {
      items: users.map((u) => ({
        id: u.id, username: u.username, fullName: u.fullName, phone: u.phone, email: u.email, isActive: u.isActive,
        isTenantOwner: u.isTenantOwner, lastLoginAt: u.lastLoginAt, mustChangePassword: u.mustChangePassword,
        lockedUntil: u.lockedUntil, employeeCode: u.employeeProfile?.employeeCode ?? null,
        branchIds: u.branchAccess.map((b) => b.branchId),
        signIn: u.authUserId ? "email" : "login_id",
        invitePending: u.invitations.length > 0,
        access: u.productAccess.filter((a) => a.isActive).map((a) => ({ product: a.productCode, roleCode: a.role.code, roleName: a.role.name })),
      })),
      roles: roles.map((r) => ({ product: r.productCode, code: r.code, name: r.name, description: r.description })),
      grantableProducts: [...grantable],
      tenantCode: ctx.user.tenantCode,
    };
  },
});

route({
  method: "POST", path: "/:product/team", tag: "team", summary: "Create an employee login ID with product roles", auth: TEAM, stepUp: true,
  body: z.object({
    fullName: z.string().trim().min(2).max(100),
    /** "login_id": CODE@handle with a temporary password. "email": email invitation, they set their own password. */
    signIn: z.enum(["login_id", "email"]).default("login_id"),
    handle: z.string().trim().toLowerCase().refine(isValidHandle, "Login ID: 2-30 lower-case letters, digits, dot, dash or underscore, starting with a letter").optional(),
    phone: z.string().trim().max(20).optional(),
    email: z.string().trim().max(120).optional(),
    delivery: z.enum(["email", "link"]).default("email"),
    access: accessInput.min(1),
    /** Restrict to these branches; omitted or [] = every branch. */
    branchIds: z.array(z.uuid()).max(50).optional(),
  }),
  rateLimit: { limit: 10, windowMs: 60 * 60_000, by: "user" },
  handler: async (ctx) => {
    if (ctx.body.signIn === "email") {
      const email = (ctx.body.email ?? "").toLowerCase();
      if (!looksLikeEmail(email)) throw badRequest("Enter a valid email address to send the invitation.");
      const r = await inviteAccount(ctx.db, {
        email, fullName: ctx.body.fullName, phone: ctx.body.phone, kind: "TENANT", tenantId: ctx.tenantId,
        delivery: ctx.body.delivery, invitedById: ctx.user.id,
      });
      await applyAccess(ctx.db, ctx, r.user.id, ctx.body.access);
      const invBranches = ctx.body.branchIds?.length ? ctx.body.branchIds : ctx.access.branchRestricted ? ctx.access.branches.map((b) => b.id) : [];
      await applyBranches(ctx, r.user.id, invBranches);
      await ctx.audit("team.user.invite", { type: "user", id: r.user.id }, { email, access: ctx.body.access, branchIds: invBranches, delivery: r.delivery });
      ctx.status = 201;
      return { id: r.user.id, username: email, invited: true, delivery: r.delivery, inviteLink: r.link };
    }
    if (!ctx.body.handle) throw badRequest("Choose a login ID.");
    const username = `${ctx.user.tenantCode}@${ctx.body.handle}`;
    if (ctx.body.handle === "manager") throw badRequest("This login ID is reserved.");
    if (await ctx.db.user.findUnique({ where: { username }, select: { id: true } }))
      throw conflict(`Login ID ${username} is already taken.`);
    const password = temporaryPassword();
    const user = await ctx.db.user.create({
      data: {
        tenantId: ctx.tenantId, kind: "TENANT", username, passwordHash: await hashPassword(password),
        fullName: ctx.body.fullName, phone: ctx.body.phone || null, email: ctx.body.email || null, mustChangePassword: true,
      },
    });
    await applyAccess(ctx.db, ctx, user.id, ctx.body.access);
    // A branch-restricted manager always creates branch-restricted staff.
    const branchIds = ctx.body.branchIds?.length ? ctx.body.branchIds : ctx.access.branchRestricted ? ctx.access.branches.map((b) => b.id) : [];
    await applyBranches(ctx, user.id, branchIds);
    await ctx.audit("team.user.create", { type: "user", id: user.id }, { username, access: ctx.body.access, branchIds });
    ctx.status = 201;
    return { id: user.id, username, temporaryPassword: password };
  },
});

route({
  method: "PATCH", path: "/:product/team/:userId", tag: "team", summary: "Edit a staff member and change product roles", auth: TEAM, stepUp: true,
  body: z.object({
    fullName: z.string().trim().min(2).max(100).optional(),
    phone: z.string().trim().max(20).nullable().optional(),
    email: z.string().trim().max(120).nullable().optional(),
    access: accessInput.optional(),
    branchIds: z.array(z.uuid()).max(50).optional(),
  }),
  handler: async (ctx) => {
    const u = await loadMember(ctx);
    const { access, branchIds, ...profile } = ctx.body;
    // The email of an email-sign-in account is its identity: it is changed by the
    // account holder through the identity provider, never from the team screen.
    if (profile.email !== undefined && u.authUserId && (profile.email ?? "").toLowerCase() !== (u.email ?? "").toLowerCase())
      throw badRequest("The email of an email sign-in account cannot be changed here.");
    if (branchIds) {
      if (u.id === ctx.user.id) throw badRequest("You cannot change your own branch access.");
      if (u.isTenantOwner) throw badRequest("The business owner always has access to every branch.");
      await applyBranches(ctx, u.id, branchIds);
    }
    if (Object.keys(profile).length) await ctx.db.user.update({ where: { id: u.id }, data: profile });
    if (access) {
      if (u.id === ctx.user.id) throw badRequest("You cannot change your own roles.");
      await applyAccess(ctx.db, ctx, u.id, access);
    }
    await ctx.audit("team.user.update", { type: "user", id: u.id }, { access, branchIds });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/:product/team/:userId/reset-password", tag: "team", summary: "Reset a staff password (issues a temporary password)", auth: TEAM, stepUp: true,
  rateLimit: { limit: 10, windowMs: 60 * 60_000, by: "user" },
  handler: async (ctx) => {
    const u = await loadMember(ctx);
    if (u.authUserId) {
      await emailPasswordReset(u.email!);
      await ctx.db.user.update({ where: { id: u.id }, data: { failedLoginCount: 0, lockedUntil: null } });
      await ctx.audit("team.user.reset_password_email", { type: "user", id: u.id });
      return { username: u.username, emailed: true, email: u.email };
    }
    const password = temporaryPassword();
    await ctx.db.user.update({
      where: { id: u.id },
      data: { passwordHash: await hashPassword(password), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
    });
    await revokeUserSessions(ctx.db, u.id);
    await ctx.audit("team.user.reset_password", { type: "user", id: u.id });
    return { username: u.username, temporaryPassword: password };
  },
});

route({
  method: "POST", path: "/:product/team/:userId/resend-invite", tag: "team", summary: "Send a fresh invitation to a staff member who has not accepted yet", auth: TEAM,
  body: z.object({ delivery: z.enum(["email", "link"]).default("email") }),
  rateLimit: { limit: 10, windowMs: 60 * 60_000, by: "user" },
  handler: async (ctx) => {
    const u = await loadMember(ctx);
    const r = await resendInvite(ctx.db, u.id, ctx.body.delivery);
    await ctx.audit("team.user.invite_resent", { type: "user", id: u.id }, { delivery: r.delivery });
    return { ok: true, delivery: r.delivery, inviteLink: r.link };
  },
});

route({
  method: "POST", path: "/:product/team/:userId/status", tag: "team", summary: "Enable or disable a staff account", auth: TEAM, stepUp: true,
  body: z.object({ isActive: z.boolean() }),
  handler: async (ctx) => {
    const u = await loadMember(ctx);
    if (u.id === ctx.user.id) throw badRequest("You cannot disable your own account.");
    await ctx.db.user.update({ where: { id: u.id }, data: { isActive: ctx.body.isActive } });
    if (!ctx.body.isActive) await revokeUserSessions(ctx.db, u.id);
    await ctx.audit(ctx.body.isActive ? "team.user.enable" : "team.user.disable", { type: "user", id: u.id });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/:product/team/:userId/mfa-reset", tag: "team",
  summary: "Owner only: reset a staff member's two-step verification (lost phone)", auth: TEAM, stepUp: true,
  handler: async (ctx) => {
    if (!ctx.user.isTenantOwner) throw forbidden("PERMISSION_DENIED", "Only the business owner can reset two-step verification.");
    const u = await loadMember(ctx);
    if (u.id === ctx.user.id) throw badRequest("You cannot reset your own two-step verification. Use a recovery code or contact SAF support.");
    await ctx.db.user.update({ where: { id: u.id }, data: { mfaEnabledAt: null, mfaSecretEnc: null, mfaLastStep: null, mfaRecoveryHashes: [] } });
    await revokeUserSessions(ctx.db, u.id);
    await ctx.audit("team.user.mfa_reset", { type: "user", id: u.id });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Branches, settings, business profile
// ---------------------------------------------------------------------------

registerCrud(branches, {
  model: "branch",
  orderBy: [{ isMain: "desc" }, { name: "asc" }],
  beforeCreate: (_ctx, data) => ({ ...data, code: String(data.code).toUpperCase(), isMain: false }),
  beforeUpdate: (_ctx, data, existing) => {
    if (data.code) data.code = String(data.code).toUpperCase();
    if (existing.isMain && data.isActive === false) throw badRequest("The main branch cannot be deactivated.");
    return data;
  },
});

route({
  method: "PUT", path: "/:product/settings", tag: "settings", summary: "Update product-specific settings",
  auth: { product: ":product", permission: "settings.manage" }, stepUp: true,
  body: z.record(z.string(), z.unknown()),
  handler: async (ctx) => {
    // Only this product's settings are accepted; types are checked when the result is saved.
    const allowed = Object.keys(productSettingsSchemas[ctx.product].shape);
    const extra = Object.keys(ctx.body).filter((k) => !allowed.includes(k));
    if (extra.length) throw new HttpError(400, "UNKNOWN_FIELDS", `Unexpected field(s): ${extra.slice(0, 10).join(", ")}.`, { fields: extra });
    return saveProductSettings(ctx.db, ctx.tenantId, ctx.product, ctx.body);
  },
});

route({
  method: "PUT", path: "/:product/business", tag: "settings", summary: "Edit the business profile (owner only)",
  auth: { product: ":product", permission: "settings.manage" }, stepUp: true,
  body: businessProfileSchema.omit({ category: true }).partial(),
  handler: async (ctx) => {
    if (!ctx.user.isTenantOwner) throw forbidden("PERMISSION_DENIED", "Only the business owner can edit the business profile.");
    const data = Object.fromEntries(Object.entries(ctx.body).map(([k, v]) => [k, v === "" ? null : v]));
    await ctx.db.business.update({ where: { tenantId: ctx.tenantId }, data });
    if ("upiId" in ctx.body || "upiPayeeName" in ctx.body)
      await ctx.audit("business.upi_changed", { type: "tenant", id: ctx.tenantId }, { upiId: ctx.body.upiId ?? null });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/:product/business/logo", tag: "settings", summary: "Upload business logo (used on invoices and ID cards)",
  auth: { product: ":product", permission: "settings.manage" }, multipart: true,
  rateLimit: { limit: 20, windowMs: 60 * 60_000, by: "user" },
  handler: async (ctx) => {
    const key = await saveImage(ctx.tenantId, "logo", ctx.form!.get("file") as File | null);
    await ctx.db.business.update({ where: { tenantId: ctx.tenantId }, data: { logoKey: key } });
    return { logoUrl: fileUrl(key) };
  },
});

/**
 * Where customers' money goes: owner only, with a fresh sign-in, and audited.
 * A staff member must never be able to swap in their own UPI QR.
 */
route({
  method: "POST", path: "/:product/business/upi-qr", tag: "settings", summary: "Upload the business's UPI QR image (customer payments)",
  auth: { product: ":product", permission: "settings.manage" }, multipart: true, stepUp: true,
  rateLimit: { limit: 20, windowMs: 60 * 60_000, by: "user" },
  handler: async (ctx) => {
    if (!ctx.user.isTenantOwner) throw forbidden("PERMISSION_DENIED", "Only the business owner can change payment details.");
    const key = await saveImage(ctx.tenantId, "upiqr", ctx.form!.get("file") as File | null);
    const old = await ctx.db.business.findUnique({ where: { tenantId: ctx.tenantId }, select: { upiQrKey: true } });
    await ctx.db.business.update({ where: { tenantId: ctx.tenantId }, data: { upiQrKey: key } });
    if (old?.upiQrKey) await storage().remove(old.upiQrKey);
    await ctx.audit("business.upi_qr_changed", { type: "tenant", id: ctx.tenantId });
    return { upiQrUrl: fileUrl(key) };
  },
});

route({
  method: "DELETE", path: "/:product/business/upi-qr", tag: "settings", summary: "Remove the business's UPI QR image",
  auth: { product: ":product", permission: "settings.manage" }, stepUp: true,
  handler: async (ctx) => {
    if (!ctx.user.isTenantOwner) throw forbidden("PERMISSION_DENIED", "Only the business owner can change payment details.");
    const old = await ctx.db.business.findUnique({ where: { tenantId: ctx.tenantId }, select: { upiQrKey: true } });
    await ctx.db.business.update({ where: { tenantId: ctx.tenantId }, data: { upiQrKey: null } });
    if (old?.upiQrKey) await storage().remove(old.upiQrKey);
    await ctx.audit("business.upi_qr_removed", { type: "tenant", id: ctx.tenantId });
    return { ok: true };
  },
});

/** Cashiers of each product: who may show the customer the payment QR. */
const UPI_QR_PERMISSION = { dine: "billing.settle", bill: "pos.use", stay: "billing.manage" } as const;
for (const product of PRODUCT_CODES) {
  route({
    method: "GET", path: `/${product}/payments/upi`, tag: "billing",
    summary: "The business's UPI QR for a bill amount (shown to the customer on the cashier screen)",
    auth: { product, permission: UPI_QR_PERMISSION[product] },
    query: z.object({ amount: z.coerce.number().int().min(100).max(1_000_000_000), note: z.string().max(40).optional() }),
    handler: async (ctx) => {
      const b = await ctx.db.business.findUniqueOrThrow({ where: { tenantId: ctx.tenantId }, select: { name: true, upiId: true, upiPayeeName: true, upiQrKey: true } });
      return { upi: await shopUpi(b, ctx.query.amount, ctx.query.note || b.name) };
    },
  });
}

// ---------------------------------------------------------------------------
// Subscription & SAF billing (manager view)
// ---------------------------------------------------------------------------

const BILLING = { product: ":product", permission: "subscription.view", allowInactive: true } as const;

async function planComparison(db: Tx, product: ProductCode) {
  const [plans, catalog] = await Promise.all([
    db.plan.findMany({ where: { productCode: product, isActive: true }, include: { features: true }, orderBy: { tier: "asc" } }),
    db.featureCatalog.findMany({ where: { productCode: product }, orderBy: { sortOrder: "asc" } }),
  ]);
  return {
    plans: plans.map((p) => ({
      id: p.id, tier: p.tier, name: p.name, description: p.description, monthlyPrice: p.monthlyPrice,
      annualPrice: p.annualPrice, setupFee: p.setupFee, graceDays: p.graceDays,
    })),
    features: catalog.map((f) => ({
      key: f.key, name: f.name, group: f.groupName,
      tiers: Object.fromEntries(plans.map((p) => [p.tier, p.features.some((x) => x.featureKey === f.key)])),
    })),
  };
}

route({
  method: "GET", path: "/:product/subscription", tag: "billing", summary: "Subscription, plan comparison and SAF invoices for this product", auth: BILLING,
  handler: async (ctx) => {
    const [cmp, invoices, events, settings] = await Promise.all([
      planComparison(ctx.db, ctx.product),
      ctx.db.invoice.findMany({
        where: { tenantId: ctx.tenantId, OR: [{ productCode: ctx.product }, { productCode: null }] },
        include: { payments: { where: { OR: [{ status: "SUCCEEDED" }, { receiptKey: { not: null } }] }, orderBy: { createdAt: "desc" } } }, orderBy: { createdAt: "desc" }, take: 50,
      }),
      ctx.access.subscription
        ? ctx.db.subscriptionEvent.findMany({ where: { subscriptionId: ctx.access.subscription.id }, orderBy: { createdAt: "desc" }, take: 20 })
        : [],
      getPlatformSettings(ctx.db),
    ]);
    return {
      subscription: ctx.access.subscription,
      ...cmp,
      invoices: invoices.map((i) => {
        const receipt = i.payments.find((x) => x.receiptKey);
        return {
          ...i, payments: undefined,
          paidAmount: i.payments.filter((x) => x.status === "SUCCEEDED").reduce((a, b) => a + b.amount, 0),
          // Latest uploaded receipt: PENDING (being verified) or FAILED (rejected, with the reason).
          receipt: receipt && {
            id: receipt.id, status: receipt.status, amount: receipt.amount, reference: receipt.reference,
            createdAt: receipt.createdAt, reviewNote: receipt.reviewNote, url: fileUrl(receipt.receiptKey),
          },
        };
      }),
      events,
      upiPayments: !!settings.upiId,
      gstRateBp: settings.gstRateBp,
      support: { phone: settings.supportPhone, email: settings.supportEmail, whatsapp: settings.supportWhatsApp },
    };
  },
});

async function openTicket(db: Tx, tenantId: string, userId: string, userName: string, t: { product?: string | null; category: string; subject: string; priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT"; body: string }) {
  const ticketNo = await nextSeq(db, tenantId, "support-ticket");
  return db.supportTicket.create({
    data: {
      tenantId, ticketNo, productCode: t.product ?? null, category: t.category, subject: t.subject,
      priority: t.priority ?? "NORMAL", createdById: userId,
      messages: { create: { tenantId, authorId: userId, authorName: userName, body: t.body } },
    },
  });
}

route({
  method: "POST", path: "/:product/subscription/request", tag: "billing", summary: "Request an upgrade, renewal or plan change from SAF", auth: BILLING,
  body: z.object({
    type: z.enum(["UPGRADE", "DOWNGRADE", "RENEWAL", "BILLING_CYCLE", "CANCEL"]),
    billingCycle: z.enum(["MONTHLY", "ANNUAL"]).optional(),
    message: z.string().max(1000).optional(),
  }),
  rateLimit: { limit: 10, windowMs: 60 * 60_000, by: "user" },
  handler: async (ctx) => {
    const name = PRODUCTS[ctx.product].name;
    const t = await openTicket(ctx.db, ctx.tenantId, ctx.user.id, ctx.user.fullName, {
      product: ctx.product, category: "SUBSCRIPTION", priority: "HIGH",
      subject: `${name}: ${ctx.body.type.toLowerCase().replace("_", " ")} request`,
      body: `Request: ${ctx.body.type}${ctx.body.billingCycle ? ` (${ctx.body.billingCycle})` : ""}\nCurrent plan: ${ctx.access.subscription?.tier ?? "-"} ${ctx.access.subscription?.billingCycle ?? ""}\n\n${ctx.body.message ?? ""}`,
    });
    ctx.status = 201;
    return { ticketNo: t.ticketNo };
  },
});

route({
  method: "GET", path: "/:product/billing/invoices/:id/upi", tag: "billing",
  summary: "UPI payment details for a SAF invoice: SAF's UPI ID, amount due and a scannable QR code", auth: BILLING,
  handler: async (ctx) => {
    const settings = await getPlatformSettings(ctx.db);
    if (!settings.upiId) throw new HttpError(503, "PAYMENTS_NOT_CONFIGURED", "UPI payment is not available. Please contact SAF support to pay.");
    const inv = await ctx.db.invoice.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId }, select: { id: true, status: true } });
    if (!inv) throw notFound("Invoice");
    if (inv.status !== "ISSUED") throw conflict("This invoice is not payable.");
    const { invoice, due } = await invoiceDue(ctx.db, inv.id);
    if (due < 100) throw conflict("Nothing left to pay on this invoice.");
    const link = upiPayLink({ upiId: settings.upiId, payeeName: settings.upiPayeeName, amountPaise: due, note: invoice.invoiceNo });
    const qr = await QRCode.toDataURL(link, { margin: 1, width: 320, errorCorrectionLevel: "M" });
    return { upiId: settings.upiId, payeeName: settings.upiPayeeName, amount: due, invoiceNo: invoice.invoiceNo, link, qr };
  },
});

route({
  method: "POST", path: "/:product/billing/invoices/:id/receipt", tag: "billing",
  summary: "Upload a UPI payment receipt (screenshot + UPI reference) for SAF to verify", auth: BILLING, multipart: true,
  rateLimit: { limit: 10, windowMs: 60 * 60_000, by: "user" },
  handler: async (ctx) => {
    const utr = String(ctx.form!.get("utr") ?? "").replace(/\s+/g, "");
    if (!UTR.test(utr)) throw badRequest("Enter the UPI reference / UTR number shown in your UPI app (letters and digits only).");
    // Validate the invoice before storing anything.
    const inv = await ctx.db.invoice.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId }, select: { id: true, status: true } });
    if (!inv) throw notFound("Invoice");
    if (inv.status !== "ISSUED") throw conflict("This invoice is not payable.");
    const key = await saveImage(ctx.tenantId, "receipts", ctx.form!.get("file") as File | null);
    try {
      const pay = await submitReceipt(ctx.db, { tenantId: ctx.tenantId, invoiceId: inv.id, receiptKey: key, utr, userId: ctx.user.id });
      await ctx.audit("billing.receipt_uploaded", { type: "payment", id: pay.id }, { invoiceId: inv.id, amount: pay.amount });
      ctx.status = 201;
      return { id: pay.id, status: pay.status, amount: pay.amount };
    } catch (e) {
      await storage().remove(key);
      throw e;
    }
  },
});

// ---------------------------------------------------------------------------
// Activation page for products the business has not subscribed to
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/catalog/:product", tag: "billing", summary: "Plans and features of a SAF product (activation / upgrade page)",
  auth: { session: true },
  handler: async (ctx) => {
    const product = ctx.params.product;
    if (!isProductCode(product)) throw notFound("Product");
    return withPlatform(async (db) => {
      const p = await db.product.findUnique({ where: { code: product } });
      return { product: { code: product, name: p?.name ?? PRODUCTS[product].name, tagline: p?.tagline, description: p?.description }, ...(await planComparison(db, product)) };
    });
  },
});

route({
  method: "POST", path: "/catalog/:product/request", tag: "billing", summary: "Ask SAF to activate a product for this business",
  auth: { session: true },
  body: z.object({ tier: z.enum(["BASIC", "GROWTH"]), billingCycle: z.enum(["MONTHLY", "ANNUAL"]), message: z.string().max(1000).optional() }),
  rateLimit: { limit: 10, windowMs: 60 * 60_000, by: "user" },
  handler: async (ctx) => {
    const product = ctx.params.product;
    if (!isProductCode(product)) throw notFound("Product");
    if (!ctx.user.tenantId || !ctx.user.isTenantOwner) throw forbidden("PERMISSION_DENIED", "Only the business owner can request a new product.");
    const t = await withTenant(ctx.user.tenantId, async (db) => {
      const ticket = await openTicket(db, ctx.user.tenantId!, ctx.user.id, ctx.user.fullName, {
        product, category: "SUBSCRIPTION", priority: "HIGH",
        subject: `Activate ${PRODUCTS[product].name} (${ctx.body.tier} ${ctx.body.billingCycle})`,
        body: `Please activate ${PRODUCTS[product].name} - ${ctx.body.tier} plan, ${ctx.body.billingCycle} billing.\n\n${ctx.body.message ?? ""}`,
      });
      await writeAudit(db, { tenantId: ctx.user.tenantId, actor: ctx.user, action: "catalog.activation_request", productCode: product, ip: ctx.ip });
      return ticket;
    });
    ctx.status = 201;
    return { ticketNo: t.ticketNo };
  },
});

// ---------------------------------------------------------------------------
// Support tickets (tenant side)
// ---------------------------------------------------------------------------

const SUPPORT = { product: ":product", permission: "support.use", allowInactive: true } as const;

route({
  method: "GET", path: "/:product/support/tickets", tag: "support", summary: "This business's support tickets", auth: SUPPORT,
  handler: ({ db, tenantId }) =>
    db.supportTicket.findMany({ where: { tenantId }, orderBy: { updatedAt: "desc" }, include: { _count: { select: { messages: true } } }, take: 100 }),
});

route({
  method: "POST", path: "/:product/support/tickets", tag: "support", summary: "Raise a support ticket", auth: SUPPORT,
  body: z.object({
    subject: z.string().trim().min(3).max(150),
    category: z.enum(["GENERAL", "TECHNICAL", "BILLING", "SUBSCRIPTION", "FEATURE_REQUEST"]).default("GENERAL"),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
    body: z.string().trim().min(3).max(4000),
  }),
  rateLimit: { limit: 10, windowMs: 60 * 60_000, by: "user" },
  handler: async (ctx) => {
    const t = await openTicket(ctx.db, ctx.tenantId, ctx.user.id, ctx.user.fullName, { ...ctx.body, product: ctx.product });
    ctx.status = 201;
    return t;
  },
});

route({
  method: "GET", path: "/:product/support/tickets/:id", tag: "support", summary: "Ticket thread", auth: SUPPORT,
  handler: async ({ db, tenantId, params }) => {
    const t = await db.supportTicket.findFirst({ where: { id: params.id, tenantId }, include: { messages: { orderBy: { createdAt: "asc" } } } });
    if (!t) throw notFound("Ticket");
    return t;
  },
});

route({
  method: "POST", path: "/:product/support/tickets/:id/messages", tag: "support", summary: "Reply on a ticket", auth: SUPPORT,
  body: z.object({ body: z.string().trim().min(1).max(4000) }),
  rateLimit: { limit: 30, windowMs: 60 * 60_000, by: "user" },
  handler: async (ctx) => {
    const t = await ctx.db.supportTicket.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId } });
    if (!t) throw notFound("Ticket");
    if (t.status === "CLOSED") throw badRequest("This ticket is closed. Please raise a new one.");
    const m = await ctx.db.supportMessage.create({
      data: { tenantId: ctx.tenantId, ticketId: t.id, authorId: ctx.user.id, authorName: ctx.user.fullName, body: ctx.body.body },
    });
    await ctx.db.supportTicket.update({ where: { id: t.id }, data: { status: t.status === "RESOLVED" ? "OPEN" : t.status } });
    return m;
  },
});
