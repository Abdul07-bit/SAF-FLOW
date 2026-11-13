import type { TenantStatus, UserKind } from "@prisma/client";
import { withPlatform, type Tx } from "../db";
import { sha256, token } from "../core/ids";

export const SESSION_COOKIE = "saf_session";

const ttlHours = () => Number(process.env.SESSION_TTL_HOURS || 12);
const ABSOLUTE_MAX_MS = 7 * 24 * 3600_000;

export interface SessionUser {
  id: string;
  tenantId: string | null;
  kind: UserKind;
  username: string;
  fullName: string;
  isTenantOwner: boolean;
  platformRole: string | null;
  mustChangePassword: boolean;
  tenantCode: string | null;
  tenantStatus: TenantStatus | null;
  mfaEnabled: boolean;
}

export interface AuthedSession {
  id: string;
  user: SessionUser;
  /** Password accepted but the second factor is still outstanding. */
  mfaPending: boolean;
  /** Last fresh authentication (sign-in, MFA, or explicit re-authentication). */
  stepUpAt: Date | null;
}

export async function createSession(
  db: Tx,
  userId: string,
  tenantId: string | null,
  meta: { ip?: string; userAgent?: string },
  opts: { mfaPending?: boolean; mfaVerified?: boolean } = {},
): Promise<{ token: string; expiresAt: Date; id: string }> {
  const raw = token(32);
  // A half-authenticated (MFA pending) session lives for 10 minutes at most.
  const expiresAt = new Date(Date.now() + (opts.mfaPending ? 10 * 60_000 : ttlHours() * 3600_000));
  const now = new Date();
  const s = await db.session.create({
    data: {
      mfaPending: !!opts.mfaPending,
      mfaVerifiedAt: opts.mfaVerified ? now : null,
      // Signing in is a fresh authentication; a pending session is not.
      stepUpAt: opts.mfaPending ? null : now,
      tokenHash: sha256(raw),
      userId,
      tenantId,
      ip: meta.ip?.slice(0, 64),
      userAgent: meta.userAgent?.slice(0, 300),
      expiresAt,
    },
  });
  return { token: raw, expiresAt, id: s.id };
}

/** Resolves a session token. Runs before the tenant is known, hence platform scope. */
export async function authenticate(raw: string | null | undefined): Promise<AuthedSession | null> {
  if (!raw || raw.length < 20 || raw.length > 100) return null;
  return withPlatform(async (db) => {
    const s = await db.session.findUnique({
      where: { tokenHash: sha256(raw) },
      include: { user: { include: { tenant: { select: { code: true, status: true } } } } },
    });
    const now = Date.now();
    if (!s || s.revokedAt || s.expiresAt.getTime() <= now) return null;
    if (now - s.createdAt.getTime() > ABSOLUTE_MAX_MS) return null;
    if (!s.user.isActive) return null;

    // Sliding expiry, written at most once every 5 minutes (never for MFA-pending sessions).
    if (!s.mfaPending && now - s.lastSeenAt.getTime() > 5 * 60_000) {
      await db.session.update({
        where: { id: s.id },
        data: { lastSeenAt: new Date(now), expiresAt: new Date(now + ttlHours() * 3600_000) },
      });
    }
    const u = s.user;
    return {
      id: s.id,
      mfaPending: s.mfaPending,
      stepUpAt: s.stepUpAt,
      user: {
        id: u.id,
        tenantId: u.tenantId,
        kind: u.kind,
        username: u.username,
        fullName: u.fullName,
        isTenantOwner: u.isTenantOwner,
        platformRole: u.platformRole,
        mustChangePassword: u.mustChangePassword,
        tenantCode: u.tenant?.code ?? null,
        tenantStatus: u.tenant?.status ?? null,
        mfaEnabled: !!u.mfaEnabledAt,
      },
    };
  });
}

export async function revokeSession(db: Tx, sessionId: string) {
  await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function revokeUserSessions(db: Tx, userId: string, exceptSessionId?: string) {
  await db.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
}

export function sessionCookie(value: string, maxAgeSec: number): string {
  const secure = (process.env.APP_URL || "").startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
