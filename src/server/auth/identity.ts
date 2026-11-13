/**
 * Identity provider for email accounts (Supabase Auth).
 *
 * SAF Flow uses Supabase Auth for IDENTITY only: proving who someone is
 * (password check, invitation, email verification, password reset). After
 * that, SAF issues its own httpOnly session and all AUTHORIZATION (roles,
 * permissions, tenant scope, RLS) stays in SAF's own server and database.
 * Login-ID accounts (floor staff without email) never touch this module.
 *
 * Talks to the Supabase Auth (GoTrue) REST API directly. The secret key is
 * read from the server environment only and never sent to a browser.
 */

import { logError } from "../core/log";
import { HttpError } from "../http/errors";

export class IdentityError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export interface IdentityUser {
  id: string;
  email: string;
  emailConfirmed: boolean;
}

export interface IdentityProvider {
  /** URL + publishable key present: sign-in and recovery work. */
  configured(): boolean;
  /** Secret key present: invitations, link generation and bans work. */
  adminConfigured(): boolean;
  /** Returns null for wrong email/password. */
  signInWithPassword(email: string, password: string): Promise<{ user: IdentityUser; accessToken: string } | null>;
  /** Verifies an access token from an invite / recovery link. */
  getUser(accessToken: string): Promise<IdentityUser | null>;
  updatePassword(accessToken: string, password: string): Promise<void>;
  /** Sends the password-recovery email (Supabase SMTP). */
  sendRecovery(email: string, redirectTo: string): Promise<void>;
  /** Creates the identity and emails an invitation link. */
  inviteUser(email: string, redirectTo: string, data: Record<string, unknown>): Promise<IdentityUser>;
  /** Creates (if needed) the identity and returns an invitation link without emailing it. */
  generateInviteLink(email: string, redirectTo: string, data: Record<string, unknown>): Promise<{ user: IdentityUser; link: string }>;
  setBanned(authUserId: string, banned: boolean): Promise<void>;
}

// ---------------------------------------------------------------------------
// Supabase implementation
// ---------------------------------------------------------------------------

function env() {
  return {
    url: (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, ""),
    publishable: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "",
    secret: process.env.SUPABASE_SECRET_KEY || "",
  };
}

function toUser(u: any): IdentityUser {
  return { id: u.id, email: String(u.email ?? "").toLowerCase(), emailConfirmed: Boolean(u.email_confirmed_at ?? u.confirmed_at) };
}

async function call(path: string, init: { method: string; key: "publishable" | "secret"; bearer?: string; body?: unknown }) {
  const e = env();
  const key = init.key === "secret" ? e.secret : e.publishable;
  if (!e.url || !key) throw new IdentityError("IDENTITY_NOT_CONFIGURED", "Email sign-in is not configured on this server.", 503);
  const headers: Record<string, string> = { apikey: key, "content-type": "application/json" };
  // Legacy JWT keys also go in Authorization; new sb_* keys only in apikey.
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  else if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  let res: Response;
  try {
    res = await fetch(`${e.url}/auth/v1${path}`, {
      method: init.method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    logError("identity", "Supabase Auth unreachable", err);
    throw new IdentityError("IDENTITY_UNAVAILABLE", "The sign-in service is temporarily unreachable. Please try again.", 503);
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { msg: text };
  }
  return { status: res.status, ok: res.ok, body };
}

function errCode(body: any): string {
  return String(body?.error_code ?? body?.code ?? body?.error ?? "");
}

function fail(status: number, body: any, fallback: string): never {
  const code = errCode(body);
  const msg = String(body?.msg ?? body?.message ?? body?.error_description ?? fallback);
  if (code === "weak_password") throw new IdentityError("WEAK_PASSWORD", msg, 400);
  if (code === "same_password") throw new IdentityError("SAME_PASSWORD", "New password must be different from the current one.", 400);
  if (code === "over_email_send_rate_limit" || status === 429)
    throw new IdentityError("EMAIL_RATE_LIMITED", "Too many emails were sent recently. Please wait and try again.", 429);
  if (status === 401 || status === 403) {
    logError("identity", "Supabase rejected the server key", status, body);
    throw new IdentityError("IDENTITY_NOT_CONFIGURED", "The sign-in service rejected this server's credentials.", 503);
  }
  logError("identity", "Supabase Auth error", status, body);
  throw new IdentityError("IDENTITY_ERROR", fallback, 502);
}

export const supabaseIdentity: IdentityProvider = {
  configured: () => Boolean(env().url && env().publishable),
  adminConfigured: () => Boolean(env().url && env().secret),

  async signInWithPassword(email, password) {
    const r = await call("/token?grant_type=password", { method: "POST", key: "publishable", body: { email, password } });
    if (r.ok) return { user: toUser(r.body.user), accessToken: String(r.body.access_token) };
    const code = errCode(r.body);
    if (code === "invalid_credentials" || code === "invalid_grant" || r.status === 400) {
      if (code === "email_not_confirmed")
        throw new IdentityError("EMAIL_NOT_CONFIRMED", "Please accept your invitation email before signing in.", 403);
      return null;
    }
    return fail(r.status, r.body, "Sign-in failed.");
  },

  async getUser(accessToken) {
    const r = await call("/user", { method: "GET", key: "publishable", bearer: accessToken });
    if (r.ok) return toUser(r.body);
    if (r.status === 401 || r.status === 403) return null;
    return fail(r.status, r.body, "Could not verify the link.");
  },

  async updatePassword(accessToken, password) {
    const r = await call("/user", { method: "PUT", key: "publishable", bearer: accessToken, body: { password } });
    if (!r.ok) fail(r.status, r.body, "Could not set the password.");
  },

  async sendRecovery(email, redirectTo) {
    const r = await call(`/recover?redirect_to=${encodeURIComponent(redirectTo)}`, { method: "POST", key: "publishable", body: { email } });
    if (!r.ok) fail(r.status, r.body, "Could not send the reset email.");
  },

  async inviteUser(email, redirectTo, data) {
    const r = await call(`/invite?redirect_to=${encodeURIComponent(redirectTo)}`, { method: "POST", key: "secret", body: { email, data } });
    if (r.ok) return toUser(r.body);
    if (errCode(r.body) === "email_exists" || r.status === 422)
      throw new IdentityError("IDENTITY_EXISTS", "This email already has a sign-in account.", 409);
    return fail(r.status, r.body, "Could not send the invitation.");
  },

  async generateInviteLink(email, redirectTo, data) {
    // "invite" fails for an existing identity; fall back to a magic link,
    // which signs the same person in so they can set a password.
    for (const type of ["invite", "magiclink"] as const) {
      const r = await call("/admin/generate_link", { method: "POST", key: "secret", body: { type, email, data, redirect_to: redirectTo } });
      if (r.ok) {
        const link = r.body?.action_link ?? r.body?.properties?.action_link;
        const user = r.body?.user ?? r.body;
        if (!link || !user?.id) fail(502, r.body, "Unexpected response while creating the invitation link.");
        return { user: toUser(user), link };
      }
      if (!(type === "invite" && (errCode(r.body) === "email_exists" || r.status === 422))) fail(r.status, r.body, "Could not create the invitation link.");
    }
    throw new IdentityError("IDENTITY_ERROR", "Could not create the invitation link.", 502);
  },

  async setBanned(authUserId, banned) {
    const r = await call(`/admin/users/${encodeURIComponent(authUserId)}`, {
      method: "PUT", key: "secret", body: { ban_duration: banned ? "876000h" : "none" },
    });
    if (!r.ok) fail(r.status, r.body, "Could not update the sign-in account.");
  },
};

// ---------------------------------------------------------------------------
// Provider selection (tests install an in-memory provider)
// ---------------------------------------------------------------------------

let current: IdentityProvider = supabaseIdentity;

export function identity(): IdentityProvider {
  return current;
}

export function setIdentityProvider(p: IdentityProvider | null) {
  current = p ?? supabaseIdentity;
}

/** Where invite / recovery links land. Must be in Supabase's Redirect URLs allow-list. */
export function authCallbackUrl(): string {
  return `${(process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "")}/auth/callback`;
}

export function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

/** Re-throws an IdentityError as the HttpError the API returns. */
export function identityToHttp(e: unknown): never {
  if (e instanceof IdentityError) throw new HttpError(e.status, e.code, e.message);
  throw e;
}

/** Emails a password-reset link to an email account (admin / manager action). */
export async function emailPasswordReset(email: string): Promise<void> {
  await identity().sendRecovery(email, authCallbackUrl()).catch(identityToHttp);
}
