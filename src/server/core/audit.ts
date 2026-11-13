import type { Prisma } from "@prisma/client";
import type { Tx } from "../db";

export interface AuditEntry {
  tenantId?: string | null;
  actor?: { id: string; username: string } | null;
  action: string;
  entityType?: string;
  entityId?: string;
  productCode?: string;
  ip?: string;
  userAgent?: string;
  meta?: Record<string, unknown>;
}

// Never stored in the audit trail: credentials, OTP / recovery codes, cookies, keys.
const SECRET_KEYS = /pass(word)?|secret|token|signature|otp|totp|mfa_?code|recovery_?code|cookie|authorization|api_?key|private_?key|cvv|card_?number/i;

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : scrub(val, depth + 1);
  }
  return out;
}

/** Append-only audit trail (the runtime DB role has no UPDATE/DELETE on it). */
export async function writeAudit(db: Tx, e: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      tenantId: e.tenantId ?? null,
      actorId: e.actor?.id ?? null,
      actorName: e.actor?.username ?? null,
      action: e.action,
      entityType: e.entityType ?? null,
      entityId: e.entityId ?? null,
      productCode: e.productCode ?? null,
      ip: e.ip ?? null,
      userAgent: e.userAgent ?? null,
      meta: e.meta ? (scrub(e.meta) as Prisma.InputJsonValue) : undefined,
    },
  });
}
