import { z } from "zod";
import { PRODUCTS, isProductCode } from "@/config/catalog";
import { route } from "../http/router";
import { HttpError, badRequest, notFound } from "../http/errors";
import { withPlatform, withTenant, type Tx } from "../db";
import { burnPasswordCheck, hashPassword, passwordPolicyError, verifyPassword } from "../auth/password";
import { createSession, revokeSession, revokeUserSessions, sessionCookie, type SessionUser } from "../auth/session";
import { rateLimit } from "../auth/ratelimit";
import { normalizeUsername } from "../core/ids";
import { writeAudit } from "../core/audit";
import { loadPortal, loadProductAccess, type ProductAccess } from "../core/access";
import { getProductSettings } from "../core/settings";
import { fileUrl } from "../core/storage";

const loginBody = z.object({
  username: z.string().trim().min(3).max(80),
  password: z.string().min(1).max(200),
});

type LoginOutcome =
  | { ok: true; token: string; expiresAt: Date; user: { id: string; username: string; fullName: string; kind: string; mustChangePassword: boolean } }
  | { ok: false; error: HttpError };

const invalid = () => new HttpError(401, "INVALID_CREDENTIALS", "Incorrect login ID or password.");

route({
  method: "POST", path: "/auth/login", tag: "auth", summary: "Sign in with login ID and password",
  auth: { public: true }, body: loginBody, rateLimit: { limit: 20, windowMs: 60_000 },
  handler: async (ctx) => {
    const username = normalizeUsername(ctx.body.username);
    const perAccount = rateLimit(`login:${username}`, 15, 15 * 60_000);
    if (!perAccount.ok) throw new HttpError(429, "RATE_LIMITED", "Too many sign-in attempts for this account. Please wait.");

    const maxFailures = Number(process.env.LOGIN_MAX_FAILURES || 5);
    const lockMinutes = Number(process.env.LOGIN_LOCK_MINUTES || 15);
    const meta = { ip: ctx.ip, userAgent: ctx.userAgent };

    // Failures are committed before the error is returned (no rollback on throw).
    const outcome = await withPlatform<LoginOutcome>(async (db) => {
      const user = await db.user.findUnique({ where: { username } });
      if (!user) {
        await burnPasswordCheck(ctx.body.password);
        await writeAudit(db, { action: "auth.login_failed", ...meta, meta: { username, reason: "unknown_user" } });
        return { ok: false, error: invalid() };
      }
      const now = new Date();
      if (user.lockedUntil && user.lockedUntil > now) {
        const mins = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60_000);
        return { ok: false, error: new HttpError(423, "ACCOUNT_LOCKED", `Account locked after repeated failed attempts. Try again in ${mins} minute(s).`) };
      }
      if (!(await verifyPassword(user.passwordHash, ctx.body.password))) {
        const failures = user.failedLoginCount + 1;
        const lock = failures >= maxFailures;
        await db.user.update({
          where: { id: user.id },
          data: lock
            ? { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + lockMinutes * 60_000) }
            : { failedLoginCount: failures },
        });
        await writeAudit(db, {
          tenantId: user.tenantId, actor: user, action: lock ? "auth.account_locked" : "auth.login_failed", ...meta,
          meta: { failures },
        });
        return { ok: false, error: invalid() };
      }
      if (!user.isActive) {
        await writeAudit(db, { tenantId: user.tenantId, actor: user, action: "auth.login_disabled", ...meta });
        return { ok: false, error: new HttpError(403, "ACCOUNT_DISABLED", "This account has been disabled. Contact your manager.") };
      }
      const session = await createSession(db, user.id, user.tenantId, meta);
      await db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } });
      await writeAudit(db, { tenantId: user.tenantId, actor: user, action: "auth.login", ...meta });
      return {
        ok: true, token: session.token, expiresAt: session.expiresAt,
        user: { id: user.id, username: user.username, fullName: user.fullName, kind: user.kind, mustChangePassword: user.mustChangePassword },
      };
    });

    if (!outcome.ok) throw outcome.error;
    ctx.headers.append("set-cookie", sessionCookie(outcome.token, Math.floor((outcome.expiresAt.getTime() - Date.now()) / 1000)));
    const u = outcome.user;
    return {
      user: u,
      mustChangePassword: u.mustChangePassword,
      redirect: u.mustChangePassword ? "/change-password" : u.kind === "PLATFORM" ? "/admin" : "/",
    };
  },
});

route({
  method: "POST", path: "/auth/logout", tag: "auth", summary: "Sign out (revokes the session)",
  auth: { session: true, allowPasswordChange: true },
  handler: async (ctx) => {
    await withPlatform(async (db) => {
      await revokeSession(db, ctx.session!.id);
      await writeAudit(db, { tenantId: ctx.user.tenantId, actor: ctx.user, action: "auth.logout", ip: ctx.ip });
    });
    ctx.headers.append("set-cookie", sessionCookie("", 0));
    return { ok: true };
  },
});

route({
  method: "POST", path: "/auth/change-password", tag: "auth",
  summary: "Change own password (required after first login with a temporary password)",
  auth: { session: true, allowPasswordChange: true },
  body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) }),
  rateLimit: { limit: 10, windowMs: 60_000 },
  handler: async (ctx) => {
    const { currentPassword, newPassword } = ctx.body;
    const policy = passwordPolicyError(newPassword, ctx.user.username);
    if (policy) throw badRequest(policy);
    if (currentPassword === newPassword) throw badRequest("New password must be different from the current one.");
    await withPlatform(async (db) => {
      const user = await db.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
      if (!(await verifyPassword(user.passwordHash, currentPassword)))
        throw new HttpError(400, "WRONG_PASSWORD", "Current password is incorrect.");
      await db.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false, passwordChangedAt: new Date() },
      });
      await revokeUserSessions(db, user.id, ctx.session!.id);
      await writeAudit(db, { tenantId: user.tenantId, actor: user, action: "auth.password_changed", ip: ctx.ip });
    });
    return { ok: true, redirect: ctx.user.kind === "PLATFORM" ? "/admin" : "/" };
  },
});

// ---------------------------------------------------------------------------
// Identity, portal and product context
// ---------------------------------------------------------------------------

export async function tenantHeader(db: Tx, tenantId: string) {
  const t = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { business: true } });
  return {
    id: t.id, code: t.code, status: t.status, name: t.business?.name ?? t.code,
    category: t.business?.category ?? null, logoUrl: fileUrl(t.business?.logoKey),
    phone: t.business?.phone ?? null, email: t.business?.email ?? null, address: t.business?.address ?? null,
  };
}

export async function meData(user: SessionUser) {
  const base = {
    user: {
      id: user.id, username: user.username, fullName: user.fullName, kind: user.kind,
      isTenantOwner: user.isTenantOwner, mustChangePassword: user.mustChangePassword,
    },
  };
  if (user.kind === "PLATFORM" || !user.tenantId) return { ...base, tenant: null, products: null };
  return withTenant(user.tenantId, async (db) => ({
    ...base,
    tenant: await tenantHeader(db, user.tenantId!),
    products: await loadPortal(db, user),
  }));
}

route({
  method: "GET", path: "/me", tag: "auth", summary: "Current user, business and subscribed SAF products",
  auth: { session: true, allowPasswordChange: true },
  handler: (ctx) => meData(ctx.user),
});

export async function productContext(db: Tx, user: SessionUser, access: ProductAccess) {
  const p = PRODUCTS[access.product];
  return {
    product: { code: p.code, name: p.name, shortName: p.shortName, tagline: p.tagline },
    tenant: await tenantHeader(db, user.tenantId!),
    user: { id: user.id, username: user.username, fullName: user.fullName, isTenantOwner: user.isTenantOwner },
    role: access.role,
    subscription: access.subscription,
    features: access.features,
    permissions: access.permissions,
    branches: access.branches,
    multiBranch: access.features.includes(`${access.product}.multi_branch`),
    settings: await getProductSettings(db, user.tenantId!, access.product),
  };
}

route({
  method: "GET", path: "/me/products/:product", tag: "auth",
  summary: "Product context: subscription, plan entitlements, role permissions, branches",
  auth: { product: ":product", allowInactive: true },
  handler: (ctx) => productContext(ctx.db, ctx.user, ctx.access),
});

route({
  method: "GET", path: "/me/notifications", tag: "auth", summary: "In-app notifications for the current user",
  auth: { session: true },
  handler: async (ctx) => {
    if (!ctx.user.tenantId) return { items: [], unread: 0 };
    return withTenant(ctx.user.tenantId, async (db) => {
      const where = { tenantId: ctx.user.tenantId!, OR: [{ userId: null }, { userId: ctx.user.id }] };
      // Renewal and billing notices are only relevant to managers.
      const visible = ctx.user.isTenantOwner ? where : { ...where, kind: { notIn: ["RENEWAL_REMINDER", "SUBSCRIPTION_EXPIRED"] } };
      const [items, unread] = await Promise.all([
        db.notification.findMany({ where: visible, orderBy: { createdAt: "desc" }, take: 30 }),
        db.notification.count({ where: { ...visible, readAt: null } }),
      ]);
      return { items, unread };
    });
  },
});

route({
  method: "POST", path: "/me/notifications/read-all", tag: "auth", summary: "Mark all notifications read",
  auth: { session: true }, audit: false,
  handler: async (ctx) => {
    if (!ctx.user.tenantId) return { ok: true };
    await withTenant(ctx.user.tenantId, (db) =>
      db.notification.updateMany({
        where: { tenantId: ctx.user.tenantId!, readAt: null, OR: [{ userId: null }, { userId: ctx.user.id }] },
        data: { readAt: new Date() },
      }),
    );
    return { ok: true };
  },
});

export async function requireProductParam(product: string) {
  if (!isProductCode(product)) throw notFound("Product");
  return product;
}
