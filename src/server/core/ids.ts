import { randomBytes, randomInt, createHash } from "node:crypto";

/** URL-safe unguessable token (QR codes, public invoice links, sessions). */
export function token(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

const PW_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PW_LOWER = "abcdefghijkmnopqrstuvwxyz";
const PW_DIGIT = "23456789";
const PW_SYMBOL = "@#%*+=?";

/** Temporary password: 12 chars, unambiguous alphabet, all classes present. */
export function temporaryPassword(length = 12): string {
  const all = PW_UPPER + PW_LOWER + PW_DIGIT + PW_SYMBOL;
  const chars = [
    PW_UPPER[randomInt(PW_UPPER.length)],
    PW_LOWER[randomInt(PW_LOWER.length)],
    PW_DIGIT[randomInt(PW_DIGIT.length)],
    PW_SYMBOL[randomInt(PW_SYMBOL.length)],
  ];
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/**
 * Usernames are "<BUSINESSCODE>@<handle>" - the business code is upper-case,
 * the handle lower-case. Normalising makes login case-insensitive while the
 * unique index stays a plain btree.
 */
export function normalizeUsername(raw: string): string {
  const v = raw.trim();
  const at = v.indexOf("@");
  if (at < 0) return v.toLowerCase();
  return `${v.slice(0, at).toUpperCase()}@${v.slice(at + 1).toLowerCase()}`;
}

export const RESERVED_CODES = new Set(["SAF", "ADMIN", "ROOT", "SYSTEM", "SUPPORT", "API", "TEST"]);

export function isValidBusinessCode(code: string): boolean {
  return /^[A-Z][A-Z0-9]{1,11}$/.test(code) && !RESERVED_CODES.has(code);
}

export function isValidHandle(handle: string): boolean {
  return /^[a-z][a-z0-9._-]{1,29}$/.test(handle);
}
