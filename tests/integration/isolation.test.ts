import { describe, expect, it } from "vitest";
import { prisma, withPlatform, withTenant } from "@/server/db";
import { api, createBusiness, expectError } from "../helpers";

describe("tenant isolation", () => {
  it("PostgreSQL RLS hides other tenants' rows and blocks cross-tenant writes", async () => {
    const a = await createBusiness([{ productCode: "bill", tier: "BASIC" }]);
    const b = await createBusiness([{ productCode: "bill", tier: "BASIC" }]);
    await api("POST", "/bill/categories", { cookie: a.manager, body: { name: "A-only" } });
    await api("POST", "/bill/categories", { cookie: b.manager, body: { name: "B-only" } });

    // Inside tenant A's context, even an unfiltered query sees only A's rows.
    const seenByA = await withTenant(a.tenantId, (db) => db.billCategory.findMany());
    expect(seenByA.map((c) => c.name)).toEqual(["A-only"]);
    expect(seenByA.every((c) => c.tenantId === a.tenantId)).toBe(true);

    // Writing a row that claims tenant B from A's context is rejected by the policy.
    await expect(withTenant(a.tenantId, (db) => db.billCategory.create({ data: { tenantId: b.tenantId, name: "smuggled" } }))).rejects.toThrow();

    // Without any tenant context the app role sees nothing at all (fail-closed).
    const mine = { tenantId: { in: [a.tenantId, b.tenantId] } };
    expect(await prisma.billCategory.findMany({ where: mine })).toEqual([]);
    expect(await prisma.billCategory.count()).toBe(0);

    // The platform scope (Super Admin) can see both.
    const both = await withPlatform((db) => db.billCategory.findMany({ where: mine }));
    expect(both.map((c) => c.name).sort()).toEqual(["A-only", "B-only"]);
  });

  it("the runtime database role is not a superuser and cannot bypass RLS", async () => {
    const [role] = await prisma.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("the audit log is append-only for the application role", async () => {
    await expect(withPlatform((db) => db.auditLog.deleteMany({ where: { action: "auth.login" } }))).rejects.toThrow(/permission denied/i);
  });

  it("API: another tenant's record ids are simply not found", async () => {
    const a = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const b = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const cat = await api("POST", "/dine/menu-categories", { cookie: b.manager, body: { name: "Starters" } });
    const table = await api("POST", "/dine/tables", { cookie: b.manager, body: { name: "B1" } });
    expectError(await api("GET", `/dine/tables/${table.body.id}`, { cookie: a.manager }), 404);
    expectError(await api("PATCH", `/dine/menu-categories/${cat.body.id}`, { cookie: a.manager, body: { name: "hijack" } }), 404);
    expectError(await api("DELETE", `/dine/tables/${table.body.id}`, { cookie: a.manager }), 404);
    // Foreign keys bypass RLS in PostgreSQL, so references are validated per tenant
    const item = await api("POST", "/dine/menu-items", { cookie: a.manager, body: { name: "Leak", categoryId: cat.body.id, price: 10000 } });
    expectError(item, 400);
    // Lists never include the other tenant's data
    const list = await api("GET", "/dine/menu-categories", { cookie: a.manager });
    expect(list.body.items.find((c: any) => c.id === cat.body.id)).toBeUndefined();
  });
});
