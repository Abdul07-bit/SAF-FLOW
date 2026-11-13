import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { PRODUCTS, isProductCode } from "@/config/catalog";
import { route } from "../http/router";
import { HttpError, badRequest, notFound } from "../http/errors";
import { withPlatform, withTenant, type Tx } from "../db";
import { burnPasswordCheck, hashPassword, passwordPolicyError, verifyPassword } from "../auth/password";
import { createSession, revokeSession, revokeUserSessions, sessionCookie, type SessionUser } from "../auth/session";
import { rateLimit } from "../auth/ratelimit";
import { authCallbackUrl, identity, IdentityError, identityToHttp, looksLikeEmail } from "../auth/identity";
import { normalizeUsername } from "../core/ids";
import { writeAudit } from "../core/audit";
import { loadPortal, loadProductAccess, type ProductAccess } from "../core/access";
import { getProductSettings } from "../core/settings";
import { fileUrl } from "../core/storage";
import { mfaRequiredFor } from "../auth/mfa";

const loginBody = z.object({
  username: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(200),
});

type LoginOutcome =
  | { ok: true; token: string; expiresAt: Date; mfaPending: boolean; user: { id: string; username: string; fullName: string; kind: string; mustChangePassword: boolean } }
  | { ok: false; error: HttpError };

// One answer for unknown accounts, wrong passwords, locked accounts and pending
// invitations, so the sign-in form cannot be used to discover accounts.
const invalid = () =>
  new HttpError(401, "INVALID_CREDENTIALS", "Incorrect email / login ID or password. After repeated failures an account is locked for a few minutes.");

// ---------------------------------------------------------------------------
// Sign-in
//
// Two kinds of account share one login form:
//  - email accounts (owners, managers, SAF Team): password checked by
//    Supabase Auth; users.auth_user_id links the identity.
//  - login-ID accounts (CODE@name, floor staff): local argon2 password.
// Either way SAF issues its own httpOnly session; lockout, suspension and
// audit are enforced here for both.
// ---------------------------------------------------------------------------

type Account = Prisma.UserGetPayload<{ include: { invitations: { where: { status: "PENDING" } } } }>;

async function findAccount(db: Tx, raw: string): Promise<Account | null> {
  const include = { invitations: { where: { status: "PENDING" as const } } };
  if (looksLikeEmail(raw)) {
    const byEmail = await db.user.findFirst({
      where: { authUserId: { not: null }, email: { equals: raw.trim(), mode: "insensitive" } }, include,
    });
    if (byEmail) return byEmail;
  }
  return db.user.findUnique({ where: { username: normalizeUsername(raw) }, include });
}

function accountKey(raw: string) {
  return looksLikeEmail(raw) ? raw.trim().toLowerCase() : normalizeUsername(raw);
}

route({
  method: "POST", path: "/auth/login", tag: "auth", summary: "Sign in with email or login ID and password",
  auth: { public: true }, body: loginBody, rateLimit: { limit: 20, windowMs: 60_000 },
  handler: async (ctx) => {
    const raw = ctx.body.username.trim();
    const perAccount = rateLimit(`login:${accountKey(raw)}`, 15, 15 * 60_000);
    if (!perAccount.ok) throw new HttpError(429, "RATE_LIMITED", "Too many sign-in attempts for this account. Please wait.");

    const maxFailures = Number(process.env.LOGIN_MAX_FAILURES || 5);
    const lockMinutes = Number(process.env.LOGIN_LOCK_MINUTES || 15);
    const meta = { ip: ctx.ip, userAgent: ctx.userAgent };

    // 1. Resolve the account and refuse locked ones before any password check.
    const user = await withPlatform(async (db) => {
      const u = await findAccount(db, raw);
      if (!u) await writeAudit(db, { action: "auth.login_failed", ...meta, meta: { username: accountKey(raw), reason: "unknown_user" } });
      return u;
    });
    if (!user) {
      await burnPasswordCheck(ctx.body.password);
      throw invalid();
    }
    const now = new Date();
    if (user.lockedUntil && user.lockedUntil > now) {
      await burnPasswordCheck(ctx.body.password);
      await withPlatform((db) => writeAudit(db, { tenantId: user.tenantId, actor: user, action: "auth.login_blocked_locked", ...meta }));
      throw invalid();
    }
    if (user.authUserId && user.invitations.length && !user.isActive) {
      await burnPasswordCheck(ctx.body.password);
      throw invalid();
    }

    // 2. Verify the credential (outside any transaction: may call Supabase).
    let ok = false;
    if (user.authUserId) {
      const r = await identity().signInWithPassword(user.email!, ctx.body.password).catch((e) => {
        if (e instanceof IdentityError) throw new HttpError(e.status, e.code, e.message);
        throw e;
      });
      ok = !!r && r.user.id === user.authUserId;
    } else if (user.passwordHash) {
      ok = await verifyPassword(user.passwordHash, ctx.body.password);
    } else {
      await burnPasswordCheck(ctx.body.password);
    }

    // 3. Record the outcome.
    const outcome = await withPlatform<LoginOutcome>(async (db) => {
      if (!ok) {
        const fresh = await db.user.findUniqueOrThrow({ where: { id: user.id } });
        const failures = fresh.failedLoginCount + 1;
        const lock = failures >= maxFailures;
        await db.user.update({
          where: { id: user.id },
          data: lock ? { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + lockMinutes * 60_000) } : { failedLoginCount: failures },
        });
        await writeAudit(db, {
          tenantId: user.tenantId, actor: user, action: lock ? "auth.account_locked" : "auth.login_failed", ...meta, meta: { failures },
        });
        return { ok: false, error: invalid() };
      }
      if (!user.isActive) {
        await writeAudit(db, { tenantId: user.tenantId, actor: user, action: "auth.login_disabled", ...meta });
        return { ok: false, error: new HttpError(403, "ACCOUNT_DISABLED", "This account has been disabled. Contact your administrator.") };
      }
      // With MFA on, the password only opens a short "MFA pending" session that
      // can do nothing but POST /auth/mfa/verify.
      const mfaPending = !!user.mfaEnabledAt;
      const session = await createSession(db, user.id, user.tenantId, meta, { mfaPending });
      await db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, ...(mfaPending ? {} : { lastLoginAt: now }) } });
      const knownDevice = await db.session.count({
        where: { userId: user.id, id: { not: session.id }, userAgent: meta.userAgent?.slice(0, 300) ?? null, createdAt: { gt: new Date(now.getTime() - 90 * 86_400_000) } },
      });
      await writeAudit(db, {
        tenantId: user.tenantId, actor: user, action: mfaPending ? "auth.login_password_ok_mfa_pending" : "auth.login", ...meta,
        meta: { method: user.authUserId ? "email" : "login_id", newDevice: knownDevice === 0 },
      });
      return {
        ok: true, token: session.token, expiresAt: session.expiresAt, mfaPending,
        user: { id: user.id, username: user.username, fullName: user.fullName, kind: user.kind, mustChangePassword: user.mustChangePassword },
      };
    });

    if (!outcome.ok) throw outcome.error;
    ctx.headers.append("set-cookie", sessionCookie(outcome.token, Math.floor((outcome.expiresAt.getTime() - Date.now()) / 1000)));
    const u = outcome.user;
    if (outcome.mfaPending) return { mfaRequired: true, redirect: "/mfa" };
    return {
      user: u,
      mustChangePassword: u.mustChangePassword,
      redirect: u.mustChangePassword ? "/change-password" : u.kind === "PLATFORM" ? "/admin" : "/",
    };
  },
});

route({
  method: "POST", path: "/auth/logout", tag: "auth", summary: "Sign out (revokes the session)",
  auth: { session: true, allowPasswordChange: true, allowMfaEnrollment: true, allowMfaPending: true },
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
  method: "POST", path: "/auth/logout-all", tag: "auth", summary: "Sign out of every device (revokes all sessions)",
  auth: { session: true, allowPasswordChange: true, allowMfaEnrollment: true },
  handler: async (ctx) => {
    await withPlatform(async (db) => {
      await revokeUserSessions(db, ctx.user.id);
      await writeAudit(db, { tenantId: ctx.user.tenantId, actor: ctx.user, action: "auth.logout_all", ip: ctx.ip });
    });
    ctx.headers.append("set-cookie", sessionCookie("", 0));
    return { ok: true };
  },
});

route({
  method: "POST", path: "/auth/change-password", tag: "auth",
  summary: "Change own password (required after first login with a temporary password)",
  auth: { session: true, allowPasswordChange: true, allowMfaEnrollment: true },
  body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) }),
  rateLimit: { limit: 10, windowMs: 60_000 },
  handler: async (ctx) => {
    const { currentPassword, newPassword } = ctx.body;
    const user = await withPlatform((db) => db.user.findUniqueOrThrow({ where: { id: ctx.user.id } }));
    const policy = passwordPolicyError(newPassword, user.authUserId ? undefined : ctx.user.username);
    if (policy) throw badRequest(policy);
    if (currentPassword === newPassword) throw badRequest("New password must be different from the current one.");

    if (user.authUserId) {
      const signedIn = await identity().signInWithPassword(user.email!, currentPassword).catch(asHttp);
      if (!signedIn || signedIn.user.id !== user.authUserId) throw new HttpError(400, "WRONG_PASSWORD", "Current password is incorrect.");
      await identity().updatePassword(signedIn.accessToken, newPassword).catch(asHttp);
    } else if (!user.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new HttpError(400, "WRONG_PASSWORD", "Current password is incorrect.");
    }

    await withPlatform(async (db) => {
      await db.user.update({
        where: { id: user.id },
        data: {
          ...(user.authUserId ? {} : { passwordHash: await hashPassword(newPassword) }),
          mustChangePassword: false, passwordChangedAt: new Date(),
        },
      });
      await revokeUserSessions(db, user.id, ctx.session!.id);
      await writeAudit(db, { tenantId: user.tenantId, actor: user, action: "auth.password_changed", ip: ctx.ip });
    });
    return { ok: true, redirect: ctx.user.kind === "PLATFORM" ? "/admin" : "/" };
  },
});

const asHttp = identityToHttp;

// ---------------------------------------------------------------------------
// Password reset and invitation links (email accounts)
//
// Supabase emails a link to /auth/callback carrying an access token in the
// URL fragment. The page posts that token here; the server verifies it with
// Supabase, finds the linked SAF account, sets the password through Supabase
// and issues a SAF session. Tokens never reach SAF's database or logs.
// ---------------------------------------------------------------------------

route({
  method: "POST", path: "/auth/password-reset", tag: "auth",
  summary: "Email a password-reset link (email accounts). Always answers the same way.",
  auth: { public: true }, rateLimit: { limit: 5, windowMs: 60_000 },
  body: z.object({ email: z.string().trim().max(200) }),
  handler: async (ctx) => {
    const email = ctx.body.email.toLowerCase();
    const generic = {
      ok: true,
      message: "If an account exists for this email, a reset link is on its way. Staff who sign in with a login ID should ask their manager.",
    };
    if (!looksLikeEmail(email) || !rateLimit(`reset:${email}`, 3, 60 * 60_000).ok) return generic;
    const user = await withPlatform((db) =>
      db.user.findFirst({ where: { authUserId: { not: null }, email: { equals: email, mode: "insensitive" } } }),
    );
    if (!user || !user.isActive) return generic;
    try {
      await identity().sendRecovery(user.email!, authCallbackUrl());
      await withPlatform((db) => writeAudit(db, { tenantId: user.tenantId, actor: user, action: "auth.password_reset_requested", ip: ctx.ip }));
    } catch (e) {
      // Do not reveal whether the account exists; the failure is logged.
      console.error("[auth] password reset email failed", e);
    }
    return generic;
  },
});

const linkBody = z.object({ accessToken: z.string().min(20).max(4000) });

async function linkedAccount(accessToken: string) {
  const idUser = await identity().getUser(accessToken).catch(asHttp);
  if (!idUser) throw new HttpError(400, "LINK_INVALID", "This link is invalid or has expired. Ask for a new one.");
  const user = await withPlatform((db) =>
    db.user.findUnique({
      where: { authUserId: idUser.id },
      include: {
        invitations: { where: { status: "PENDING" }, orderBy: { sentAt: "desc" }, take: 1 },
        tenant: { include: { business: { select: { name: true } } } },
      },
    }),
  );
  if (!user) throw new HttpError(404, "NO_ACCOUNT", "No SAF Flow account is linked to this email.");
  const invitation = user.invitations[0] ?? null;
  return { user, invitation, purpose: invitation ? ("invite" as const) : ("recovery" as const) };
}

route({
  method: "POST", path: "/auth/link/inspect", tag: "auth",
  summary: "Describe an invitation / reset link before the user sets a password",
  auth: { public: true }, body: linkBody, rateLimit: { limit: 30, windowMs: 60_000 },
  handler: async (ctx) => {
    const { user, invitation, purpose } = await linkedAccount(ctx.body.accessToken);
    if (invitation && invitation.expiresAt < new Date())
      throw new HttpError(410, "INVITATION_EXPIRED", "This invitation has expired. Ask for a new one.");
    if (!invitation && !user.isActive) throw new HttpError(403, "ACCOUNT_DISABLED", "This account has been disabled.");
    return {
      purpose, email: user.email, fullName: user.fullName,
      organization: user.tenant?.business?.name ?? (user.kind === "PLATFORM" ? "SmartAutoFlex" : null),
    };
  },
});

route({
  method: "POST", path: "/auth/link/complete", tag: "auth",
  summary: "Set a password from an invitation / reset link and sign in",
  auth: { public: true }, rateLimit: { limit: 10, windowMs: 60_000 },
  body: linkBody.extend({ password: z.string().min(1).max(200) }),
  handler: async (ctx) => {
    const { user, invitation, purpose } = await linkedAccount(ctx.body.accessToken);
    if (invitation && invitation.expiresAt < new Date())
      throw new HttpError(410, "INVITATION_EXPIRED", "This invitation has expired. Ask for a new one.");
    if (!invitation && !user.isActive) throw new HttpError(403, "ACCOUNT_DISABLED", "This account has been disabled.");
    const policy = passwordPolicyError(ctx.body.password);
    if (policy) throw badRequest(policy);

    await identity().updatePassword(ctx.body.accessToken, ctx.body.password).catch(asHttp);

    const meta = { ip: ctx.ip, userAgent: ctx.userAgent };
    const session = await withPlatform(async (db) => {
      if (invitation) {
        await db.invitation.update({ where: { id: invitation.id }, data: { status: "ACCEPTED", acceptedAt: new Date() } });
        await db.user.update({ where: { id: user.id }, data: { isActive: true } });
      }
      await revokeUserSessions(db, user.id);
      await db.user.update({
        where: { id: user.id },
        data: { mustChangePassword: false, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
      });
      await writeAudit(db, {
        tenantId: user.tenantId, actor: user, ...meta,
        action: purpose === "invite" ? "auth.invitation_accepted" : "auth.password_reset_completed",
      });
      // A reset link proves control of the mailbox, not the second factor.
      return createSession(db, user.id, user.tenantId, meta, { mfaPending: !!user.mfaEnabledAt });
    });
    ctx.headers.append("set-cookie", sessionCookie(session.token, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)));
    if (user.mfaEnabledAt) return { ok: true, purpose, mfaRequired: true, redirect: "/mfa" };
    return { ok: true, purpose, redirect: user.kind === "PLATFORM" ? "/admin" : "/" };
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
      mfaEnabled: user.mfaEnabled, mfaRequired: mfaRequiredFor(user),
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
  auth: { session: true, allowPasswordChange: true, allowMfaEnrollment: true },
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
