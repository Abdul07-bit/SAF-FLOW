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
import { fileUrl, saveImage } from "../core/storage";
import { markInvoicePaid } from "../core/subscriptions";
import { businessProfileSchema } from "../core/tenancy";
import { writeAudit } from "../core/audit";
import { cashfreeMode, cashfreePhone, createCashfreeOrder, fetchCashfreePayment, isCashfreeConfigured, newOrderId, verifyCashfreeWebhook } from "../payments/cashfree";
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
  return u;
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
  method: "POST", path: "/:product/team", tag: "team", summary: "Create an employee login ID with product roles", auth: TEAM,
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
  method: "PATCH", path: "/:product/team/:userId", tag: "team", summary: "Edit a staff member and change product roles", auth: TEAM,
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
  method: "POST", path: "/:product/team/:userId/reset-password", tag: "team", summary: "Reset a staff password (issues a temporary password)", auth: TEAM,
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
  handler: async (ctx) => {
    const u = await loadMember(ctx);
    const r = await resendInvite(ctx.db, u.id, ctx.body.delivery);
    await ctx.audit("team.user.invite_resent", { type: "user", id: u.id }, { delivery: r.delivery });
    return { ok: true, delivery: r.delivery, inviteLink: r.link };
  },
});

route({
  method: "POST", path: "/:product/team/:userId/status", tag: "team", summary: "Enable or disable a staff account", auth: TEAM,
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
  auth: { product: ":product", permission: "settings.manage" },
  body: z.record(z.string(), z.unknown()),
  handler: async (ctx) => {
    const allowed = Object.keys(productSettingsSchemas[ctx.product].shape);
    const patch = Object.fromEntries(Object.entries(ctx.body).filter(([k]) => allowed.includes(k)));
    return saveProductSettings(ctx.db, ctx.tenantId, ctx.product, patch);
  },
});

route({
  method: "PUT", path: "/:product/business", tag: "settings", summary: "Edit the business profile (owner only)",
  auth: { product: ":product", permission: "settings.manage" },
  body: businessProfileSchema.omit({ category: true }).partial(),
  handler: async (ctx) => {
    if (!ctx.user.isTenantOwner) throw forbidden("PERMISSION_DENIED", "Only the business owner can edit the business profile.");
    const data = Object.fromEntries(Object.entries(ctx.body).map(([k, v]) => [k, v === "" ? null : v]));
    await ctx.db.business.update({ where: { tenantId: ctx.tenantId }, data });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/:product/business/logo", tag: "settings", summary: "Upload business logo (used on invoices and ID cards)",
  auth: { product: ":product", permission: "settings.manage" }, multipart: true,
  handler: async (ctx) => {
    const key = await saveImage(ctx.tenantId, "logo", ctx.form!.get("file") as File | null);
    await ctx.db.business.update({ where: { tenantId: ctx.tenantId }, data: { logoKey: key } });
    return { logoUrl: fileUrl(key) };
  },
});

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
        include: { payments: { where: { status: "SUCCEEDED" } } }, orderBy: { createdAt: "desc" }, take: 50,
      }),
      ctx.access.subscription
        ? ctx.db.subscriptionEvent.findMany({ where: { subscriptionId: ctx.access.subscription.id }, orderBy: { createdAt: "desc" }, take: 20 })
        : [],
      getPlatformSettings(ctx.db),
    ]);
    return {
      subscription: ctx.access.subscription,
      ...cmp,
      invoices: invoices.map((i) => ({ ...i, paidAmount: i.payments.reduce((a, b) => a + b.amount, 0), payments: undefined })),
      events,
      onlinePayments: settings.onlinePayments && isCashfreeConfigured(),
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
  method: "POST", path: "/:product/billing/invoices/:id/checkout", tag: "billing", summary: "Start an online (Cashfree) payment for a SAF invoice", auth: BILLING,
  handler: async (ctx) => {
    const settings = await getPlatformSettings(ctx.db);
    if (!settings.onlinePayments || !isCashfreeConfigured())
      throw new HttpError(503, "PAYMENTS_NOT_CONFIGURED", "Online payment is not available. Please contact SAF support to pay.");
    const inv = await ctx.db.invoice.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId }, include: { payments: { where: { status: "SUCCEEDED" } } } });
    if (!inv) throw notFound("Invoice");
    if (inv.status !== "ISSUED") throw conflict("This invoice is not payable.");
    const due = inv.total - inv.payments.reduce((a, b) => a + b.amount, 0);
    if (due < 100) throw conflict("Nothing left to pay on this invoice.");
    const [user, biz] = await Promise.all([
      ctx.db.user.findUnique({ where: { id: ctx.user.id }, select: { phone: true, email: true } }),
      ctx.db.business.findUnique({ where: { tenantId: ctx.tenantId }, select: { phone: true, email: true } }),
    ]);
    const phone = cashfreePhone(user?.phone) ?? cashfreePhone(biz?.phone);
    if (!phone) throw badRequest("Add a valid 10-digit mobile number to your business profile to pay online.");
    const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
    const orderId = newOrderId(inv.invoiceNo);
    const order = await createCashfreeOrder({
      orderId, amountPaise: due,
      customer: { id: `T${ctx.user.tenantCode ?? ""}${ctx.tenantId}`, phone, name: ctx.user.fullName, email: user?.email ?? biz?.email },
      // Cashfree fills {order_id}; the subscription page confirms the order on return.
      returnUrl: `${appUrl}/${ctx.params.product}/subscription?cf_order={order_id}`,
      notifyUrl: appUrl.startsWith("https://") ? `${appUrl}/api/webhooks/cashfree` : undefined,
      note: `${inv.invoiceNo} - ${inv.description}`,
    });
    await ctx.db.payment.create({
      data: { tenantId: ctx.tenantId, invoiceId: inv.id, subscriptionId: inv.subscriptionId, amount: due, method: "CASHFREE", status: "PENDING", gatewayOrderId: order.orderId },
    });
    return { orderId: order.orderId, paymentSessionId: order.paymentSessionId, mode: cashfreeMode(), amount: due, currency: "INR" };
  },
});

/**
 * Shared by the checkout confirmation and the webhook. Idempotent per gateway
 * order; refuses to settle when the gateway amount differs from the order.
 */
async function settleGatewayOrder(db: Tx, orderId: string, paymentId: string, amountPaise: number) {
  const pending = await db.payment.findUnique({ where: { gatewayOrderId: orderId }, include: { invoice: true } });
  if (!pending) throw notFound("Payment");
  if (pending.status === "SUCCEEDED") return pending;
  if (amountPaise !== pending.amount) {
    console.error("[cashfree] amount mismatch", { orderId, expected: pending.amount, got: amountPaise });
    throw conflict("The paid amount does not match this order. SAF support has been notified.");
  }
  const p = await db.payment.update({ where: { id: pending.id }, data: { status: "SUCCEEDED", gatewayPaymentId: paymentId, paidAt: new Date(), reference: paymentId } });
  if (pending.invoice && pending.invoice.status === "ISSUED") {
    const paid = await db.payment.aggregate({ where: { invoiceId: pending.invoice.id, status: "SUCCEEDED" }, _sum: { amount: true } });
    if ((paid._sum.amount ?? 0) >= pending.invoice.total) await markInvoicePaid(db, pending.invoice, null);
  }
  return p;
}

route({
  method: "POST", path: "/:product/billing/cashfree/confirm", tag: "billing",
  summary: "Confirm a Cashfree checkout: the server reads the order from Cashfree and settles it when PAID", auth: BILLING,
  body: z.object({ orderId: z.string().min(3).max(45).regex(/^[A-Za-z0-9_-]+$/) }),
  handler: async (ctx) => {
    // RLS confines this lookup to the caller's business.
    const pending = await ctx.db.payment.findFirst({ where: { gatewayOrderId: ctx.body.orderId, tenantId: ctx.tenantId }, select: { id: true, status: true } });
    if (!pending) throw notFound("Payment");
    if (pending.status === "SUCCEEDED") return { status: "PAID" };
    const r = await fetchCashfreePayment(ctx.body.orderId);
    if (!("cfPaymentId" in r)) return { status: r.status };
    const p = await settleGatewayOrder(ctx.db, ctx.body.orderId, r.cfPaymentId, r.amountPaise);
    await ctx.audit("billing.online_payment", { type: "payment", id: p.id }, { orderId: ctx.body.orderId, gateway: "cashfree" });
    return { status: "PAID" };
  },
});

route({
  method: "POST", path: "/webhooks/cashfree", tag: "billing", summary: "Cashfree payment webhook (PAYMENT_SUCCESS_WEBHOOK)",
  auth: { public: true }, rawBody: true, audit: false,
  handler: async (ctx) => {
    const raw = await ctx.req.text();
    const h = ctx.req.headers;
    if (!verifyCashfreeWebhook(raw, h.get("x-webhook-timestamp") || "", h.get("x-webhook-signature") || ""))
      throw new HttpError(400, "INVALID_SIGNATURE", "Invalid webhook signature.");
    const evt = JSON.parse(raw) as {
      type?: string;
      data?: { order?: { order_id?: string }; payment?: { cf_payment_id?: string | number; payment_status?: string; payment_amount?: number } };
    };
    const orderId = evt.data?.order?.order_id;
    const pay = evt.data?.payment;
    if (evt.type === "PAYMENT_SUCCESS_WEBHOOK" && pay?.payment_status === "SUCCESS" && orderId && pay.cf_payment_id != null) {
      await withPlatform(async (db) => {
        const p = await settleGatewayOrder(db, orderId, String(pay.cf_payment_id), Math.round(Number(pay.payment_amount) * 100)).catch((e) => {
          console.error("[cashfree] webhook not settled", orderId, e instanceof Error ? e.message : e);
          return null;
        });
        if (p) await writeAudit(db, { tenantId: p.tenantId, action: "billing.webhook_payment", entityType: "payment", entityId: p.id, meta: { gateway: "cashfree" } });
      });
    }
    return { ok: true };
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
