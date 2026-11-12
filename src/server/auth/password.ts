import { hash, verify } from "@node-rs/argon2";

// @node-rs/argon2 defaults are Argon2id, m=19 MiB, t=2, p=1 (OWASP baseline).
export async function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    return await verify(stored, plain);
  } catch {
    return false;
  }
}

// Used to equalise timing when the username does not exist.
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(plain: string): Promise<void> {
  dummyHash ??= hash("saf-timing-equaliser-password");
  await verifyPassword(await dummyHash, plain);
}

export function passwordPolicyError(pw: string, username?: string): string | null {
  if (pw.length < 8) return "Password must be at least 8 characters.";
  if (pw.length > 128) return "Password must be at most 128 characters.";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return "Password must contain letters and numbers.";
  if (username && pw.toLowerCase().includes(username.split("@").pop()!.toLowerCase()) && username.length > 3)
    return "Password must not contain your login ID.";
  return null;
}
