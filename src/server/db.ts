import { PrismaClient, Prisma } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __safPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__safPrisma ?? new PrismaClient({ log: process.env.PRISMA_LOG === "1" ? ["query", "error"] : ["error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.__safPrisma = prisma;

export type Tx = Prisma.TransactionClient;

const TX_OPTS = { maxWait: 10_000, timeout: 30_000 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/**
 * Runs `fn` in a transaction bound to one tenant. PostgreSQL RLS policies only
 * expose rows whose tenant_id equals app.tenant_id, so even a query that
 * forgets its tenant filter cannot read or write another tenant's data.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isUuid(tenantId)) throw new Error("withTenant: invalid tenant id");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }, TX_OPTS);
}

/**
 * Cross-tenant transaction. Used ONLY by Super Admin routes, the session
 * bootstrap (resolving a session before the tenant is known), public
 * token lookups and scheduled jobs.
 */
export async function withPlatform<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return fn(tx);
  }, TX_OPTS);
}

/** Atomic per-tenant document counter (order no., invoice no., ...). */
export async function nextSeq(db: Tx, tenantId: string | null, key: string): Promise<number> {
  const scope = tenantId ? `${tenantId}:${key}` : `platform:${key}`;
  const rows = await db.$queryRaw<{ value: number }[]>`
    INSERT INTO doc_sequences (scope, tenant_id, value)
    VALUES (${scope}, ${tenantId}::uuid, 1)
    ON CONFLICT (scope) DO UPDATE SET value = doc_sequences.value + 1
    RETURNING value`;
  return Number(rows[0].value);
}
