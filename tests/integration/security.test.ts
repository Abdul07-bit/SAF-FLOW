/**
 * Security regression suite (see SECURITY_TEST_REPORT.md). Every test runs
 * against the real API dispatcher and the real PostgreSQL database with the
 * non-superuser application role, so RLS and triggers are exercised for real.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { listRoutes } from "@/server/api";
import { prisma, withPlatform, withTenant } from "@/server/db";
import { currentCode } from "@/server/auth/mfa";
import { api, createBusiness, createStaff, expectError, login, sessionCookieFrom, STRONG_PASSWORD } from "../helpers";
import { TEST_ENV } from "../env";

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const imageForm = (bytes: Uint8Array, name = "photo.png") => {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(bytes)], name, { type: "image/png" }));
  return fd;
};
const fillPath = (p: string) => p.replace(/:product/g, "dine").replace(/:[A-Za-z]+/g, randomUUID()).replace(/\*[A-Za-z]+/g, "x");

/** Moves a user's sessions' last fresh authentication into the past. */
const expireStepUp = (userId: string) =>
  withPlatform((db) => db.session.updateMany({ where: { userId }, data: { stepUpAt: new Date(Date.now() - 3 * 3_600_000) } }));

async function userIdOf(cookie: string) {
  return (await api("GET", "/me", { cookie })).body.user.id as string;
}

// ---------------------------------------------------------------------------
describe("tenant isolation (database level)", () => {
  it("in tenant A's scope, EVERY tenant-owned table shows zero rows of tenant B and no write can reach them", async () => {
    const a = await createBusiness([{ productCode: "dine", tier: "GROWTH" }, { productCode: "stay", tier: "GROWTH" }, { productCode: "bill", tier: "GROWTH" }]);
    const b = await createBusiness([{ productCode: "dine", tier: "GROWTH" }, { productCode: "stay", tier: "GROWTH" }, { productCode: "bill", tier: "GROWTH" }]);
    // Give B data in many tables.
    await api("POST", "/dine/menu-categories", { cookie: b.manager, body: { name: "B cat" } });
    await api("POST", "/dine/tables", { cookie: b.manager, body: { name: "B1" } });
    await api("POST", "/bill/customers", { cookie: b.manager, body: { name: "B customer", phone: "9800000099" } });
    await api("POST", "/dine/staff/employees", { cookie: b.manager, body: { fullName: "B Employee", designation: "Chef" } });

    const tables = await withPlatform((db) => db.$queryRaw<{ t: string }[]>`
      SELECT c.table_name AS t FROM information_schema.columns c
      JOIN information_schema.tables x ON x.table_name = c.table_name AND x.table_schema = c.table_schema AND x.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY 1`);
    expect(tables.length).toBeGreaterThan(50);

    const leaks: string[] = [];
    let bRowsSomewhere = 0;
    for (const { t } of tables) {
      // Identifiers come from the catalog, never from input.
      const [{ n }] = await withPlatform((db) => db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${t}" WHERE tenant_id = $1::uuid`, b.tenantId));
      bRowsSomewhere += Number(n);
      const [{ seen }] = await withTenant(a.tenantId, (db) => db.$queryRawUnsafe<{ seen: bigint }[]>(`SELECT count(*) AS seen FROM "${t}" WHERE tenant_id = $1::uuid`, b.tenantId));
      // audit_logs: the app role has no UPDATE privilege at all (even stronger than RLS).
      const touched = await withTenant(a.tenantId, (db) => db.$executeRawUnsafe(`UPDATE "${t}" SET tenant_id = tenant_id WHERE tenant_id = $1::uuid`, b.tenantId))
        .catch((e: Error) => { if (/permission denied/i.test(e.message) && t === "audit_logs") return 0; throw e; });
      if (Number(seen) !== 0 || touched !== 0) leaks.push(t);
    }
    expect(bRowsSomewhere).toBeGreaterThan(20);
    expect(leaks).toEqual([]);
    // The tenants table itself.
    expect(await withTenant(a.tenantId, (db) => db.tenant.count({ where: { id: b.tenantId } }))).toBe(0);
  });

  it("a row can never reference another business's record, in any scope (foreign keys skip RLS)", async () => {
    const a = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const b = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const bBranch = await withPlatform((db) => db.branch.findFirstOrThrow({ where: { tenantId: b.tenantId, isMain: true } }));
    await expect(withTenant(a.tenantId, (db) => db.dineTable.create({ data: { tenantId: a.tenantId, branchId: bBranch.id, name: "X", qrToken: randomUUID() } }))).rejects.toThrow(/SAF_CROSS_TENANT_REF/);
    await expect(withPlatform((db) => db.dineTable.create({ data: { tenantId: a.tenantId, branchId: bBranch.id, name: "X", qrToken: randomUUID() } }))).rejects.toThrow(/SAF_CROSS_TENANT_REF/);
    // Re-pointing an existing row is blocked too.
    const aTable = await api("POST", "/dine/tables", { cookie: a.manager, body: { name: "A1" } });
    await expect(withPlatform((db) => db.dineTable.update({ where: { id: aTable.body.id }, data: { branchId: bBranch.id } }))).rejects.toThrow(/SAF_CROSS_TENANT_REF/);
    // Every tenant-to-tenant foreign key is covered by the guard trigger.
    const [{ uncovered }] = await withPlatform((db) => db.$queryRaw<{ uncovered: bigint }[]>`
      SELECT count(DISTINCT ch.relname) AS uncovered FROM pg_constraint k
      JOIN pg_class ch ON ch.oid = k.conrelid JOIN pg_class pa ON pa.oid = k.confrelid
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      WHERE k.contype = 'f' AND a.attname <> 'tenant_id'
        AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = ch.oid AND x.attname = 'tenant_id')
        AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = pa.oid AND x.attname = 'tenant_id')
        AND NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = ch.oid AND g.tgname = 'saf_tenant_refs')`);
    expect(Number(uncovered)).toBe(0);
  });

  it("global catalog (roles, plans, prices, settings) cannot be changed from a tenant scope", async () => {
    const a = await createBusiness([{ productCode: "bill", tier: "BASIC" }]);
    expect((await withTenant(a.tenantId, (db) => db.role.updateMany({ data: { name: "pwned" } }))).count).toBe(0);
    expect((await withTenant(a.tenantId, (db) => db.rolePermission.deleteMany({}))).count).toBe(0);
    expect((await withTenant(a.tenantId, (db) => db.plan.updateMany({ data: { monthlyPrice: 1 } }))).count).toBe(0);
    await expect(withTenant(a.tenantId, (db) => db.platformSetting.create({ data: { key: `x-${a.code}`, value: {} } }))).rejects.toThrow();
    // ...while every scope can still read it.
    expect(await withTenant(a.tenantId, (db) => db.role.count())).toBeGreaterThan(5);
  });

  it("audit records are immutable even for the database owner role", async () => {
    const owner = new PrismaClient({ datasourceUrl: TEST_ENV.DIRECT_URL });
    try {
      await expect(owner.$executeRawUnsafe("UPDATE audit_logs SET action = 'tampered' WHERE id = (SELECT max(id) FROM audit_logs)")).rejects.toThrow(/SAF_AUDIT_IMMUTABLE/);
      await expect(owner.$executeRawUnsafe("DELETE FROM audit_logs WHERE id = (SELECT max(id) FROM audit_logs)")).rejects.toThrow(/SAF_AUDIT_IMMUTABLE/);
    } finally {
      await owner.$disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
describe("tenant isolation (API, every method)", () => {
  it("tenant A cannot read, change, delete or restore tenant B's records by id", async () => {
    const a = await createBusiness([{ productCode: "dine", tier: "GROWTH" }, { productCode: "stay", tier: "GROWTH" }, { productCode: "bill", tier: "GROWTH" }]);
    const b = await createBusiness([{ productCode: "dine", tier: "GROWTH" }, { productCode: "stay", tier: "GROWTH" }, { productCode: "bill", tier: "GROWTH" }]);
    const made: Record<string, string> = {};
    const mk = async (path: string, body: object) => {
      const r = await api("POST", path, { cookie: b.manager, body });
      expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(201);
      made[path] = r.body.id;
    };
    await mk("/dine/tables", { name: "B-T1" });
    await mk("/dine/menu-categories", { name: "B-Cat" });
    await mk("/dine/stock-items", { name: "B-Rice", unit: "kg" });
    await mk("/dine/suppliers", { name: "B-Supplier" });
    await mk("/stay/room-types", { name: "B-Deluxe", baseRate: 300000 });
    await mk("/bill/categories", { name: "B-Grocery" });
    await mk("/bill/customers", { name: "B-Customer", phone: "9800000098" });
    await mk("/dine/staff/employees", { fullName: "B-Employee", designation: "Chef" });

    for (const [path, id] of Object.entries(made)) {
      for (const method of ["GET", "PATCH", "DELETE"] as const) {
        const r = await api(method, `${path}/${id}`, { cookie: a.manager, body: method === "PATCH" ? { name: "hijack", fullName: "hijack" } : undefined });
        expect([403, 404], `${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status);
      }
      const list = await api("GET", path, { cookie: a.manager });
      expect(JSON.stringify(list.body)).not.toContain(id);
    }
    // B's data is untouched.
    expect((await api("GET", `/dine/tables/${made["/dine/tables"]}`, { cookie: b.manager })).body.name).toBe("B-T1");

    // Team, support, settings, sessions: B's ids are invisible to A.
    const bOwnerId = await userIdOf(b.manager);
    expectError(await api("PATCH", `/dine/team/${bOwnerId}`, { cookie: a.manager, body: { fullName: "Hijacked Name" } }), 404);
    expectError(await api("POST", `/dine/team/${bOwnerId}/reset-password`, { cookie: a.manager }), 404);
    expectError(await api("POST", `/dine/security/users/${bOwnerId}/revoke-sessions`, { cookie: a.manager }), 404);
    const bSession = await withPlatform((db) => db.session.findFirstOrThrow({ where: { userId: bOwnerId, revokedAt: null } }));
    expectError(await api("POST", `/dine/security/sessions/${bSession.id}/revoke`, { cookie: a.manager }), 404);
    const ticket = await api("POST", "/dine/support/tickets", { cookie: b.manager, body: { subject: "B private", body: "secret details" } });
    expectError(await api("GET", `/dine/support/tickets/${ticket.body.id}`, { cookie: a.manager }), 404);
    expectError(await api("POST", `/dine/support/tickets/${ticket.body.id}/messages`, { cookie: a.manager, body: { body: "x" } }), 404);
    const bInvoice = await withPlatform((db) => db.invoice.findFirstOrThrow({ where: { tenantId: b.tenantId } }));
    expectError(await api("POST", `/dine/billing/invoices/${bInvoice.id}/checkout`, { cookie: a.manager }), 404);

    // Security Center only ever lists A's own accounts.
    const sec = await api("GET", "/dine/security/overview", { cookie: a.manager });
    expect(sec.status, JSON.stringify(sec.body)).toBe(200);
    const aUsers = await withPlatform((db) => db.user.findMany({ where: { tenantId: a.tenantId }, select: { id: true } }));
    expect(sec.body.staff.map((s: any) => s.id).sort()).toEqual(aUsers.map((u) => u.id).sort());
    const sessions = await api("GET", "/dine/security/sessions", { cookie: a.manager });
    expect(sessions.body.items.every((s: any) => aUsers.some((u) => u.id === s.userId))).toBe(true);
    expect(JSON.stringify(sessions.body)).not.toMatch(/tokenHash|token_hash/);
  });

  it("malformed and injected ids are simply not found; search input is data, not SQL", async () => {
    const a = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    await api("POST", "/dine/tables", { cookie: a.manager, body: { name: "Only" } });
    for (const bad of ["1%20OR%201=1", "'%20OR%20'1'='1", "..%2F..%2Fetc%2Fpasswd", "00000000-0000-0000-0000-000000000000"]) {
      expectError(await api("GET", `/dine/tables/${bad}`, { cookie: a.manager }), 404);
    }
    const inj = await api("GET", `/dine/tables?q=${encodeURIComponent("' OR '1'='1' --")}`, { cookie: a.manager });
    expect(inj.status).toBe(200);
    expect(inj.body.items).toHaveLength(0);
    const xss = "<script>alert(1)</script>";
    const t = await api("POST", "/dine/tables", { cookie: a.manager, body: { name: xss.slice(0, 40) } });
    const got = await api("GET", `/dine/tables/${t.body.id}`, { cookie: a.manager });
    expect(got.headers.get("content-type")).toContain("application/json");
    expect(got.body.name).toBe(xss.slice(0, 40)); // stored verbatim, rendered escaped by React
  });
});

// ---------------------------------------------------------------------------
describe("authentication & request protections on every endpoint", () => {
  it("every non-public endpoint refuses anonymous callers (401) before validating input", async () => {
    const offenders: string[] = [];
    for (const r of listRoutes()) {
      if ("public" in r.auth) continue;
      const res = await api(r.method, fillPath(r.path), { body: r.method === "GET" ? undefined : {} });
      if (res.status !== 401) offenders.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(offenders).toEqual([]);
  });

  it("every non-public state-changing endpoint rejects requests without the CSRF header", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const offenders: string[] = [];
    for (const r of listRoutes()) {
      if ("public" in r.auth || r.method === "GET") continue;
      const res = await api(r.method, fillPath(r.path), { cookie: biz.manager, csrf: false, body: {} });
      if (res.status !== 403 || res.body?.error?.code !== "CSRF_REJECTED") offenders.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(offenders).toEqual([]);
  });

  it("oversized bodies are refused, with or without a Content-Length", async () => {
    const big = "x".repeat(1_200_000);
    expectError(await api("POST", "/auth/login", { body: { username: "someone", password: big } }), 413, "PAYLOAD_TOO_LARGE");
    const { handleRequest } = await import("@/server/api");
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode("y".repeat(100_000)));
        c.close();
      },
    });
    const res = await handleRequest(new Request("http://localhost:3000/api/auth/login", {
      method: "POST", body: stream, headers: { "content-type": "application/json" }, duplex: "half",
    } as RequestInit));
    expect(res.status).toBe(413);
  });

  it("every response carries a correlation id that also lands in the audit trail", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const r = await api("POST", "/dine/tables", { cookie: biz.manager, body: { name: "Corr" } });
    const rid = r.headers.get("x-request-id");
    expect(rid).toMatch(/^[0-9a-f-]{36}$/);
    const log = await withTenant(biz.tenantId, (db) => db.auditLog.findFirst({ where: { tenantId: biz.tenantId, entityId: r.body.id } }));
    expect((log?.meta as any)?.requestId).toBe(rid);
  });

  it("expired, revoked and over-age sessions are rejected", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const uid = await userIdOf(biz.manager);
    expect((await api("GET", "/me", { cookie: biz.manager })).status).toBe(200);
    await withPlatform((db) => db.session.updateMany({ where: { userId: uid }, data: { createdAt: new Date(Date.now() - 8 * 86_400_000) } }));
    expectError(await api("GET", "/me", { cookie: biz.manager }), 401);
    const again = await login(biz.managerUsername, STRONG_PASSWORD);
    await withPlatform((db) => db.session.updateMany({ where: { userId: uid, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    expectError(await api("GET", "/me", { cookie: again }), 401);
  });
});

// ---------------------------------------------------------------------------
describe("role escalation and staff permissions", () => {
  it("staff cannot grant themselves or others more power; managers cannot take over other managers", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "GROWTH" }]);
    const waiter = await createStaff(biz.manager, "dine", "waiter1", [{ product: "dine", roleCode: "waiter" }]);
    const m2 = await createStaff(biz.manager, "dine", "mgr2", [{ product: "dine", roleCode: "manager" }]);
    const m3 = await createStaff(biz.manager, "dine", "mgr3", [{ product: "dine", roleCode: "manager" }]);
    const ownerId = await userIdOf(biz.manager);

    // Waiter: no team management at all, and cannot promote itself.
    expectError(await api("POST", "/dine/team", { cookie: waiter.cookie, body: { fullName: "Evil", handle: "evil", access: [{ product: "dine", roleCode: "manager" }] } }), 403);
    expectError(await api("PATCH", `/dine/team/${waiter.id}`, { cookie: waiter.cookie, body: { access: [{ product: "dine", roleCode: "manager" }] } }), 403);
    expectError(await api("GET", "/dine/security/overview", { cookie: waiter.cookie }), 403);
    // Tenant accounts never reach platform administration.
    expectError(await api("GET", "/admin/security/overview", { cookie: biz.manager }), 403, "PLATFORM_ONLY");

    // A non-owner manager cannot create managers, change its own roles, or act on peers / the owner.
    expectError(await api("POST", "/dine/team", { cookie: m2.cookie, body: { fullName: "Mgr", handle: "mgr4", access: [{ product: "dine", roleCode: "manager" }] } }), 403);
    expectError(await api("PATCH", `/dine/team/${m2.id}`, { cookie: m2.cookie, body: { access: [{ product: "dine", roleCode: "cashier" }] } }), 400);
    expectError(await api("POST", `/dine/team/${m3.id}/reset-password`, { cookie: m2.cookie }), 403);
    expectError(await api("POST", `/dine/team/${m3.id}/status`, { cookie: m2.cookie, body: { isActive: false } }), 403);
    expectError(await api("POST", `/dine/security/users/${m3.id}/revoke-sessions`, { cookie: m2.cookie }), 403);
    expectError(await api("POST", `/dine/team/${ownerId}/status`, { cookie: m2.cookie, body: { isActive: false } }), 403);
    expectError(await api("POST", `/dine/team/${waiter.id}/mfa-reset`, { cookie: m2.cookie }), 403);
    // ...but can still manage ordinary staff.
    expect((await api("POST", `/dine/team/${waiter.id}/reset-password`, { cookie: m2.cookie })).status).toBe(200);

    // Deactivated staff lose access immediately (sessions revoked).
    const w2 = await createStaff(biz.manager, "dine", "waiter2", [{ product: "dine", roleCode: "waiter" }]);
    expect((await api("GET", "/me/products/dine", { cookie: w2.cookie })).status).toBe(200);
    expect((await api("POST", `/dine/team/${w2.id}/status`, { cookie: biz.manager, body: { isActive: false } })).status).toBe(200);
    expectError(await api("GET", "/me/products/dine", { cookie: w2.cookie }), 401);

    // Privileged actions are audited.
    const logs = await withTenant(biz.tenantId, (db) => db.auditLog.findMany({ where: { tenantId: biz.tenantId, action: { in: ["team.user.create", "team.user.disable", "team.user.reset_password"] } } }));
    expect(new Set(logs.map((l) => l.action))).toEqual(new Set(["team.user.create", "team.user.disable", "team.user.reset_password"]));
  });

  it("sensitive actions need a fresh authentication (step-up)", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const ownerId = await userIdOf(biz.manager);
    await expireStepUp(ownerId);
    expectError(await api("PUT", "/dine/settings", { cookie: biz.manager, body: { receiptFooter: "x" } }), 403, "STEP_UP_REQUIRED");
    expectError(await api("POST", "/auth/step-up", { cookie: biz.manager, body: { password: "wrong-password-1" } }), 401, "STEP_UP_FAILED");
    expect((await api("POST", "/auth/step-up", { cookie: biz.manager, body: { password: STRONG_PASSWORD } })).status).toBe(200);
    expect((await api("PUT", "/dine/settings", { cookie: biz.manager, body: { receiptFooter: "x" } })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("multi-factor authentication", () => {
  it("enrol, sign in with TOTP (rotated session), replay and recovery-code reuse rejected, brute force locks", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const setup = await api("POST", "/auth/mfa/setup", { cookie: biz.manager });
    expect(setup.status, JSON.stringify(setup.body)).toBe(200);
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const secret = setup.body.secret as string;
    const stored = await withPlatform((db) => db.user.findFirstOrThrow({ where: { tenantId: biz.tenantId, isTenantOwner: true } }));
    expect(stored.mfaSecretEnc).not.toContain(secret);
    expectError(await api("POST", "/auth/mfa/enable", { cookie: biz.manager, body: { code: "000000" } }), 400, "MFA_INVALID");
    const enable = await api("POST", "/auth/mfa/enable", { cookie: biz.manager, body: { code: currentCode(secret) } });
    expect(enable.status, JSON.stringify(enable.body)).toBe(200);
    const recovery = enable.body.recoveryCodes as string[];
    expect(recovery).toHaveLength(10);
    expectError(await api("GET", "/me", { cookie: biz.manager }), 401); // enabling MFA signed every other session out

    // Password alone only opens an MFA-pending session.
    const step1 = await api("POST", "/auth/login", { body: { username: biz.managerUsername, password: STRONG_PASSWORD } });
    expect(step1.body).toEqual({ mfaRequired: true, redirect: "/mfa" });
    const pending = sessionCookieFrom(step1);
    expectError(await api("GET", "/me", { cookie: pending }), 401, "MFA_REQUIRED");
    expectError(await api("GET", "/me/products/dine", { cookie: pending }), 401, "MFA_REQUIRED");
    // The code used for enrolment cannot be replayed.
    expectError(await api("POST", "/auth/mfa/verify", { cookie: pending, body: { code: currentCode(secret) } }), 401, "MFA_INVALID");
    const nextCode = currentCode(secret, Date.now() + 30_000);
    const ok = await api("POST", "/auth/mfa/verify", { cookie: pending, body: { code: nextCode } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const full = sessionCookieFrom(ok);
    expect(full).not.toBe(pending);
    expectError(await api("GET", "/me", { cookie: pending }), 401); // pending session is gone
    expect((await api("GET", "/me", { cookie: full })).body.user.mfaEnabled).toBe(true);

    // Same code on a new sign-in: replay rejected. Recovery codes work once.
    const p2 = sessionCookieFrom(await api("POST", "/auth/login", { body: { username: biz.managerUsername, password: STRONG_PASSWORD } }));
    expectError(await api("POST", "/auth/mfa/verify", { cookie: p2, body: { code: nextCode } }), 401, "MFA_INVALID");
    expect((await api("POST", "/auth/mfa/verify", { cookie: p2, body: { code: recovery[0] } })).body.usedRecoveryCode).toBe(true);
    const p3 = sessionCookieFrom(await api("POST", "/auth/login", { body: { username: biz.managerUsername, password: STRONG_PASSWORD } }));
    expectError(await api("POST", "/auth/mfa/verify", { cookie: p3, body: { code: recovery[0] } }), 401, "MFA_INVALID");

    // Guessing: after 5 wrong codes the attempt ends and the account locks.
    for (let i = 0; i < 4; i++) expectError(await api("POST", "/auth/mfa/verify", { cookie: p3, body: { code: "000000" } }), 401, "MFA_INVALID");
    expectError(await api("POST", "/auth/mfa/verify", { cookie: p3, body: { code: "000000" } }), 401);
    expectError(await api("GET", "/me", { cookie: p3 }), 401);
    expectError(await api("POST", "/auth/login", { body: { username: biz.managerUsername, password: STRONG_PASSWORD } }), 401, "INVALID_CREDENTIALS");
    const actions = (await withTenant(biz.tenantId, (db) => db.auditLog.findMany({ where: { tenantId: biz.tenantId, action: { startsWith: "auth." } } }))).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["auth.mfa_enabled", "auth.mfa_failed", "auth.mfa_recovery_code_used", "auth.account_locked"]));
    // No OTP or recovery code ever reaches the audit trail.
    const all = JSON.stringify(await withTenant(biz.tenantId, (db) => db.auditLog.findMany({ where: { tenantId: biz.tenantId } })), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(all).not.toContain(nextCode);
    expect(all).not.toContain(recovery[0]);

    // Lost device: SAF Security resets it (step-up protected), every session ends.
    await withPlatform((db) => db.user.updateMany({ where: { id: stored.id }, data: { lockedUntil: null } }));
    const reset = await api("POST", `/admin/users/${stored.id}/mfa-reset`, { cookie: biz.admin, body: { reason: "Owner lost phone, identity verified by call" } });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    const plain = await api("POST", "/auth/login", { body: { username: biz.managerUsername, password: STRONG_PASSWORD } });
    expect(plain.status).toBe(200);
    expect(plain.body.mfaRequired).toBeUndefined();
  });

  it("where policy requires MFA, an un-enrolled account can only reach enrolment", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const prev = process.env.SAF_MFA_REQUIRED;
    process.env.SAF_MFA_REQUIRED = "owners";
    try {
      expectError(await api("GET", "/me/products/dine", { cookie: biz.manager }), 403, "MFA_ENROLLMENT_REQUIRED");
      const me = await api("GET", "/me", { cookie: biz.manager });
      expect(me.body.user).toMatchObject({ mfaEnabled: false, mfaRequired: true });
      expect((await api("POST", "/auth/mfa/setup", { cookie: biz.manager })).status).toBe(200);
      // Staff who are not owners are unaffected by an owners-only policy.
      process.env.SAF_MFA_REQUIRED = "";
      const w = await createStaff(biz.manager, "dine", "w1", [{ product: "dine", roleCode: "waiter" }]);
      process.env.SAF_MFA_REQUIRED = "owners";
      expect((await api("GET", "/me/products/dine", { cookie: w.cookie })).status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.SAF_MFA_REQUIRED;
      else process.env.SAF_MFA_REQUIRED = prev;
    }
  });
});

// ---------------------------------------------------------------------------
describe("files", () => {
  it("employee photos need a signed, expiring URL; logos stay public; only real images are accepted", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "GROWTH" }]);
    const emp = await api("POST", "/dine/staff/employees", { cookie: biz.manager, body: { fullName: "Photo Person", designation: "Chef" } });
    expectError(await api("POST", `/dine/staff/employees/${emp.body.id}/photo`, { cookie: biz.manager, body: imageForm(new TextEncoder().encode("MZ\u0090\u0000 not an image"), "evil.exe") }), 400);
    expectError(await api("POST", `/dine/staff/employees/${emp.body.id}/photo`, { cookie: biz.manager, body: imageForm(new TextEncoder().encode("<svg onload=alert(1)>"), "x.png") }), 400);
    const up = await api("POST", `/dine/staff/employees/${emp.body.id}/photo`, { cookie: biz.manager, body: imageForm(PNG_1PX, "../../../etc/passwd.png") });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const url = up.body.photoUrl as string;
    expect(url).toMatch(/^\/api\/files\/t\/[0-9a-f-]{36}\/employees\/[0-9a-f-]{36}\.png\?exp=\d+&sig=[A-Za-z0-9_-]{32}$/);
    const path = url.replace(/^\/api/, "");
    const served = await api("GET", path);
    expect(served.status).toBe(200);
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expectError(await api("GET", path.split("?")[0]), 404); // no signature
    // Tampered: always change the first signature character to a DIFFERENT one.
    expectError(await api("GET", path.replace(/sig=(.)/, (_m, c: string) => `sig=${c === "A" ? "B" : "A"}`)), 404);
    expectError(await api("GET", path.replace(/exp=\d+/, "exp=1")), 404); // expired
    const logo = await api("POST", "/dine/business/logo", { cookie: biz.manager, body: imageForm(PNG_1PX) });
    expect(logo.status, JSON.stringify(logo.body)).toBe(200);
    expect((await api("GET", logo.body.logoUrl.replace(/^\/api/, ""))).status).toBe(200);
    expectError(await api("GET", "/files/..%2F..%2Fpackage.json"), 404);
  });
});

// ---------------------------------------------------------------------------
describe("Security Center", () => {
  it("platform view is limited to authorised SAF staff and reports MFA coverage and alerts", async () => {
    const biz = await createBusiness([{ productCode: "bill", tier: "BASIC" }]);
    const ov = await api("GET", "/admin/security/overview", { cookie: biz.admin });
    expect(ov.status, JSON.stringify(ov.body)).toBe(200);
    expect(ov.body).toHaveProperty("mfa.platform.total");
    expect(Array.isArray(ov.body.alerts)).toBe(true);
    expect(ov.body.external.backups).toMatch(/Not monitored/);
    const ev = await api("GET", "/admin/security/events?kind=failed", { cookie: biz.admin });
    expect(ev.status).toBe(200);
    expectError(await api("GET", "/admin/security/overview", { cookie: biz.manager }), 403, "PLATFORM_ONLY");
  });

  it("tenant managers can sign a staff member out everywhere (audited)", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const w = await createStaff(biz.manager, "dine", "w9", [{ product: "dine", roleCode: "waiter" }]);
    expect((await api("POST", `/dine/security/users/${w.id}/revoke-sessions`, { cookie: biz.manager })).status).toBe(200);
    expectError(await api("GET", "/me", { cookie: w.cookie }), 401);
    const log = await withTenant(biz.tenantId, (db) => db.auditLog.findFirst({ where: { tenantId: biz.tenantId, action: "security.sessions_revoked", entityId: w.id } }));
    expect(log).not.toBeNull();
  });
});

describe("not applicable in this codebase", () => {
  it.todo("AI agent tool authorization: SAF Flow has no AI agents or LLM integrations yet (see SECURITY_ARCHITECTURE.md > AI)");
  it.todo("WhatsApp webhook verification: no WhatsApp integration exists yet");
});

// Keep the shared client tidy for the run.
void prisma;

describe("hosting: Vercel cron and Android app links", () => {
  it("renewal job accepts Vercel's Bearer secret (GET) and refuses anything else", async () => {
    expectError(await api("GET", "/jobs/renewals", { headers: { authorization: "Bearer wrong-secret-value" } }), 401);
    const ok = await api("GET", "/jobs/renewals", { headers: { authorization: `Bearer ${TEST_ENV.CRON_SECRET}` } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("assetlinks.json is empty until configured, then names exactly the app and its signing key", async () => {
    const prev = { p: process.env.ANDROID_PACKAGE_NAME, c: process.env.ANDROID_CERT_SHA256 };
    try {
      delete process.env.ANDROID_PACKAGE_NAME;
      delete process.env.ANDROID_CERT_SHA256;
      expect((await api("GET", "/well-known/assetlinks")).body).toEqual([]);
      const fp = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0").toUpperCase()).join(":");
      process.env.ANDROID_PACKAGE_NAME = "com.smartautoflex.safflow";
      process.env.ANDROID_CERT_SHA256 = `${fp}, not-a-fingerprint`;
      const r = await api("GET", "/well-known/assetlinks");
      expect(r.body).toEqual([{
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: "com.smartautoflex.safflow", sha256_cert_fingerprints: [fp] },
      }]);
    } finally {
      if (prev.p === undefined) delete process.env.ANDROID_PACKAGE_NAME; else process.env.ANDROID_PACKAGE_NAME = prev.p;
      if (prev.c === undefined) delete process.env.ANDROID_CERT_SHA256; else process.env.ANDROID_CERT_SHA256 = prev.c;
    }
  });
});
