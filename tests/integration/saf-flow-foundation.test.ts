/**
 * SAF Flow Phase 1: email identity (Supabase, faked), invitations, password
 * reset, platform RBAC, SAF Team assignment scoping (API + RLS), privilege
 * escalation guards and customer branch restrictions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { setIdentityProvider } from "@/server/auth/identity";
import { withPlatform, withStaffScope } from "@/server/db";
import { adminLogin, api, createBusiness, createStaff, expectError, sessionCookieFrom } from "../helpers";
import { FakeIdentity } from "../fake-identity";

const idp = new FakeIdentity();
const PASSWORD = "TeamPassw0rd!";

beforeAll(() => setIdentityProvider(idp));
afterAll(() => setIdentityProvider(null));

function email(tag: string) {
  return `${tag}-${randomBytes(4).toString("hex")}@saf-test.example`;
}

let empSeq = 0;
/** Invites a SAF Team member as Super Admin, accepts the invite, returns a session. */
async function teamMember(roleCode: string, admin?: string) {
  admin ??= await adminLogin();
  const mail = email(roleCode.toLowerCase());
  const inv = await api("POST", "/admin/team", {
    cookie: admin,
    body: { fullName: `Member ${roleCode}`, email: mail, employeeCode: `E${Date.now() % 100000}${empSeq++}`, roleCode },
  });
  expect(inv.status, JSON.stringify(inv.body)).toBe(201);
  const done = await api("POST", "/auth/link/complete", { body: { accessToken: idp.lastToken(mail), password: PASSWORD } });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return { id: inv.body.id as string, email: mail, cookie: sessionCookieFrom(done) };
}

describe("email identity and invitations", () => {
  it("invited member cannot sign in until the invitation is accepted, then can with email", async () => {
    const admin = await adminLogin();
    const mail = email("inv");
    const inv = await api("POST", "/admin/team", {
      cookie: admin, body: { fullName: "Asha Nair", email: mail, employeeCode: `EMP${Date.now() % 1e6}`, roleCode: "CLIENT_SUCCESS" },
    });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body.delivery).toBe("email");

    expectError(await api("POST", "/auth/login", { body: { username: mail, password: "anything1" } }), 403, "INVITATION_PENDING");

    const token = idp.lastToken(mail);
    const look = await api("POST", "/auth/link/inspect", { body: { accessToken: token } });
    expect(look.body).toMatchObject({ purpose: "invite", email: mail, organization: "SmartAutoFlex" });
    expectError(await api("POST", "/auth/link/complete", { body: { accessToken: token, password: "short" } }), 400);
    const done = await api("POST", "/auth/link/complete", { body: { accessToken: token, password: PASSWORD } });
    expect(done.status).toBe(200);
    expect(done.body.redirect).toBe("/admin");

    const login = await api("POST", "/auth/login", { body: { username: mail.toUpperCase(), password: PASSWORD } });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expectError(await api("POST", "/auth/login", { body: { username: mail, password: "WrongPass123" } }), 401, "INVALID_CREDENTIALS");
  });

  it("forged or unknown link tokens are rejected", async () => {
    expectError(await api("POST", "/auth/link/complete", { body: { accessToken: "fake-token-not-issued-000000", password: PASSWORD } }), 400, "LINK_INVALID");
  });

  it("invitations cannot be sent while Supabase admin credentials are missing", async () => {
    idp.admin = false;
    try {
      const r = await api("POST", "/admin/team", {
        cookie: await adminLogin(), body: { fullName: "No Keys", email: email("nokey"), employeeCode: "NOKEY1", roleCode: "AUDITOR" },
      });
      expectError(r, 503, "IDENTITY_NOT_CONFIGURED");
    } finally {
      idp.admin = true;
    }
  });

  it("password reset: generic answer, email only to real accounts, old sessions revoked", async () => {
    const m = await teamMember("TECH_SUPPORT");
    const before = idp.outbox.length;
    const unknown = await api("POST", "/auth/password-reset", { body: { email: email("nobody") } });
    expect(unknown.status).toBe(200);
    expect(idp.outbox.length).toBe(before);

    const r = await api("POST", "/auth/password-reset", { body: { email: m.email } });
    expect(r.body.message).toBe(unknown.body.message);
    const token = idp.lastToken(m.email);
    expect((await api("POST", "/auth/link/inspect", { body: { accessToken: token } })).body.purpose).toBe("recovery");
    const done = await api("POST", "/auth/link/complete", { body: { accessToken: token, password: "BrandNewPass9" } });
    expect(done.status).toBe(200);
    expectError(await api("GET", "/me", { cookie: m.cookie }), 401);
    expect((await api("POST", "/auth/login", { body: { username: m.email, password: "BrandNewPass9" } })).status).toBe(200);
  });

  it("logout-all revokes every session", async () => {
    const m = await teamMember("AUDITOR");
    const second = sessionCookieFrom(await api("POST", "/auth/login", { body: { username: m.email, password: PASSWORD } }));
    expect((await api("POST", "/auth/logout-all", { cookie: m.cookie })).status).toBe(200);
    expectError(await api("GET", "/me", { cookie: second }), 401);
  });
});

describe("SAF Team scoping", () => {
  it("an unassigned member sees no businesses; assignment grants exactly one; revocation is immediate", async () => {
    const a = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const b = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const ops = await teamMember("OPERATIONS_MANAGER");

    const none = await api("GET", "/admin/businesses?pageSize=100", { cookie: ops.cookie });
    expect(none.status).toBe(200);
    expect(none.body.items.map((x: any) => x.id)).not.toContain(a.tenantId);
    expectError(await api("GET", `/admin/businesses/${a.tenantId}`, { cookie: ops.cookie }), 404);

    const assign = await api("PUT", `/admin/team/${ops.id}/assignments/${a.tenantId}`, { cookie: await adminLogin(), body: {} });
    expect(assign.status, JSON.stringify(assign.body)).toBe(200);

    const list = await api("GET", "/admin/businesses?pageSize=100", { cookie: ops.cookie });
    const ids = list.body.items.map((x: any) => x.id);
    expect(ids).toContain(a.tenantId);
    expect(ids).not.toContain(b.tenantId);
    expect((await api("GET", `/admin/businesses/${a.tenantId}`, { cookie: ops.cookie })).status).toBe(200);
    expectError(await api("GET", `/admin/businesses/${b.tenantId}`, { cookie: ops.cookie }), 404);
    // Customer accounts of unassigned businesses are invisible too.
    const managers = await api("GET", "/admin/managers?pageSize=200", { cookie: ops.cookie });
    expect(JSON.stringify(managers.body)).not.toContain(b.managerUsername);

    expect((await api("DELETE", `/admin/team/${ops.id}/assignments/${a.tenantId}`, { cookie: await adminLogin() })).status).toBe(200);
    expectError(await api("GET", `/admin/businesses/${a.tenantId}`, { cookie: ops.cookie }), 404);
  });

  it("RLS itself confines the staff scope to assigned businesses", async () => {
    const a = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const b = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const ops = await teamMember("OPERATIONS_MANAGER");
    await api("PUT", `/admin/team/${ops.id}/assignments/${a.tenantId}`, { cookie: await adminLogin(), body: {} });

    const seen = await withStaffScope(ops.id, async (db) => ({
      tenants: (await db.tenant.findMany({ where: { id: { in: [a.tenantId, b.tenantId] } } })).map((t) => t.id),
      users: (await db.user.findMany({ where: { tenantId: { in: [a.tenantId, b.tenantId] } } })).map((u) => u.tenantId),
    }));
    expect(seen.tenants).toEqual([a.tenantId]);
    expect(new Set(seen.users)).toEqual(new Set([a.tenantId]));

    // Writes into an unassigned business are rejected by the database.
    await expect(
      withStaffScope(ops.id, (db) => db.branch.create({ data: { tenantId: b.tenantId, name: "Sneaky", code: "SNEAK" } })),
    ).rejects.toThrow();
    // A member cannot assign themselves through the database either.
    await expect(
      withStaffScope(ops.id, (db) => db.staffAssignment.create({ data: { userId: ops.id, tenantId: b.tenantId } })),
    ).rejects.toThrow();
  });

  it("per-assignment permissions and module limits narrow the role", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }, { productCode: "stay", tier: "BASIC" }]);
    const ops = await teamMember("OPERATIONS_MANAGER");
    const admin = await adminLogin();
    await api("PUT", `/admin/team/${ops.id}/assignments/${biz.tenantId}`, {
      cookie: admin, body: { permissions: ["platform.business.read", "platform.entitlements.manage"], products: ["stay"] },
    });
    expect((await api("GET", `/admin/businesses/${biz.tenantId}`, { cookie: ops.cookie })).status).toBe(200);
    expectError(await api("PATCH", `/admin/businesses/${biz.tenantId}`, { cookie: ops.cookie, body: { city: "Mysuru" } }), 403, "PLATFORM_PERMISSION_DENIED");

    // Module limit: this assignment covers Stay Flow only.
    expectError(await api("PUT", `/admin/businesses/${biz.tenantId}/features/dine.multi_branch`, { cookie: ops.cookie, body: { mode: "grant" } }), 403);
    const ok = await api("PUT", `/admin/businesses/${biz.tenantId}/features/stay.maintenance`, { cookie: ops.cookie, body: { mode: "grant" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("role permissions gate routes: scoped roles cannot reach SAF Team or settings", async () => {
    const support = await teamMember("TECH_SUPPORT");
    expectError(await api("GET", "/admin/team", { cookie: support.cookie }), 403, "PLATFORM_PERMISSION_DENIED");
    expectError(await api("PUT", "/admin/settings", { cookie: support.cookie, body: {} }), 403, "PLATFORM_PERMISSION_DENIED");
    expectError(await api("GET", "/admin/analytics/revenue", { cookie: support.cookie }), 403, "PLATFORM_PERMISSION_DENIED");
    const auditor = await teamMember("AUDITOR");
    expect((await api("GET", "/admin/businesses", { cookie: auditor.cookie })).status).toBe(200);
    expectError(await api("POST", "/admin/jobs/renewals", { cookie: auditor.cookie }), 403, "PLATFORM_PERMISSION_DENIED");
  });

  it("an implementation executive is assigned to the business they create", async () => {
    const exec = await teamMember("IMPLEMENTATION_EXEC");
    const code = `IX${randomBytes(3).toString("hex")}`.toUpperCase();
    const r = await api("POST", "/admin/businesses", {
      cookie: exec.cookie,
      body: { name: "Exec Cafe", category: "CAFE", ownerName: "Owner", phone: "9876543210", code, products: [{ productCode: "dine", tier: "BASIC", billingCycle: "MONTHLY" }] },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await api("GET", `/admin/businesses/${r.body.tenantId}`, { cookie: exec.cookie })).status).toBe(200);
  });

  it("customer accounts cannot use platform APIs", async () => {
    const biz = await createBusiness([{ productCode: "bill", tier: "BASIC" }]);
    expectError(await api("GET", "/admin/businesses", { cookie: biz.manager }), 403, "PLATFORM_ONLY");
    expectError(await api("GET", "/admin/team", { cookie: biz.manager }), 403, "PLATFORM_ONLY");
  });
});

describe("privilege escalation guards", () => {
  it("a Platform Admin cannot appoint a Super Admin, edit roles, or change their own role", async () => {
    const pa = await teamMember("PLATFORM_ADMIN");
    const r = await api("POST", "/admin/team", {
      cookie: pa.cookie, body: { fullName: "Wannabe", email: email("sa"), employeeCode: "WANNA1", roleCode: "SUPER_ADMIN" },
    });
    expectError(r, 403, "PRIVILEGE_ESCALATION");
    expectError(await api("PUT", "/admin/platform-roles/TECH_SUPPORT", {
      cookie: pa.cookie, body: { name: "Tech", permissions: ["platform.dashboard.read"] },
    }), 403, "PLATFORM_PERMISSION_DENIED");
    expectError(await api("PATCH", `/admin/team/${pa.id}`, { cookie: pa.cookie, body: { roleCode: "AUDITOR" } }), 400);
  });

  it("nobody can grant permissions they do not hold", async () => {
    const admin = await adminLogin();
    // A custom role allowed to manage permissions but holding little else.
    const code = `LIMITED_${randomBytes(2).toString("hex").toUpperCase()}`;
    expect((await api("POST", "/admin/platform-roles", {
      cookie: admin, body: { code, name: "Limited admin", allTenants: true, permissions: ["platform.dashboard.read", "platform.staff.read", "platform.staff.permissions.manage"] },
    })).status).toBe(201);
    const limited = await teamMember(code);
    expectError(await api("PUT", "/admin/platform-roles/AUDITOR", {
      cookie: limited.cookie, body: { name: "Auditor", allTenants: true, permissions: ["platform.dashboard.read", "platform.billing.manage"] },
    }), 403, "PRIVILEGE_ESCALATION");
    expectError(await api("PUT", "/admin/platform-roles/SUPER_ADMIN", {
      cookie: admin, body: { name: "Super Admin", permissions: [] },
    }), 403, "ROLE_LOCKED");
  });

  it("suspending a member signs them out everywhere and blocks sign-in", async () => {
    const admin = await adminLogin();
    const m = await teamMember("CLIENT_SUCCESS");
    expectError(await api("PATCH", `/admin/team/${m.id}`, { cookie: admin, body: { isActive: false } }), 400);
    expect((await api("PATCH", `/admin/team/${m.id}`, { cookie: admin, body: { isActive: false, reason: "Left the company" } })).status).toBe(200);
    expectError(await api("GET", "/admin/businesses", { cookie: m.cookie }), 401);
    expect((await api("POST", "/auth/login", { body: { username: m.email, password: PASSWORD } })).status).not.toBe(200);
    const log = await withPlatform((db) => db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM audit_logs WHERE action = 'platform.staff.suspend' AND entity_id = ${m.id}`);
    expect(Number(log[0].n)).toBe(1);
  });
});

describe("customer branch restrictions", () => {
  it("branch-restricted staff can only use their branches", async () => {
    const biz = await createBusiness([{ productCode: "stay", tier: "GROWTH" }]);
    const br = await api("POST", "/stay/branches", { cookie: biz.manager, body: { name: "Airport", code: "AIR" } });
    expect(br.status, JSON.stringify(br.body)).toBe(201);
    const ctx = await api("GET", "/me/products/stay", { cookie: biz.manager });
    const main = ctx.body.branches.find((b: any) => b.isMain).id;
    const airport = br.body.id ?? br.body.item?.id;

    const staff = await createStaff(biz.manager, "stay", "desk1", [{ product: "stay", roleCode: "receptionist" }]);
    const set = await api("PATCH", `/stay/team/${staff.id}`, { cookie: biz.manager, body: { branchIds: [airport] } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);

    const mine = await api("GET", "/me/products/stay", { cookie: staff.cookie });
    expect(mine.body.branches.map((b: any) => b.id)).toEqual([airport]);
    expect((await api("GET", "/me/products/stay", { cookie: staff.cookie, headers: { "x-saf-branch": airport } })).status).toBe(200);
    expectError(await api("GET", "/me/products/stay", { cookie: staff.cookie, headers: { "x-saf-branch": main } }), 403, "BRANCH_ACCESS_DENIED");

    // The owner is never branch-restricted.
    expectError(await api("PATCH", `/stay/team/${(await api("GET", "/me", { cookie: biz.manager })).body.user.id}`, {
      cookie: biz.manager, body: { branchIds: [airport] },
    }), 400);
  });
});
