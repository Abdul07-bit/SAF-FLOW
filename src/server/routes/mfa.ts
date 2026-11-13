/**
 * Two-step verification (TOTP) and re-authentication for sensitive actions.
 *
 * Sign-in with MFA on:  POST /auth/login       -> "MFA pending" session (10 min,
 *                                                 can only call /auth/mfa/verify)
 *                       POST /auth/mfa/verify  -> pending session revoked, a NEW
 *                                                 full session issued (rotation)
 * Enrolment:            POST /auth/mfa/setup -> /auth/mfa/enable (recovery codes once)
 * Step-up:              POST /auth/step-up     -> re-auth for routes with `stepUp`
 */
import { z } from "zod";
import { SUPER_ADMIN_ROLE } from "@/config/platform";
import { route } from "../http/router";
import { badRequest, forbidden, HttpError, notFound } from "../http/errors";
import { withPlatform } from "../db";
import { createSession, revokeSession, revokeUserSessions, sessionCookie } from "../auth/session";
import { burnPasswordCheck, verifyPassword } from "../auth/password";
import { identity } from "../auth/identity";
import { writeAudit } from "../core/audit";
import { KeyUnavailableError } from "../core/keys";
import {
  checkTotp, enrollmentPayload, hashRecovery, mfaRequiredFor, newRecoveryCodes, newTotpSecret, openSecret, sealSecret,
} from "../auth/mfa";

const MAX_MFA_FAILURES = 5;
const codeBody = z.object({ code: z.string().trim().min(6).max(20) });

function keyError(e: unknown): never {
  if (e instanceof KeyUnavailableError)
    throw new HttpError(503, "MFA_UNAVAILABLE", "Two-step verification is not configured on this server. Contact SAF support.");
  throw e;
}

/** Checks a TOTP code (or, when allowed, a recovery code). Persists replay state / consumes the recovery code. */
async function checkSecondFactor(userId: string, code: string, allowRecovery: boolean): Promise<"totp" | "recovery" | null> {
  return withPlatform(async (db) => {
    const u = await db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!u.mfaEnabledAt || !u.mfaSecretEnc) return null;
    let secret: string;
    try {
      secret = openSecret(u.mfaSecretEnc);
    } catch (e) {
      keyError(e);
    }
    const step = checkTotp(secret, code, u.mfaLastStep);
    if (step !== null) {
      // Conditional write: two concurrent requests cannot both use one time step.
      const r = await db.user.updateMany({
        where: { id: u.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: BigInt(step) } }] },
        data: { mfaLastStep: BigInt(step) },
      });
      return r.count === 1 ? "totp" : null;
    }
    if (!allowRecovery) return null;
    const h = hashRecovery(code);
    if (!u.mfaRecoveryHashes.includes(h)) return null;
    await db.user.update({ where: { id: u.id }, data: { mfaRecoveryHashes: u.mfaRecoveryHashes.filter((x) => x !== h) } });
    return "recovery";
  });
}

route({
  method: "GET", path: "/auth/mfa", tag: "auth", summary: "Your two-step verification status",
  auth: { session: true, allowMfaEnrollment: true },
  handler: async (ctx) => {
    const u = await withPlatform((db) => db.user.findUniqueOrThrow({ where: { id: ctx.user.id } }));
    return {
      enabled: !!u.mfaEnabledAt, enabledAt: u.mfaEnabledAt, required: mfaRequiredFor(ctx.user),
      recoveryCodesLeft: u.mfaRecoveryHashes.length,
    };
  },
});

route({
  method: "POST", path: "/auth/mfa/verify", tag: "auth", summary: "Finish signing in with an authenticator or recovery code",
  auth: { session: true, allowMfaPending: true, allowPasswordChange: true, allowMfaEnrollment: true },
  body: codeBody, rateLimit: { limit: 10, windowMs: 60_000 }, audit: false,
  handler: async (ctx) => {
    const s = ctx.session!;
    if (!s.mfaPending) throw badRequest("This session is already verified.");
    const meta = { ip: ctx.ip, userAgent: ctx.userAgent };
    const method = await checkSecondFactor(ctx.user.id, ctx.body.code, true);
    if (!method) {
      await withPlatform(async (db) => {
        const row = await db.session.update({ where: { id: s.id }, data: { mfaFailures: { increment: 1 } } });
        await writeAudit(db, { tenantId: ctx.user.tenantId, actor: ctx.user, action: "auth.mfa_failed", ...meta, meta: { failures: row.mfaFailures, requestId: ctx.requestId } });
        if (row.mfaFailures >= MAX_MFA_FAILURES) {
          // Too many wrong codes: end this attempt and count it towards the account lockout.
          await revokeSession(db, s.id);
          const lockMinutes = Number(process.env.LOGIN_LOCK_MINUTES || 15);
          await db.user.update({ where: { id: ctx.user.id }, data: { lockedUntil: new Date(Date.now() + lockMinutes * 60_000), failedLoginCount: 0 } });
          await writeAudit(db, { tenantId: ctx.user.tenantId, actor: ctx.user, action: "auth.account_locked", ...meta, meta: { reason: "mfa_failures" } });
        }
      });
      throw new HttpError(401, "MFA_INVALID", "That code is not correct or has already been used.");
    }
    const fresh = await withPlatform(async (db) => {
      await revokeSession(db, s.id);
      const full = await createSession(db, ctx.user.id, ctx.user.tenantId, meta, { mfaVerified: true });
      await db.user.update({ where: { id: ctx.user.id }, data: { lastLoginAt: new Date() } });
      await writeAudit(db, { tenantId: ctx.user.tenantId, actor: ctx.user, action: "auth.login", ...meta, meta: { mfa: method, requestId: ctx.requestId } });
      if (method === "recovery") await writeAudit(db, { tenantId: ctx.user.tenantId, actor: ctx.user, action: "auth.mfa_recovery_code_used", ...meta });
      return full;
    });
    ctx.headers.append("set-cookie", sessionCookie(fresh.token, Math.floor((fresh.expiresAt.getTime() - Date.now()) / 1000)));
    return {
      ok: true, usedRecoveryCode: method === "recovery",
      redirect: ctx.user.mustChangePassword ? "/change-password" : ctx.user.kind === "PLATFORM" ? "/admin" : "/",
    };
  },
});

route({
  method: "POST", path: "/auth/mfa/setup", tag: "auth", summary: "Start setting up an authenticator app (returns the QR code)",
  auth: { session: true, allowMfaEnrollment: true }, stepUp: true, audit: false,
  handler: async (ctx) => {
    if (ctx.user.mfaEnabled) throw badRequest("Two-step verification is already on.");
    const secret = newTotpSecret();
    let sealed: string;
    try {
      sealed = sealSecret(secret);
    } catch (e) {
      keyError(e);
    }
    await withPlatform((db) => db.user.update({ where: { id: ctx.user.id }, data: { mfaSecretEnc: sealed, mfaLastStep: null } }));
    return enrollmentPayload(secret, ctx.user.username);
  },
});

route({
  method: "POST", path: "/auth/mfa/enable", tag: "auth", summary: "Confirm the authenticator code and turn two-step verification on",
  auth: { session: true, allowMfaEnrollment: true }, body: codeBody, rateLimit: { limit: 10, windowMs: 60_000 }, audit: false,
  handler: async (ctx) => {
    const meta = { ip: ctx.ip, userAgent: ctx.userAgent };
    const result = await withPlatform(async (db) => {
      const u = await db.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
      if (u.mfaEnabledAt) throw badRequest("Two-step verification is already on.");
      if (!u.mfaSecretEnc) throw badRequest("Start the set-up first.");
      let secret: string;
      try {
        secret = openSecret(u.mfaSecretEnc);
      } catch (e) {
        keyError(e);
      }
      const step = checkTotp(secret, ctx.body.code, null);
      if (step === null) throw new HttpError(400, "MFA_INVALID", "That code is not correct. Check the time on your phone and try again.");
      const { codes, hashes } = newRecoveryCodes();
      await db.user.update({ where: { id: u.id }, data: { mfaEnabledAt: new Date(), mfaLastStep: BigInt(step), mfaRecoveryHashes: hashes } });
      // Privilege change: every other device signs in again; this one gets a new session.
      await revokeUserSessions(db, u.id);
      const s = await createSession(db, u.id, u.tenantId, meta, { mfaVerified: true });
      await writeAudit(db, { tenantId: u.tenantId, actor: ctx.user, action: "auth.mfa_enabled", ...meta, meta: { requestId: ctx.requestId } });
      return { codes, s };
    });
    ctx.headers.append("set-cookie", sessionCookie(result.s.token, Math.floor((result.s.expiresAt.getTime() - Date.now()) / 1000)));
    return { ok: true, recoveryCodes: result.codes };
  },
});

route({
  method: "POST", path: "/auth/mfa/recovery-codes", tag: "auth", summary: "Replace your recovery codes (old ones stop working)",
  auth: { session: true }, body: codeBody, stepUp: true, audit: false,
  handler: async (ctx) => {
    if (!(await checkSecondFactor(ctx.user.id, ctx.body.code, false))) throw new HttpError(400, "MFA_INVALID", "That code is not correct.");
    const { codes, hashes } = newRecoveryCodes();
    await withPlatform(async (db) => {
      await db.user.update({ where: { id: ctx.user.id }, data: { mfaRecoveryHashes: hashes } });
      await writeAudit(db, { tenantId: ctx.user.tenantId, actor: ctx.user, action: "auth.mfa_recovery_codes_regenerated", ip: ctx.ip });
    });
    return { recoveryCodes: codes };
  },
});

route({
  method: "POST", path: "/auth/mfa/disable", tag: "auth", summary: "Turn two-step verification off (not allowed where it is required)",
  auth: { session: true }, body: codeBody, stepUp: true, audit: false,
  handler: async (ctx) => {
    if (mfaRequiredFor(ctx.user)) throw forbidden("MFA_REQUIRED_BY_POLICY", "Two-step verification is required for your account and cannot be turned off.");
    if (!(await checkSecondFactor(ctx.user.id, ctx.body.code, false))) throw new HttpError(400, "MFA_INVALID", "That code is not correct.");
    await withPlatform(async (db) => {
      await db.user.update({ where: { id: ctx.user.id }, data: { mfaEnabledAt: null, mfaSecretEnc: null, mfaLastStep: null, mfaRecoveryHashes: [] } });
      await revokeUserSessions(db, ctx.user.id, ctx.session!.id);
      await writeAudit(db, { tenantId: ctx.user.tenantId, actor: ctx.user, action: "auth.mfa_disabled", ip: ctx.ip });
    });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/auth/step-up", tag: "auth",
  summary: "Confirm it is you before a sensitive action (authenticator code, or password when MFA is off)",
  auth: { session: true }, rateLimit: { limit: 10, windowMs: 60_000 }, audit: false,
  body: z.object({ code: z.string().trim().max(20).optional(), password: z.string().max(200).optional() }),
  handler: async (ctx) => {
    let ok = false;
    if (ctx.user.mfaEnabled) {
      if (!ctx.body.code) throw badRequest("Enter the code from your authenticator app.");
      ok = !!(await checkSecondFactor(ctx.user.id, ctx.body.code, false));
    } else {
      if (!ctx.body.password) throw badRequest("Enter your password.");
      const u = await withPlatform((db) => db.user.findUniqueOrThrow({ where: { id: ctx.user.id } }));
      if (u.authUserId) {
        const r = await identity().signInWithPassword(u.email!, ctx.body.password).catch(() => null);
        ok = !!r && r.user.id === u.authUserId;
      } else if (u.passwordHash) ok = await verifyPassword(u.passwordHash, ctx.body.password);
      else await burnPasswordCheck(ctx.body.password);
    }
    await withPlatform(async (db) => {
      if (ok) await db.session.update({ where: { id: ctx.session!.id }, data: { stepUpAt: new Date() } });
      await writeAudit(db, { tenantId: ctx.user.tenantId, actor: ctx.user, action: ok ? "auth.step_up" : "auth.step_up_failed", ip: ctx.ip, meta: { requestId: ctx.requestId } });
    });
    if (!ok) throw new HttpError(401, "STEP_UP_FAILED", ctx.user.mfaEnabled ? "That code is not correct." : "Incorrect password.");
    return { ok: true };
  },
});

/**
 * Lost authenticator: an administrator clears MFA so the person can enrol
 * again. SAF Security (platform.security.manage) for any account; business
 * owners for their own staff (see tenant team routes). Never for yourself,
 * Super Admins only by a Super Admin, and every session of the person ends.
 */
route({
  method: "POST", path: "/admin/users/:id/mfa-reset", tag: "security", summary: "Reset a user's two-step verification (lost device)",
  auth: { platform: "platform.security.manage", elevated: true }, stepUp: true,
  body: z.object({ reason: z.string().trim().min(5).max(300) }),
  handler: async (ctx) => {
    if (ctx.params.id === ctx.user.id) throw badRequest("You cannot reset your own two-step verification.");
    const u = await ctx.db.user.findUnique({ where: { id: ctx.params.id } });
    if (!u) throw notFound("User");
    if (u.platformRole === SUPER_ADMIN_ROLE && !ctx.platform.isSuperAdmin)
      throw forbidden("PRIVILEGE_ESCALATION", "Only a Super Admin can reset a Super Admin's two-step verification.");
    await ctx.db.user.update({ where: { id: u.id }, data: { mfaEnabledAt: null, mfaSecretEnc: null, mfaLastStep: null, mfaRecoveryHashes: [] } });
    await revokeUserSessions(ctx.db, u.id);
    await ctx.audit("security.mfa_reset", { type: "user", id: u.id, tenantId: u.tenantId }, { reason: ctx.body.reason });
    return { ok: true };
  },
});
