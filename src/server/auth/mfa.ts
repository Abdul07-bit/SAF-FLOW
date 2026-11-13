import { randomBytes } from "node:crypto";
import { Secret, TOTP } from "otpauth";
import QRCode from "qrcode";
import { sha256 } from "../core/ids";
import { decryptSecret, encryptSecret } from "../core/keys";

/**
 * TOTP multi-factor authentication (RFC 6238, via the `otpauth` library):
 * SHA-1, 6 digits, 30-second period - what Google Authenticator, Microsoft
 * Authenticator, 1Password and Authy expect.
 *
 * - The shared secret is stored AES-256-GCM encrypted (core/keys.ts).
 * - A time step is accepted at most once (users.mfa_last_step): replaying a
 *   code that was just used, or an older one, fails.
 * - 10 single-use recovery codes, stored as SHA-256 hashes (they are 50-bit
 *   random values, so a fast hash is appropriate), shown exactly once.
 */
const PERIOD = 30;
const ISSUER = "SAF Flow";

function totp(secretBase32: string, label: string) {
  return new TOTP({ issuer: ISSUER, label, algorithm: "SHA1", digits: 6, period: PERIOD, secret: Secret.fromBase32(secretBase32) });
}

export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export async function enrollmentPayload(secretBase32: string, label: string) {
  const uri = totp(secretBase32, label).toString();
  return { secret: secretBase32, uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
}

export const sealSecret = (base32: string) => encryptSecret(base32);
export const openSecret = (stored: string) => decryptSecret(stored);

/**
 * Checks a 6-digit code against the secret, allowing one step of clock drift.
 * Returns the matched time step (to persist as mfa_last_step) or null.
 */
export function checkTotp(secretBase32: string, code: string, lastStep: bigint | number | null, now = Date.now()): number | null {
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const delta = totp(secretBase32, "x").validate({ token: clean, timestamp: now, window: 1 });
  if (delta === null) return null;
  const step = Math.floor(now / 1000 / PERIOD) + delta;
  if (lastStep !== null && step <= Number(lastStep)) return null; // replay
  return step;
}

/** Test helper / authenticator emulation. */
export function currentCode(secretBase32: string, now = Date.now()): string {
  return totp(secretBase32, "x").generate({ timestamp: now });
}

const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function newRecoveryCodes(n = 10): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const bytes = randomBytes(10);
    const raw = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join("");
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return { codes, hashes: codes.map(hashRecovery) };
}

export function hashRecovery(code: string): string {
  return sha256(`saf-recovery:${code.trim().toLowerCase().replace(/[^a-z0-9]/g, "")}`);
}

/**
 * Who must use MFA. SAF_MFA_REQUIRED is a comma list of "platform" (every SAF
 * Team account) and "owners" (business owner accounts). Default: both in
 * production, none elsewhere (development and the automated tests).
 */
export function mfaRequiredFor(user: { kind: string; isTenantOwner: boolean }): boolean {
  const raw = process.env.SAF_MFA_REQUIRED ?? (process.env.NODE_ENV === "production" ? "platform,owners" : "");
  const set = new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (user.kind === "PLATFORM") return set.has("platform");
  return user.isTenantOwner && set.has("owners");
}

/** Minutes a fresh sign-in / re-authentication counts for sensitive actions. */
export function stepUpWindowMs(): number {
  return Math.max(1, Number(process.env.STEP_UP_WINDOW_MINUTES || 10)) * 60_000;
}
