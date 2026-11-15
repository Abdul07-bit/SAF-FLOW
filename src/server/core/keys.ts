import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Application keys. One secret (SAF_APP_SECRET, >= 32 characters, kept in the
 * server environment / secrets manager only) is expanded with HKDF-SHA256 into
 * independent purpose-bound keys, so a key used for one job can never be
 * replayed for another. Only standard Node.js crypto primitives are used.
 *
 * Production refuses to run these features without a real secret (fail
 * closed). Development and tests use a fixed, clearly marked dev secret.
 *
 * Rotation: see SECURITY_ARCHITECTURE.md > Key management. MFA secrets carry a
 * key version prefix ("v1:") so a future rotation can re-encrypt gradually.
 */
const DEV_SECRET = "saf-dev-only-secret-do-not-use-in-production-0001";

export class KeyUnavailableError extends Error {
  constructor() {
    super("SAF_APP_SECRET is not configured (at least 32 characters required in production).");
  }
}

function master(): Buffer {
  const s = process.env.SAF_APP_SECRET || "";
  if (s.length >= 32) return Buffer.from(s, "utf8");
  if (process.env.NODE_ENV === "production") throw new KeyUnavailableError();
  return Buffer.from(DEV_SECRET, "utf8");
}

export function appSecretConfigured(): boolean {
  return (process.env.SAF_APP_SECRET || "").length >= 32;
}

const cache = new Map<string, Buffer>();
function derive(purpose: "mfa-encryption-v1" | "file-url-signing-v1" | "attendance-qr-v1"): Buffer {
  const m = master();
  const id = `${purpose}:${m.length}:${m.subarray(0, 4).toString("hex")}`;
  let k = cache.get(id);
  if (!k) {
    k = Buffer.from(hkdfSync("sha256", m, Buffer.from("saf-flow"), Buffer.from(purpose), 32));
    cache.set(id, k);
  }
  return k;
}

const TAG_BYTES = 16;

/** AES-256-GCM. Output: "v1:" + base64(iv | tag | ciphertext). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", derive("mfa-encryption-v1"), iv, { authTagLength: TAG_BYTES });
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith("v1:")) throw new Error("Unknown secret format");
  const raw = Buffer.from(stored.slice(3), "base64");
  if (raw.length < 12 + TAG_BYTES) throw new Error("Malformed secret");
  // Fixed tag length: a truncated (forgeable) authentication tag is rejected.
  const d = createDecipheriv("aes-256-gcm", derive("mfa-encryption-v1"), raw.subarray(0, 12), { authTagLength: TAG_BYTES });
  d.setAuthTag(raw.subarray(12, 12 + TAG_BYTES));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

/** Attendance QR: a new 6-digit code every ATTENDANCE_WINDOW_SEC for each branch. */
export const ATTENDANCE_WINDOW_SEC = 30;

export function attendanceWindow(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / ATTENDANCE_WINDOW_SEC);
}

/** 6 digits derived from the app secret, so nobody can compute tomorrow's (or another branch's) code. */
export function attendanceCode(tenantId: string, branchId: string, product: string, window: number): string {
  const mac = createHmac("sha256", derive("attendance-qr-v1")).update([tenantId, branchId, product, String(window)].join("|")).digest();
  return String(mac.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

/** Accepts the code on screen now or the one just before it (30-60 seconds of validity). */
export function verifyAttendanceCode(tenantId: string, branchId: string, product: string, code: string, nowMs = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const w = attendanceWindow(nowMs);
  let ok = false;
  for (const win of [w, w - 1]) {
    const a = Buffer.from(attendanceCode(tenantId, branchId, product, win)), b = Buffer.from(code);
    if (timingSafeEqual(a, b)) ok = true;
  }
  return ok;
}

/** HMAC signature for short-lived file URLs (base64url, 32 chars). */
export function signFileUrl(key: string, expiresAtSec: number): string {
  return createHmac("sha256", derive("file-url-signing-v1")).update(`${key}\n${expiresAtSec}`).digest("base64url").slice(0, 32);
}

export function verifyFileUrl(key: string, expiresAtSec: number, sig: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!Number.isInteger(expiresAtSec) || expiresAtSec < nowSec || !sig) return false;
  let expected: string;
  try {
    expected = signFileUrl(key, expiresAtSec);
  } catch {
    return false;
  }
  const a = Buffer.from(expected), b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}
