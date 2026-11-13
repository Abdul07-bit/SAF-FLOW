import type { BillingCycle, PlanTier, SubscriptionStatus, TenantStatus } from "@prisma/client";
import { PRODUCT_CODES, PRODUCTS, type ProductCode } from "@/config/catalog";
import type { Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { forbidden, HttpError } from "../http/errors";

export type SubState = "ACTIVE" | "GRACE" | "EXPIRED" | "SUSPENDED" | "CANCELLED" | "PENDING";

export interface SubscriptionSummary {
  id: string;
  planId: string;
  tier: PlanTier;
  planName: string;
  billingCycle: BillingCycle;
  status: SubscriptionStatus;
  state: SubState;
  startDate: string;
  currentPeriodEnd: string;
  graceEndsAt: string;
  daysLeft: number;
  pendingTier: PlanTier | null;
  pendingBillingCycle: BillingCycle | null;
}

interface SubLike {
  status: SubscriptionStatus;
  startDate: Date;
  currentPeriodEnd: Date;
  graceDays: number | null;
}

/** Effective state is always derived from dates, so access never depends on a job having run. */
export function subscriptionState(sub: SubLike, planGraceDays: number, now = new Date()) {
  const graceDays = sub.graceDays ?? planGraceDays;
  const graceEndsAt = new Date(sub.currentPeriodEnd.getTime() + graceDays * 86_400_000);
  const daysLeft = Math.ceil((sub.currentPeriodEnd.getTime() - now.getTime()) / 86_400_000);
  let state: SubState;
  if (sub.status === "SUSPENDED") state = "SUSPENDED";
  else if (sub.status === "CANCELLED") state = "CANCELLED";
  else if (now < sub.startDate) state = "PENDING";
  else if (now <= sub.currentPeriodEnd) state = "ACTIVE";
  else if (now <= graceEndsAt) state = "GRACE";
  else state = "EXPIRED";
  return { state, graceEndsAt, daysLeft };
}

export function isUsable(state: SubState) {
  return state === "ACTIVE" || state === "GRACE";
}

type SubWithPlans = SubLike & {
  id: string;
  planId: string;
  billingCycle: BillingCycle;
  pendingBillingCycle: BillingCycle | null;
  plan: { tier: PlanTier; name: string; graceDays: number };
  pendingPlan: { tier: PlanTier } | null;
};

export function summarize(sub: SubWithPlans, now = new Date()): SubscriptionSummary {
  const s = subscriptionState(sub, sub.plan.graceDays, now);
  return {
    id: sub.id,
    planId: sub.planId,
    tier: sub.plan.tier,
    planName: sub.plan.name,
    billingCycle: sub.billingCycle,
    status: sub.status,
    state: s.state,
    startDate: sub.startDate.toISOString(),
    currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
    graceEndsAt: s.graceEndsAt.toISOString(),
    daysLeft: s.daysLeft,
    pendingTier: sub.pendingPlan?.tier ?? null,
    pendingBillingCycle: sub.pendingBillingCycle,
  };
}

export interface ProductAccess {
  product: ProductCode;
  productActive: boolean;
  tenantStatus: TenantStatus | null;
  subscription: SubscriptionSummary | null;
  /** Fully qualified feature keys the tenant is entitled to for this product. */
  features: string[];
  role: { id: string; code: string; name: string; homeScreen: string } | null;
  /** Fully qualified permission keys of the user's role in this product. */
  permissions: string[];
  branches: { id: string; name: string; code: string; isMain: boolean }[];
  /** true when the user may only use the branches listed above. */
  branchRestricted: boolean;
}

/**
 * Loads everything needed to authorise a request for one product.
 * Must run inside withTenant() for the user's tenant.
 */
export async function loadProductAccess(db: Tx, user: SessionUser, product: ProductCode): Promise<ProductAccess> {
  const tenantId = user.tenantId!;
  const [productRow, sub, overrides, upa, allBranches, branchLimits] = await Promise.all([
    db.product.findUnique({ where: { code: product }, select: { isActive: true } }),
    db.productSubscription.findUnique({
      where: { tenantId_productCode: { tenantId, productCode: product } },
      include: { plan: { include: { features: { select: { featureKey: true } } } }, pendingPlan: { select: { tier: true } } },
    }),
    db.tenantFeature.findMany({ where: { tenantId, featureKey: { startsWith: `${product}.` } } }),
    db.userProductAccess.findUnique({
      where: { userId_productCode: { userId: user.id, productCode: product } },
      include: { role: { include: { permissions: { select: { permissionKey: true } } } } },
    }),
    db.branch.findMany({
      where: { tenantId, isActive: true },
      orderBy: [{ isMain: "desc" }, { name: "asc" }],
      select: { id: true, name: true, code: true, isMain: true },
    }),
    db.userBranchAccess.findMany({ where: { userId: user.id }, select: { branchId: true } }),
  ]);
  // Branch restriction: owners see every branch; other staff with explicit
  // branch grants see only those (no grants = every branch).
  const allowed = new Set(branchLimits.map((b) => b.branchId));
  const branches = user.isTenantOwner || allowed.size === 0 ? allBranches : allBranches.filter((b) => allowed.has(b.id));
  const branchRestricted = !user.isTenantOwner && allowed.size > 0;

  let features: string[] = [];
  if (sub) {
    const set = new Set(sub.plan.features.map((f) => f.featureKey));
    for (const o of overrides) {
      if (o.enabled) set.add(o.featureKey);
      else set.delete(o.featureKey);
    }
    features = [...set].sort();
  }

  const role = upa && upa.isActive ? upa.role : null;
  return {
    product,
    productActive: productRow?.isActive ?? false,
    tenantStatus: user.tenantStatus,
    subscription: sub ? summarize(sub) : null,
    features,
    role: role ? { id: role.id, code: role.code, name: role.name, homeScreen: role.homeScreen } : null,
    permissions: role ? role.permissions.map((p) => p.permissionKey).sort() : [],
    branches,
    branchRestricted,
  };
}

/**
 * Steps 4-7 of the authorisation chain. Throws a typed HttpError the UI can
 * act on (e.g. show the renewal page for SUBSCRIPTION_EXPIRED).
 */
export function assertProductUsable(access: ProductAccess, opts: { allowInactive?: boolean } = {}) {
  const name = PRODUCTS[access.product].name;
  if (access.tenantStatus !== "ACTIVE")
    throw forbidden("TENANT_SUSPENDED", "This business account is suspended. Please contact SmartAutoFlex support.");
  if (!access.productActive) throw forbidden("PRODUCT_DISABLED", `${name} is temporarily unavailable.`);
  if (!access.subscription)
    throw forbidden("PRODUCT_NOT_SUBSCRIBED", `Your business has not subscribed to ${name}.`, { product: access.product });
  if (!access.role) throw forbidden("PRODUCT_ACCESS_DENIED", `Your account does not have access to ${name}.`);
  if (opts.allowInactive) return;
  const st = access.subscription.state;
  if (st === "EXPIRED")
    throw new HttpError(402, "SUBSCRIPTION_EXPIRED", `Your ${name} subscription has expired. Please renew to continue.`);
  if (st === "SUSPENDED" || st === "CANCELLED")
    throw forbidden("SUBSCRIPTION_SUSPENDED", `Your ${name} subscription is ${st.toLowerCase()}.`);
  if (st === "PENDING") throw forbidden("SUBSCRIPTION_NOT_STARTED", `Your ${name} subscription has not started yet.`);
}

export function qualify(product: ProductCode, keys: string | readonly string[] | undefined): string[] {
  if (!keys) return [];
  return (typeof keys === "string" ? [keys] : [...keys]).map((k) => (k.startsWith(`${product}.`) ? k : `${product}.${k}`));
}

export function hasAny(have: string[], need: string[]): boolean {
  return need.length === 0 || need.some((k) => have.includes(k));
}

export function assertFeature(access: ProductAccess, keys: string | readonly string[] | undefined) {
  const need = qualify(access.product, keys);
  if (hasAny(access.features, need)) return;
  throw forbidden(
    "FEATURE_NOT_IN_PLAN",
    `This feature is not included in your ${PRODUCTS[access.product].shortName} ${access.subscription?.tier === "BASIC" ? "Basic" : "current"} plan.`,
    { features: need, currentTier: access.subscription?.tier ?? null },
  );
}

export function assertPermission(access: ProductAccess, keys: string | readonly string[] | undefined) {
  const need = qualify(access.product, keys);
  if (hasAny(access.permissions, need)) return;
  throw forbidden("PERMISSION_DENIED", "Your role does not allow this action.", { permissions: need });
}

/** Portal view: every SAF product with the tenant's subscription and the user's role. */
export async function loadPortal(db: Tx, user: SessionUser) {
  const tenantId = user.tenantId!;
  const [products, subs, access] = await Promise.all([
    db.product.findMany({ orderBy: { sortOrder: "asc" } }),
    db.productSubscription.findMany({
      where: { tenantId },
      include: { plan: { select: { tier: true, name: true, graceDays: true } }, pendingPlan: { select: { tier: true } } },
    }),
    db.userProductAccess.findMany({ where: { userId: user.id, isActive: true }, include: { role: true } }),
  ]);
  return PRODUCT_CODES.map((code) => {
    const p = products.find((x) => x.code === code);
    const sub = subs.find((s) => s.productCode === code);
    const a = access.find((x) => x.productCode === code);
    return {
      code,
      name: p?.name ?? PRODUCTS[code].name,
      tagline: p?.tagline ?? PRODUCTS[code].tagline,
      productActive: p?.isActive ?? false,
      subscription: sub ? summarize(sub) : null,
      role: a ? { code: a.role.code, name: a.role.name, homeScreen: a.role.homeScreen } : null,
    };
  });
}

/**
 * Entitlement check without a user (public QR menu / ordering / invoices).
 * True when the tenant is active, the product is enabled, the subscription is
 * usable and the plan (plus overrides) includes the feature.
 */
export async function tenantEntitled(db: Tx, tenantId: string, product: ProductCode, featureKey: string): Promise<boolean> {
  const key = featureKey.startsWith(`${product}.`) ? featureKey : `${product}.${featureKey}`;
  const [tenant, productRow, sub, override] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId }, select: { status: true } }),
    db.product.findUnique({ where: { code: product }, select: { isActive: true } }),
    db.productSubscription.findUnique({
      where: { tenantId_productCode: { tenantId, productCode: product } },
      include: { plan: { include: { features: { where: { featureKey: key } } } } },
    }),
    db.tenantFeature.findUnique({ where: { tenantId_featureKey: { tenantId, featureKey: key } } }),
  ]);
  if (tenant?.status !== "ACTIVE" || !productRow?.isActive || !sub) return false;
  if (!isUsable(subscriptionState(sub, sub.plan.graceDays).state)) return false;
  return override ? override.enabled : sub.plan.features.length > 0;
}
