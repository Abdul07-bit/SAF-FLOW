import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { PRODUCTS, PRODUCT_CODES, type ProductCode } from "@/config/catalog";
import { addDays, addMonths, financialYear, isISODate, istDate, startOfDayIST, endOfDayIST, todayIST } from "@/lib/dates";
import { route } from "../http/router";
import { badRequest, conflict, notFound } from "../http/errors";
import { hashPassword } from "../auth/password";
import { revokeUserSessions } from "../auth/session";
import { emailPasswordReset } from "../auth/identity";
import { temporaryPassword, isValidBusinessCode } from "../core/ids";
import { isUsable, summarize } from "../core/access";
import {
  adjustSubscription, changePlan, issueInvoice, recordPayment, renewSubscription, runRenewalJob, setSubscriptionStatus,
} from "../core/subscriptions";
import { addProductToTenant, businessProfileSchema, createBusiness, newBusinessSchema, paymentMethodSchema, productSelectionSchema } from "../core/tenancy";
import { getPlatformSettings, platformSettingsSchema, savePlatformSettings } from "../core/settings";
import { fileUrl, saveImage } from "../core/storage";
import { notify } from "../core/notify";
import { isRazorpayConfigured } from "../payments/razorpay";

const isoDate = z.string().refine(isISODate, "Use YYYY-MM-DD");
const pageQuery = z.object({
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/admin/overview", tag: "admin", summary: "Super Admin dashboard metrics", auth: { platform: "platform.dashboard.read" },
  handler: async ({ db }) => {
    const now = new Date();
    const fy = financialYear(todayIST());
    const fyRange = { gte: startOfDayIST(fy.start), lte: endOfDayIST(fy.end) };
    const [totalBusinesses, suspendedBusinesses, subs, annualPrepaid, setupRevenue, outstanding, recent] = await Promise.all([
      db.tenant.count(),
      db.tenant.count({ where: { status: "SUSPENDED" } }),
      db.productSubscription.findMany({ include: { plan: true, tenant: { include: { business: true } } } }),
      db.invoice.aggregate({ _sum: { subtotal: true }, where: { status: "PAID", kind: "SUBSCRIPTION", billingCycle: "ANNUAL", paidAt: fyRange } }),
      db.invoice.aggregate({ _sum: { subtotal: true }, where: { status: "PAID", kind: "SETUP", paidAt: fyRange } }),
      db.invoice.aggregate({ _sum: { total: true }, _count: true, where: { status: "ISSUED" } }),
      db.tenant.findMany({ orderBy: { createdAt: "desc" }, take: 6, include: { business: true, subscriptions: { include: { plan: true } } } }),
    ]);

    const rows = subs.map((s) => ({ s, sum: summarize({ ...s, pendingPlan: null }, now) }));
    const active = rows.filter((r) => isUsable(r.sum.state) && r.s.tenant.status === "ACTIVE");
    const distinct = (pred: (r: (typeof rows)[number]) => boolean) => new Set(active.filter(pred).map((r) => r.s.tenantId)).size;
    const mrr = active.reduce((a, r) => a + (r.s.billingCycle === "MONTHLY" ? r.s.plan.monthlyPrice : Math.round(r.s.plan.annualPrice / 12)), 0);
    const in30 = now.getTime() + 30 * 86_400_000;
    const upcoming = rows
      .filter((r) => r.sum.state === "ACTIVE" && r.s.currentPeriodEnd.getTime() <= in30)
      .sort((a, b) => a.s.currentPeriodEnd.getTime() - b.s.currentPeriodEnd.getTime())
      .slice(0, 15)
      .map((r) => ({
        subscriptionId: r.s.id, tenantId: r.s.tenantId, business: r.s.tenant.business?.name ?? r.s.tenant.code,
        code: r.s.tenant.code, phone: r.s.tenant.business?.phone ?? null, product: r.s.productCode, tier: r.s.plan.tier,
        billingCycle: r.s.billingCycle, expiresAt: r.s.currentPeriodEnd, daysLeft: r.sum.daysLeft,
        renewalPrice: r.s.billingCycle === "MONTHLY" ? r.s.plan.monthlyPrice : r.s.plan.annualPrice,
      }));

    return {
      totalBusinesses,
      suspendedBusinesses,
      activeSubscriptions: active.length,
      basicCustomers: distinct((r) => r.s.plan.tier === "BASIC"),
      growthCustomers: distinct((r) => r.s.plan.tier === "GROWTH"),
      productCustomers: Object.fromEntries(PRODUCT_CODES.map((c) => [c, distinct((r) => r.s.productCode === c)])),
      mrr,
      annualPrepaidRevenue: annualPrepaid._sum.subtotal ?? 0,
      setupRevenue: setupRevenue._sum.subtotal ?? 0,
      financialYear: fy.label,
      expiredSubscriptions: rows.filter((r) => r.sum.state === "EXPIRED").length,
      graceSubscriptions: rows.filter((r) => r.sum.state === "GRACE").length,
      suspendedSubscriptions: rows.filter((r) => r.sum.state === "SUSPENDED").length,
      outstandingAmount: outstanding._sum.total ?? 0,
      outstandingInvoices: outstanding._count,
      upcomingRenewals: upcoming,
      recentBusinesses: recent.map((t) => ({
        id: t.id, code: t.code, name: t.business?.name ?? t.code, category: t.business?.category, createdAt: t.createdAt,
        products: t.subscriptions.map((s) => ({ code: s.productCode, tier: s.plan.tier })),
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Business management
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/admin/businesses", tag: "admin", summary: "List businesses (tenants)", auth: { platform: "platform.business.read" },
  query: pageQuery.extend({
    status: z.enum(["ACTIVE", "SUSPENDED", "CLOSED"]).optional(),
    product: z.enum(PRODUCT_CODES).optional(),
  }),
  handler: async ({ db, query }) => {
    const where: Prisma.TenantWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.product ? { subscriptions: { some: { productCode: query.product } } } : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q, mode: "insensitive" } },
              { business: { name: { contains: query.q, mode: "insensitive" } } },
              { business: { ownerName: { contains: query.q, mode: "insensitive" } } },
              { business: { phone: { contains: query.q } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      db.tenant.findMany({
        where, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize,
        include: { business: true, subscriptions: { include: { plan: true } }, _count: { select: { users: true } } },
      }),
      db.tenant.count({ where }),
    ]);
    return {
      total,
      items: items.map((t) => ({
        id: t.id, code: t.code, status: t.status, createdAt: t.createdAt, users: t._count.users,
        name: t.business?.name, category: t.business?.category, ownerName: t.business?.ownerName,
        phone: t.business?.phone, email: t.business?.email, city: t.business?.city,
        products: t.subscriptions.map((s) => {
          const sum = summarize({ ...s, pendingPlan: null });
          return { code: s.productCode, tier: s.plan.tier, billingCycle: s.billingCycle, state: sum.state, expiresAt: s.currentPeriodEnd };
        }),
      })),
    };
  },
});

route({
  method: "GET", path: "/admin/businesses/code-available", tag: "admin", summary: "Check whether a business code is free",
  auth: { platform: "platform.business.create" }, query: z.object({ code: z.string().max(20) }),
  handler: async ({ db, query }) => {
    const code = query.code.trim().toUpperCase();
    if (!isValidBusinessCode(code)) return { code, available: false, reason: "Use 2-12 letters/digits starting with a letter." };
    const taken = await db.tenant.findUnique({ where: { code } });
    return { code, available: !taken, reason: taken ? "Already in use" : null, managerUsername: `${code}@manager` };
  },
});

route({
  method: "POST", path: "/admin/businesses", tag: "admin",
  summary: "Add new business: tenant, products, plans and manager credentials", auth: { platform: "platform.business.create", elevated: true }, body: newBusinessSchema,
  handler: async (ctx) => {
    const result = await createBusiness(ctx.db, ctx.body, ctx.user);
    // A member who only sees assigned businesses is assigned to the one they
    // create, otherwise it would vanish from their view immediately.
    if (!ctx.platform.allTenants)
      await ctx.db.staffAssignment.create({ data: { userId: ctx.user.id, tenantId: result.tenantId, assignedById: ctx.user.id, note: "Created this business" } });
    await ctx.audit("admin.business.create", { type: "tenant", id: result.tenantId, tenantId: result.tenantId }, {
      code: result.code, products: ctx.body.products.map((p) => `${p.productCode}:${p.tier}:${p.billingCycle}`),
      autoAssigned: !ctx.platform.allTenants,
    });
    ctx.status = 201;
    return result;
  },
});

route({
  method: "GET", path: "/admin/businesses/:id", tag: "admin", summary: "Business detail", auth: { platform: "platform.business.read", target: "business" },
  handler: async ({ db, params }) => {
    const t = await db.tenant.findUnique({
      where: { id: params.id },
      include: {
        business: true,
        branches: { orderBy: { isMain: "desc" } },
        subscriptions: { include: { plan: true, pendingPlan: true }, orderBy: { productCode: "asc" } },
        tenantFeatures: true,
      },
    });
    if (!t) throw notFound("Business");
    const [users, invoices, payments, events] = await Promise.all([
      db.user.findMany({
        where: { tenantId: t.id }, orderBy: [{ isTenantOwner: "desc" }, { createdAt: "asc" }],
        include: { productAccess: { include: { role: true } } },
      }),
      db.invoice.findMany({ where: { tenantId: t.id }, orderBy: { createdAt: "desc" }, take: 50, include: { payments: true } }),
      db.payment.findMany({ where: { tenantId: t.id }, orderBy: { createdAt: "desc" }, take: 50 }),
      db.subscriptionEvent.findMany({ where: { tenantId: t.id }, orderBy: { createdAt: "desc" }, take: 40 }),
    ]);
    return {
      id: t.id, code: t.code, status: t.status, suspendedReason: t.suspendedReason, createdAt: t.createdAt,
      business: t.business ? { ...t.business, logoUrl: fileUrl(t.business.logoKey) } : null,
      branches: t.branches,
      subscriptions: t.subscriptions.map((s) => ({
        ...summarize(s), productCode: s.productCode, setupFee: s.setupFee, autoRenew: s.autoRenew,
        graceDaysOverride: s.graceDays, suspendedReason: s.suspendedReason,
        price: s.billingCycle === "MONTHLY" ? s.plan.monthlyPrice : s.plan.annualPrice,
      })),
      featureOverrides: t.tenantFeatures,
      users: users.map((u) => ({
        id: u.id, username: u.username, fullName: u.fullName, isTenantOwner: u.isTenantOwner, isActive: u.isActive,
        lastLoginAt: u.lastLoginAt, lockedUntil: u.lockedUntil, mustChangePassword: u.mustChangePassword,
        access: u.productAccess.map((a) => ({ product: a.productCode, role: a.role.name, isActive: a.isActive })),
      })),
      invoices: invoices.map((i) => ({
        ...i, paidAmount: i.payments.filter((p) => p.status === "SUCCEEDED").reduce((a, b) => a + b.amount, 0), payments: undefined,
      })),
      payments,
      events,
    };
  },
});

route({
  method: "PATCH", path: "/admin/businesses/:id", tag: "admin", summary: "Edit business profile", auth: { platform: "platform.business.update", target: "business" },
  body: businessProfileSchema.partial(),
  handler: async ({ db, params, body, audit }) => {
    const t = await db.tenant.findUnique({ where: { id: params.id } });
    if (!t) throw notFound("Business");
    const data = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v === "" ? null : v]));
    await db.business.update({ where: { tenantId: t.id }, data });
    await audit("admin.business.update", { type: "tenant", id: t.id, tenantId: t.id }, { fields: Object.keys(body) });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/admin/businesses/:id/status", tag: "admin", summary: "Suspend or activate a business", auth: { platform: "platform.business.suspend", target: "business" },
  body: z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]), reason: z.string().max(300).optional() }),
  handler: async ({ db, params, body, audit, user }) => {
    const t = await db.tenant.findUnique({ where: { id: params.id } });
    if (!t) throw notFound("Business");
    await db.tenant.update({
      where: { id: t.id },
      data: { status: body.status, suspendedReason: body.status === "SUSPENDED" ? body.reason ?? null : null },
    });
    if (body.status === "SUSPENDED") {
      const users = await db.user.findMany({ where: { tenantId: t.id }, select: { id: true } });
      for (const u of users) await revokeUserSessions(db, u.id);
    }
    await audit(body.status === "SUSPENDED" ? "admin.business.suspend" : "admin.business.activate", { type: "tenant", id: t.id, tenantId: t.id }, { reason: body.reason, by: user.username });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/admin/businesses/:id/products", tag: "admin", summary: "Activate another SAF product for a business", auth: { platform: "platform.entitlements.manage", target: "business" },
  body: productSelectionSchema.extend({ paymentMethod: paymentMethodSchema.optional(), paymentReference: z.string().max(100).optional() }),
  handler: async (ctx) => {
    const t = await ctx.db.tenant.findUnique({ where: { id: ctx.params.id } });
    if (!t) throw notFound("Business");
    const sub = await addProductToTenant(ctx.db, t.id, ctx.body, { method: ctx.body.paymentMethod, reference: ctx.body.paymentReference }, ctx.user);
    await notify(ctx.db, {
      tenantId: t.id, productCode: ctx.body.productCode, kind: "PRODUCT_ACTIVATED",
      title: `${PRODUCTS[ctx.body.productCode].name} activated`,
      body: `${PRODUCTS[ctx.body.productCode].name} (${ctx.body.tier === "BASIC" ? "Basic" : "Growth"}) is now available in your account.`,
      link: `/${ctx.body.productCode}`,
    });
    await ctx.audit("admin.subscription.create", { type: "subscription", id: sub.id, tenantId: t.id }, { product: ctx.body.productCode, tier: ctx.body.tier });
    ctx.status = 201;
    return { id: sub.id };
  },
});

route({
  method: "POST", path: "/admin/businesses/:id/logo", tag: "admin", summary: "Upload business logo (PNG/JPEG)", auth: { platform: "platform.business.update", target: "business" }, multipart: true,
  handler: async ({ db, params, form, audit }) => {
    const t = await db.tenant.findUnique({ where: { id: params.id } });
    if (!t) throw notFound("Business");
    const key = await saveImage(t.id, "logo", form!.get("file") as File | null);
    await db.business.update({ where: { tenantId: t.id }, data: { logoKey: key } });
    await audit("admin.business.logo", { type: "tenant", id: t.id, tenantId: t.id });
    return { logoUrl: fileUrl(key) };
  },
});

// ---------------------------------------------------------------------------
// Products, plans, pricing, features
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/admin/products", tag: "admin", summary: "SAF products with subscriber counts", auth: { platform: "platform.catalog.read" },
  handler: async ({ db }) => {
    const [products, subs] = await Promise.all([
      db.product.findMany({ orderBy: { sortOrder: "asc" }, include: { plans: { orderBy: { tier: "asc" } }, _count: { select: { features: true } } } }),
      db.productSubscription.findMany({ include: { plan: true } }),
    ]);
    return products.map((p) => {
      const mine = subs.filter((s) => s.productCode === p.code).map((s) => ({ s, st: summarize({ ...s, pendingPlan: null }).state }));
      return {
        code: p.code, name: p.name, tagline: p.tagline, description: p.description, isActive: p.isActive,
        featureCount: p._count.features,
        plans: p.plans,
        subscribers: {
          total: mine.length,
          active: mine.filter((m) => isUsable(m.st)).length,
          basic: mine.filter((m) => isUsable(m.st) && m.s.plan.tier === "BASIC").length,
          growth: mine.filter((m) => isUsable(m.st) && m.s.plan.tier === "GROWTH").length,
          expired: mine.filter((m) => m.st === "EXPIRED").length,
        },
      };
    });
  },
});

route({
  method: "PATCH", path: "/admin/products/:code", tag: "admin", summary: "Edit a SAF product / enable or disable it platform-wide", auth: { platform: "platform.catalog.manage" },
  body: z.object({
    name: z.string().min(2).max(60).optional(), tagline: z.string().max(120).optional(),
    description: z.string().max(500).optional(), isActive: z.boolean().optional(),
  }),
  handler: async ({ db, params, body }) => {
    const p = await db.product.findUnique({ where: { code: params.code } });
    if (!p) throw notFound("Product");
    return db.product.update({ where: { code: p.code }, data: body });
  },
});

route({
  method: "GET", path: "/admin/plans", tag: "admin", summary: "Plans and pricing for every product", auth: { platform: "platform.catalog.read" },
  handler: async ({ db }) =>
    db.plan.findMany({
      orderBy: [{ productCode: "asc" }, { tier: "asc" }],
      include: { _count: { select: { features: true, subscriptions: true } } },
    }),
});

route({
  method: "PATCH", path: "/admin/plans/:id", tag: "admin", summary: "Change plan pricing (per product)", auth: { platform: "platform.catalog.manage" },
  body: z.object({
    name: z.string().min(2).max(40).optional(),
    description: z.string().max(300).optional(),
    monthlyPrice: z.number().int().min(0).max(100_000_000).optional(),
    annualPrice: z.number().int().min(0).max(1_000_000_000).optional(),
    setupFee: z.number().int().min(0).max(1_000_000_000).optional(),
    graceDays: z.number().int().min(0).max(90).optional(),
    isActive: z.boolean().optional(),
  }),
  handler: async ({ db, params, body, audit }) => {
    const plan = await db.plan.findUnique({ where: { id: params.id } });
    if (!plan) throw notFound("Plan");
    const updated = await db.plan.update({ where: { id: plan.id }, data: body });
    await audit("admin.plan.update", { type: "plan", id: plan.id }, {
      product: plan.productCode, tier: plan.tier,
      before: { monthlyPrice: plan.monthlyPrice, annualPrice: plan.annualPrice, setupFee: plan.setupFee, graceDays: plan.graceDays },
      after: body,
    });
    return updated;
  },
});

route({
  method: "GET", path: "/admin/features", tag: "admin", summary: "Feature catalog with the Basic / Growth matrix per product", auth: { platform: "platform.catalog.read" },
  handler: async ({ db }) => {
    const [features, plans] = await Promise.all([
      db.featureCatalog.findMany({ orderBy: { sortOrder: "asc" } }),
      db.plan.findMany({ include: { features: true } }),
    ]);
    return PRODUCT_CODES.map((code) => {
      const pp = plans.filter((p) => p.productCode === code);
      return {
        code, name: PRODUCTS[code].name,
        plans: pp.map((p) => ({ id: p.id, tier: p.tier, name: p.name })),
        features: features.filter((f) => f.productCode === code).map((f) => ({
          key: f.key, name: f.name, group: f.groupName, defaultTier: f.defaultTier,
          plans: Object.fromEntries(pp.map((p) => [p.tier, p.features.some((x) => x.featureKey === f.key)])),
        })),
      };
    });
  },
});

route({
  method: "PUT", path: "/admin/plans/:id/features/:key", tag: "admin", summary: "Include or exclude a feature in a plan", auth: { platform: "platform.catalog.manage" },
  body: z.object({ enabled: z.boolean() }),
  handler: async ({ db, params, body, audit }) => {
    const plan = await db.plan.findUnique({ where: { id: params.id } });
    const feature = await db.featureCatalog.findUnique({ where: { key: params.key } });
    if (!plan || !feature) throw notFound("Plan feature");
    if (feature.productCode !== plan.productCode) throw badRequest("Feature belongs to a different product.");
    if (body.enabled) await db.planFeature.upsert({ where: { planId_featureKey: { planId: plan.id, featureKey: feature.key } }, create: { planId: plan.id, featureKey: feature.key }, update: {} });
    else await db.planFeature.deleteMany({ where: { planId: plan.id, featureKey: feature.key } });
    await audit("admin.plan.feature", { type: "plan", id: plan.id }, { feature: feature.key, enabled: body.enabled, tier: plan.tier });
    return { ok: true };
  },
});

route({
  method: "GET", path: "/admin/businesses/:id/features", tag: "admin", summary: "Effective features of a business per subscribed product", auth: { platform: "platform.business.read", target: "business" },
  handler: async ({ db, params }) => {
    const t = await db.tenant.findUnique({
      where: { id: params.id },
      include: { subscriptions: { include: { plan: { include: { features: true } } } }, tenantFeatures: true },
    });
    if (!t) throw notFound("Business");
    const catalog = await db.featureCatalog.findMany({ orderBy: { sortOrder: "asc" } });
    return t.subscriptions.map((s) => ({
      product: s.productCode, tier: s.plan.tier,
      features: catalog.filter((f) => f.productCode === s.productCode).map((f) => {
        const inPlan = s.plan.features.some((x) => x.featureKey === f.key);
        const o = t.tenantFeatures.find((x) => x.featureKey === f.key);
        return { key: f.key, name: f.name, group: f.groupName, inPlan, override: o ? (o.enabled ? "grant" : "revoke") : "inherit", note: o?.note ?? null, effective: o ? o.enabled : inPlan };
      }),
    }));
  },
});

route({
  method: "PUT", path: "/admin/businesses/:id/features/:key", tag: "admin", summary: "Grant / revoke a single feature for one business", auth: { platform: "platform.entitlements.manage", target: "business" },
  body: z.object({ mode: z.enum(["inherit", "grant", "revoke"]), note: z.string().max(200).optional() }),
  handler: async ({ db, params, body, audit }) => {
    const feature = await db.featureCatalog.findUnique({ where: { key: params.key } });
    if (!feature) throw notFound("Feature");
    if (body.mode === "inherit") await db.tenantFeature.deleteMany({ where: { tenantId: params.id, featureKey: feature.key } });
    else
      await db.tenantFeature.upsert({
        where: { tenantId_featureKey: { tenantId: params.id, featureKey: feature.key } },
        create: { tenantId: params.id, featureKey: feature.key, enabled: body.mode === "grant", note: body.note },
        update: { enabled: body.mode === "grant", note: body.note },
      });
    await audit("admin.tenant.feature", { type: "tenant", id: params.id, tenantId: params.id }, { feature: feature.key, mode: body.mode });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/admin/subscriptions", tag: "admin", summary: "All product subscriptions", auth: { platform: "platform.subscription.read" },
  query: z.object({
    q: z.string().max(100).optional(),
    product: z.enum(PRODUCT_CODES).optional(),
    tier: z.enum(["BASIC", "GROWTH"]).optional(),
    state: z.enum(["ACTIVE", "GRACE", "EXPIRED", "SUSPENDED", "CANCELLED", "PENDING", "EXPIRING"]).optional(),
  }),
  handler: async ({ db, query }) => {
    const subs = await db.productSubscription.findMany({
      where: {
        ...(query.product ? { productCode: query.product } : {}),
        ...(query.tier ? { plan: { tier: query.tier } } : {}),
        ...(query.q ? { tenant: { OR: [{ code: { contains: query.q, mode: "insensitive" } }, { business: { name: { contains: query.q, mode: "insensitive" } } }] } } : {}),
      },
      include: { plan: true, pendingPlan: true, tenant: { include: { business: true } } },
      orderBy: { currentPeriodEnd: "asc" },
      take: 1000,
    });
    const items = subs.map((s) => ({
      ...summarize(s), productCode: s.productCode, tenantId: s.tenantId, code: s.tenant.code,
      business: s.tenant.business?.name, phone: s.tenant.business?.phone, tenantStatus: s.tenant.status,
      price: s.billingCycle === "MONTHLY" ? s.plan.monthlyPrice : s.plan.annualPrice, autoRenew: s.autoRenew,
    }));
    const filtered = !query.state ? items : query.state === "EXPIRING"
      ? items.filter((i) => i.state === "ACTIVE" && i.daysLeft <= 30)
      : items.filter((i) => i.state === query.state);
    return { items: filtered, total: filtered.length };
  },
});

route({
  method: "POST", path: "/admin/subscriptions/:id/renew", tag: "admin",
  summary: "Renew for one billing cycle (optionally record the payment)", auth: { platform: "platform.subscription.manage", target: "subscription" },
  body: z.object({
    billingCycle: z.enum(["MONTHLY", "ANNUAL"]).optional(),
    payment: z.object({ method: paymentMethodSchema, reference: z.string().max(100).optional() }).optional(),
  }),
  handler: async (ctx) => {
    const invoice = await renewSubscription(ctx.db, ctx.params.id, ctx.body, ctx.user);
    await ctx.audit("admin.subscription.renew", { type: "subscription", id: ctx.params.id, tenantId: invoice.tenantId }, { invoiceNo: invoice.invoiceNo, paid: !!ctx.body.payment });
    return { invoice };
  },
});

route({
  method: "POST", path: "/admin/subscriptions/:id/change-plan", tag: "admin", summary: "Upgrade / downgrade a product plan", auth: { platform: "platform.subscription.manage", target: "subscription" },
  body: z.object({
    tier: z.enum(["BASIC", "GROWTH"]),
    billingCycle: z.enum(["MONTHLY", "ANNUAL"]).optional(),
    effective: z.enum(["NOW", "PERIOD_END"]).default("NOW"),
    chargeProration: z.boolean().optional(),
  }),
  handler: async (ctx) => {
    const sub = await ctx.db.productSubscription.findUnique({ where: { id: ctx.params.id } });
    if (!sub) throw notFound("Subscription");
    const r = await changePlan(ctx.db, sub.id, ctx.body, ctx.user);
    await ctx.audit("admin.subscription.change_plan", { type: "subscription", id: sub.id, tenantId: sub.tenantId }, ctx.body);
    if (r.applied === "NOW")
      await notify(ctx.db, {
        tenantId: sub.tenantId, productCode: sub.productCode, kind: "PLAN_CHANGED",
        title: `${PRODUCTS[sub.productCode as ProductCode].name} plan changed`,
        body: `Your plan is now ${ctx.body.tier === "GROWTH" ? "Growth" : "Basic"}.`, link: `/${sub.productCode}`,
      });
    return r;
  },
});

route({
  method: "POST", path: "/admin/subscriptions/:id/status", tag: "admin", summary: "Suspend, reactivate or cancel a subscription", auth: { platform: "platform.subscription.manage", target: "subscription" },
  body: z.object({ action: z.enum(["suspend", "reactivate", "cancel"]), reason: z.string().max(300).optional() }),
  handler: async (ctx) => {
    const sub = await ctx.db.productSubscription.findUnique({ where: { id: ctx.params.id } });
    if (!sub) throw notFound("Subscription");
    await setSubscriptionStatus(ctx.db, sub.id, ctx.body.action, ctx.body.reason, ctx.user);
    await ctx.audit(`admin.subscription.${ctx.body.action}`, { type: "subscription", id: sub.id, tenantId: sub.tenantId }, { reason: ctx.body.reason });
    return { ok: true };
  },
});

route({
  method: "PATCH", path: "/admin/subscriptions/:id", tag: "admin", summary: "Adjust expiry date, grace period or auto-renew", auth: { platform: "platform.subscription.manage", target: "subscription" },
  body: z.object({ expiryDate: isoDate.optional(), graceDays: z.number().int().min(0).max(90).nullable().optional(), autoRenew: z.boolean().optional() }),
  handler: async (ctx) => {
    const sub = await ctx.db.productSubscription.findUnique({ where: { id: ctx.params.id } });
    if (!sub) throw notFound("Subscription");
    await adjustSubscription(ctx.db, sub.id, ctx.body, ctx.user);
    await ctx.audit("admin.subscription.adjust", { type: "subscription", id: sub.id, tenantId: sub.tenantId }, ctx.body);
    return { ok: true };
  },
});

route({
  method: "GET", path: "/admin/subscriptions/:id/events", tag: "admin", summary: "Subscription history", auth: { platform: "platform.subscription.read", target: "subscription" },
  handler: ({ db, params }) => db.subscriptionEvent.findMany({ where: { subscriptionId: params.id }, orderBy: { createdAt: "desc" } }),
});

// ---------------------------------------------------------------------------
// Manager accounts & employees
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/admin/managers", tag: "admin", summary: "Business manager (owner) accounts", auth: { platform: "platform.users.read" }, query: pageQuery,
  handler: async ({ db, query }) => {
    const users = await db.user.findMany({
      where: {
        kind: "TENANT", isTenantOwner: true,
        ...(query.q ? { OR: [{ username: { contains: query.q, mode: "insensitive" } }, { fullName: { contains: query.q, mode: "insensitive" } }] } : {}),
      },
      include: { tenant: { include: { business: true } }, productAccess: true },
      orderBy: { createdAt: "desc" }, take: 500,
    });
    return users.map((u) => ({
      id: u.id, username: u.username, fullName: u.fullName, phone: u.phone, email: u.email, isActive: u.isActive,
      mustChangePassword: u.mustChangePassword, lastLoginAt: u.lastLoginAt, lockedUntil: u.lockedUntil,
      tenantId: u.tenantId, business: u.tenant?.business?.name, code: u.tenant?.code,
      products: u.productAccess.map((a) => a.productCode),
    }));
  },
});

route({
  method: "GET", path: "/admin/employees", tag: "admin", summary: "Employee accounts across all businesses", auth: { platform: "platform.users.read" },
  query: pageQuery.extend({ product: z.enum(PRODUCT_CODES).optional(), tenantId: z.uuid().optional() }),
  handler: async ({ db, query }) => {
    const where: Prisma.UserWhereInput = {
      kind: "TENANT",
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.product ? { productAccess: { some: { productCode: query.product } } } : {}),
      ...(query.q ? { OR: [{ username: { contains: query.q, mode: "insensitive" } }, { fullName: { contains: query.q, mode: "insensitive" } }] } : {}),
    };
    const [users, total, byRole] = await Promise.all([
      db.user.findMany({
        where, include: { tenant: { include: { business: true } }, productAccess: { include: { role: true } } },
        orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize,
      }),
      db.user.count({ where }),
      db.userProductAccess.groupBy({ by: ["productCode", "roleId"], _count: true, where: { isActive: true } }),
    ]);
    const roles = await db.role.findMany();
    return {
      total,
      summary: byRole.map((r) => ({ product: r.productCode, role: roles.find((x) => x.id === r.roleId)?.name ?? "?", count: r._count })),
      items: users.map((u) => ({
        id: u.id, username: u.username, fullName: u.fullName, isActive: u.isActive, isTenantOwner: u.isTenantOwner,
        lastLoginAt: u.lastLoginAt, business: u.tenant?.business?.name, code: u.tenant?.code, tenantId: u.tenantId,
        access: u.productAccess.map((a) => ({ product: a.productCode, role: a.role.name, isActive: a.isActive })),
      })),
    };
  },
});

route({
  method: "POST", path: "/admin/users/:id/reset-password", tag: "admin", summary: "Issue a new temporary password", auth: { platform: "platform.users.manage", target: "user" },
  handler: async ({ db, params, audit }) => {
    const u = await db.user.findUnique({ where: { id: params.id } });
    if (!u) throw notFound("User");
    if (u.authUserId) {
      // Email accounts never get a temporary password: Supabase emails a reset link.
      await emailPasswordReset(u.email!);
      await db.user.update({ where: { id: u.id }, data: { failedLoginCount: 0, lockedUntil: null } });
      await audit("admin.user.reset_password_email", { type: "user", id: u.id, tenantId: u.tenantId });
      return { username: u.username, emailed: true, email: u.email };
    }
    const password = temporaryPassword();
    await db.user.update({
      where: { id: u.id },
      data: { passwordHash: await hashPassword(password), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
    });
    await revokeUserSessions(db, u.id);
    await audit("admin.user.reset_password", { type: "user", id: u.id, tenantId: u.tenantId });
    return { username: u.username, temporaryPassword: password };
  },
});

route({
  method: "POST", path: "/admin/users/:id/unlock", tag: "admin", summary: "Unlock an account locked by failed sign-ins", auth: { platform: "platform.users.manage", target: "user" },
  handler: async ({ db, params, audit }) => {
    const u = await db.user.update({ where: { id: params.id }, data: { failedLoginCount: 0, lockedUntil: null } });
    await audit("admin.user.unlock", { type: "user", id: u.id, tenantId: u.tenantId });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/admin/users/:id/status", tag: "admin", summary: "Enable or disable any account", auth: { platform: "platform.users.manage", target: "user" },
  body: z.object({ isActive: z.boolean() }),
  handler: async ({ db, params, body, audit, user }) => {
    if (params.id === user.id) throw badRequest("You cannot disable your own account.");
    const u = await db.user.update({ where: { id: params.id }, data: { isActive: body.isActive } });
    if (!body.isActive) await revokeUserSessions(db, u.id);
    await audit(body.isActive ? "admin.user.enable" : "admin.user.disable", { type: "user", id: u.id, tenantId: u.tenantId });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Invoices & payments
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/admin/invoices", tag: "admin", summary: "SAF invoices", auth: { platform: "platform.billing.read" },
  query: pageQuery.extend({ status: z.enum(["ISSUED", "PAID", "VOID"]).optional(), tenantId: z.uuid().optional() }),
  handler: async ({ db, query }) => {
    const where: Prisma.InvoiceWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.q ? { OR: [{ invoiceNo: { contains: query.q, mode: "insensitive" } }, { tenant: { business: { name: { contains: query.q, mode: "insensitive" } } } }] } : {}),
    };
    const [items, total] = await Promise.all([
      db.invoice.findMany({
        where, include: { tenant: { include: { business: true } }, payments: true },
        orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize,
      }),
      db.invoice.count({ where }),
    ]);
    return {
      total,
      items: items.map((i) => ({
        ...i, business: i.tenant.business?.name, code: i.tenant.code, tenant: undefined,
        paidAmount: i.payments.filter((p) => p.status === "SUCCEEDED").reduce((a, b) => a + b.amount, 0), payments: undefined,
      })),
    };
  },
});

route({
  method: "GET", path: "/admin/invoices/:id", tag: "admin", summary: "Invoice detail (printable)", auth: { platform: "platform.billing.read", target: "invoice" },
  handler: async ({ db, params }) => {
    const inv = await db.invoice.findUnique({ where: { id: params.id }, include: { payments: true, tenant: { include: { business: true } } } });
    if (!inv) throw notFound("Invoice");
    return { invoice: inv, platform: await getPlatformSettings(db) };
  },
});

route({
  method: "POST", path: "/admin/invoices", tag: "admin", summary: "Raise a custom invoice", auth: { platform: "platform.billing.manage", target: "bodyTenant" },
  body: z.object({
    tenantId: z.uuid(), productCode: z.enum(PRODUCT_CODES).optional(),
    description: z.string().min(3).max(300), subtotal: z.number().int().min(1),
  }),
  handler: async (ctx) => {
    const inv = await issueInvoice(ctx.db, { ...ctx.body, kind: "OTHER" });
    await ctx.audit("admin.invoice.create", { type: "invoice", id: inv.id, tenantId: inv.tenantId });
    ctx.status = 201;
    return inv;
  },
});

route({
  method: "POST", path: "/admin/invoices/:id/void", tag: "admin", summary: "Void an unpaid invoice", auth: { platform: "platform.billing.manage", target: "invoice" },
  body: z.object({ reason: z.string().max(200).optional() }),
  handler: async ({ db, params, audit, body }) => {
    const inv = await db.invoice.findUnique({ where: { id: params.id } });
    if (!inv) throw notFound("Invoice");
    if (inv.status !== "ISSUED") throw conflict("Only unpaid invoices can be voided.");
    await db.invoice.update({ where: { id: inv.id }, data: { status: "VOID" } });
    await audit("admin.invoice.void", { type: "invoice", id: inv.id, tenantId: inv.tenantId }, { reason: body.reason });
    return { ok: true };
  },
});

route({
  method: "GET", path: "/admin/payments", tag: "admin", summary: "Payment history across businesses", auth: { platform: "platform.billing.read" },
  query: pageQuery.extend({ tenantId: z.uuid().optional(), method: paymentMethodSchema.optional(), from: isoDate.optional(), to: isoDate.optional() }),
  handler: async ({ db, query }) => {
    const where: Prisma.PaymentWhereInput = {
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.method ? { method: query.method } : {}),
      ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: startOfDayIST(query.from) } : {}), ...(query.to ? { lte: endOfDayIST(query.to) } : {}) } } : {}),
      ...(query.q ? { OR: [{ reference: { contains: query.q, mode: "insensitive" } }, { tenant: { business: { name: { contains: query.q, mode: "insensitive" } } } }] } : {}),
    };
    const [items, total, sum] = await Promise.all([
      db.payment.findMany({
        where, include: { tenant: { include: { business: true } }, invoice: true },
        orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize,
      }),
      db.payment.count({ where }),
      db.payment.aggregate({ where: { ...where, status: "SUCCEEDED" }, _sum: { amount: true } }),
    ]);
    return {
      total, collected: sum._sum.amount ?? 0,
      items: items.map((p) => ({
        id: p.id, amount: p.amount, method: p.method, status: p.status, reference: p.reference, paidAt: p.paidAt,
        createdAt: p.createdAt, notes: p.notes, tenantId: p.tenantId, business: p.tenant.business?.name, code: p.tenant.code,
        invoiceNo: p.invoice?.invoiceNo, invoiceKind: p.invoice?.kind, productCode: p.invoice?.productCode,
      })),
    };
  },
});

route({
  method: "POST", path: "/admin/payments", tag: "admin", summary: "Record a manual payment against an invoice", auth: { platform: "platform.billing.manage", target: "bodyInvoice" },
  body: z.object({
    invoiceId: z.uuid(), amount: z.number().int().min(1).optional(), method: paymentMethodSchema,
    reference: z.string().max(100).optional(), notes: z.string().max(300).optional(), paidAt: isoDate.optional(),
  }),
  handler: async (ctx) => {
    const { paidAt, ...rest } = ctx.body;
    const p = await recordPayment(ctx.db, { ...rest, paidAt: paidAt ? startOfDayIST(paidAt) : undefined, recordedById: ctx.user.id }, ctx.user);
    await ctx.audit("admin.payment.record", { type: "payment", id: p.id, tenantId: p.tenantId }, { amount: p.amount, method: p.method });
    ctx.status = 201;
    return p;
  },
});

// ---------------------------------------------------------------------------
// Revenue analytics
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/admin/analytics/revenue", tag: "admin", summary: "Revenue analytics (paid invoices, excl. GST)", auth: { platform: "platform.revenue.read" },
  query: z.object({ months: z.coerce.number().int().min(3).max(36).default(12) }),
  handler: async ({ db, query }) => {
    const today = todayIST();
    const firstMonth = addMonths(`${today.slice(0, 7)}-01`, -(query.months - 1));
    const [paid, subs, methods] = await Promise.all([
      db.invoice.findMany({ where: { status: "PAID", paidAt: { gte: startOfDayIST(firstMonth) } }, select: { subtotal: true, kind: true, billingCycle: true, productCode: true, paidAt: true } }),
      db.productSubscription.findMany({ include: { plan: true, tenant: { select: { status: true } } } }),
      db.payment.groupBy({ by: ["method"], _sum: { amount: true }, where: { status: "SUCCEEDED", createdAt: { gte: startOfDayIST(firstMonth) } } }),
    ]);
    const months = Array.from({ length: query.months }, (_, i) => addMonths(firstMonth, i).slice(0, 7));
    const series = months.map((m) => ({ month: m, setup: 0, monthly: 0, annual: 0, other: 0, total: 0 }));
    const byProduct: Record<string, number> = { dine: 0, stay: 0, bill: 0 };
    for (const inv of paid) {
      const m = istDate(inv.paidAt!).slice(0, 7);
      const row = series.find((s) => s.month === m);
      if (!row) continue;
      const bucket = inv.kind === "SETUP" ? "setup" : inv.kind === "SUBSCRIPTION" ? (inv.billingCycle === "ANNUAL" ? "annual" : "monthly") : "other";
      row[bucket] += inv.subtotal;
      row.total += inv.subtotal;
      if (inv.productCode) byProduct[inv.productCode] += inv.subtotal;
    }
    const active = subs.filter((s) => isUsable(summarize({ ...s, pendingPlan: null }).state) && s.tenant.status === "ACTIVE");
    const mrrRows = PRODUCT_CODES.flatMap((p) => (["BASIC", "GROWTH"] as const).map((tier) => {
      const list = active.filter((s) => s.productCode === p && s.plan.tier === tier);
      return {
        product: p, tier, subscriptions: list.length,
        mrr: list.reduce((a, s) => a + (s.billingCycle === "MONTHLY" ? s.plan.monthlyPrice : Math.round(s.plan.annualPrice / 12)), 0),
      };
    }));
    return {
      series, byProduct, mrr: mrrRows, totalMrr: mrrRows.reduce((a, r) => a + r.mrr, 0),
      collectionsByMethod: methods.map((m) => ({ method: m.method, amount: m._sum.amount ?? 0 })),
      totals: series.reduce((a, s) => ({ setup: a.setup + s.setup, monthly: a.monthly + s.monthly, annual: a.annual + s.annual, other: a.other + s.other, total: a.total + s.total }), { setup: 0, monthly: 0, annual: 0, other: 0, total: 0 }),
    };
  },
});

// ---------------------------------------------------------------------------
// Support, audit, settings, jobs
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/admin/support/tickets", tag: "admin", summary: "Support tickets from all businesses", auth: { platform: "platform.support.read" },
  query: z.object({ status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional() }),
  handler: async ({ db, query }) => {
    const items = await db.supportTicket.findMany({
      where: query.status ? { status: query.status } : {},
      include: { tenant: { include: { business: true } }, _count: { select: { messages: true } } },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }], take: 300,
    });
    return items.map((t) => ({ ...t, business: t.tenant.business?.name, code: t.tenant.code, tenant: undefined, messages: t._count.messages }));
  },
});

route({
  method: "GET", path: "/admin/support/tickets/:id", tag: "admin", summary: "Support ticket thread", auth: { platform: "platform.support.read", target: "ticket" },
  handler: async ({ db, params }) => {
    const t = await db.supportTicket.findUnique({
      where: { id: params.id },
      include: { messages: { orderBy: { createdAt: "asc" } }, tenant: { include: { business: true } } },
    });
    if (!t) throw notFound("Ticket");
    return t;
  },
});

route({
  method: "POST", path: "/admin/support/tickets/:id/messages", tag: "admin", summary: "Reply to a support ticket", auth: { platform: "platform.support.manage", target: "ticket" },
  body: z.object({ body: z.string().trim().min(1).max(4000) }),
  handler: async ({ db, params, body, user }) => {
    const t = await db.supportTicket.findUnique({ where: { id: params.id } });
    if (!t) throw notFound("Ticket");
    const m = await db.supportMessage.create({
      data: { tenantId: t.tenantId, ticketId: t.id, authorId: user.id, authorName: "SAF Support", fromSaf: true, body: body.body },
    });
    await db.supportTicket.update({ where: { id: t.id }, data: { status: t.status === "OPEN" ? "IN_PROGRESS" : t.status } });
    await notify(db, {
      tenantId: t.tenantId, userId: t.createdById, productCode: t.productCode, kind: "SUPPORT_REPLY",
      title: `Reply on ticket #${t.ticketNo}`, body: body.body.slice(0, 140), link: t.productCode ? `/${t.productCode}/support` : undefined,
    });
    return m;
  },
});

route({
  method: "PATCH", path: "/admin/support/tickets/:id", tag: "admin", summary: "Change ticket status / priority", auth: { platform: "platform.support.manage", target: "ticket" },
  body: z.object({ status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(), priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional() }),
  handler: ({ db, params, body }) => db.supportTicket.update({ where: { id: params.id }, data: body }),
});

route({
  method: "GET", path: "/admin/audit-logs", tag: "admin", summary: "Audit trail (filterable)", auth: { platform: "platform.audit.read" },
  query: pageQuery.extend({ tenantId: z.uuid().optional(), action: z.string().max(80).optional(), from: isoDate.optional(), to: isoDate.optional() }),
  handler: async ({ db, query }) => {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.action ? { action: { contains: query.action, mode: "insensitive" } } : {}),
      ...(query.q ? { OR: [{ actorName: { contains: query.q, mode: "insensitive" } }, { entityId: { contains: query.q } }] } : {}),
      ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: startOfDayIST(query.from) } : {}), ...(query.to ? { lte: endOfDayIST(query.to) } : {}) } } : {}),
    };
    const [items, total] = await Promise.all([
      db.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { tenant: { select: { code: true } } } }),
      db.auditLog.count({ where }),
    ]);
    return { items: items.map((a) => ({ ...a, tenantCode: a.tenant?.code ?? null, tenant: undefined })), total };
  },
});

route({
  method: "GET", path: "/admin/settings", tag: "admin", summary: "Global platform settings and integration status", auth: { platform: "platform.settings.read" },
  handler: async ({ db }) => ({
    settings: await getPlatformSettings(db),
    integrations: {
      razorpay: isRazorpayConfigured(),
      storage: process.env.STORAGE_DRIVER === "s3" ? "S3-compatible" : "Local disk",
      appUrl: process.env.APP_URL || "",
      cronConfigured: !!process.env.CRON_SECRET && process.env.CRON_SECRET !== "change-me",
    },
  }),
});

route({
  method: "PUT", path: "/admin/settings", tag: "admin", summary: "Update global platform settings", auth: { platform: "platform.settings.manage" },
  body: platformSettingsSchema.partial(),
  handler: async ({ db, body, audit }) => {
    const s = await savePlatformSettings(db, body);
    await audit("admin.settings.update", { type: "settings", id: "general" }, { fields: Object.keys(body) });
    return s;
  },
});

route({
  method: "POST", path: "/admin/jobs/renewals", tag: "admin", summary: "Run the renewal job now (expiry, invoices, reminders)", auth: { platform: "platform.jobs.run" },
  handler: async ({ db }) => runRenewalJob(db),
});

// Utility for the Add Business form: default dates
route({
  method: "GET", path: "/admin/defaults", tag: "admin", summary: "Defaults for onboarding forms (today, plan prices)", auth: { platform: "platform.dashboard.read" },
  handler: async ({ db }) => ({ today: todayIST(), tomorrow: addDays(todayIST(), 1), plans: await db.plan.findMany({ orderBy: [{ productCode: "asc" }, { tier: "asc" }] }) }),
});
