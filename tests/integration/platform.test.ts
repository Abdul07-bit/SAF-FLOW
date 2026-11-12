import { describe, expect, it } from "vitest";
import { api, adminLogin, createBusiness, createStaff, expectError, login, sessionCookieFrom, STRONG_PASSWORD, uniqueCode } from "../helpers";

describe("authentication", () => {
  it("rejects bad credentials with a generic message and locks after repeated failures", async () => {
    const biz = await createBusiness([{ productCode: "bill", tier: "BASIC" }]);
    for (let i = 0; i < 4; i++) expectError(await api("POST", "/auth/login", { body: { username: biz.managerUsername, password: "wrong-pass-1" } }), 401, "INVALID_CREDENTIALS");
    expectError(await api("POST", "/auth/login", { body: { username: biz.managerUsername, password: "wrong-pass-1" } }), 401, "INVALID_CREDENTIALS");
    // 5th failure locked the account: even the right password is refused now
    expectError(await api("POST", "/auth/login", { body: { username: biz.managerUsername, password: STRONG_PASSWORD } }), 423, "ACCOUNT_LOCKED");
    // Super Admin unlocks
    const admin = await adminLogin();
    const managers = await api("GET", `/admin/managers?q=${biz.code}`, { cookie: admin });
    const id = managers.body.find((m: any) => m.username === biz.managerUsername).id;
    expect((await api("POST", `/admin/users/${id}/unlock`, { cookie: admin })).status).toBe(200);
    expect((await api("POST", "/auth/login", { body: { username: biz.managerUsername, password: STRONG_PASSWORD } })).status).toBe(200);
  });

  it("unknown users get the same error as wrong passwords", async () => {
    expectError(await api("POST", "/auth/login", { body: { username: "NOPE@manager", password: "whatever1" } }), 401, "INVALID_CREDENTIALS");
  });

  it("forces a temporary password to be changed before anything else", async () => {
    const admin = await adminLogin();
    const code = uniqueCode();
    const created = await api("POST", "/admin/businesses", {
      cookie: admin,
      body: { name: "Pw Test", category: "RETAIL", ownerName: "Owner", phone: "9876500000", code, products: [{ productCode: "bill", tier: "BASIC", billingCycle: "MONTHLY" }] },
    });
    const res = await api("POST", "/auth/login", { body: { username: created.body.managerUsername.toLowerCase(), password: created.body.temporaryPassword } });
    expect(res.status).toBe(200);
    expect(res.body.mustChangePassword).toBe(true);
    const cookie = sessionCookieFrom(res);
    expectError(await api("GET", "/bill/dashboard", { cookie }), 403, "PASSWORD_CHANGE_REQUIRED");
    expect((await api("GET", "/me", { cookie })).status).toBe(200);
    expectError(await api("POST", "/auth/change-password", { cookie, body: { currentPassword: created.body.temporaryPassword, newPassword: "short" } }), 400);
    expect((await api("POST", "/auth/change-password", { cookie, body: { currentPassword: created.body.temporaryPassword, newPassword: STRONG_PASSWORD } })).status).toBe(200);
    expect((await api("GET", "/bill/dashboard", { cookie })).status).toBe(200);
  });

  it("logout revokes the session server-side", async () => {
    const biz = await createBusiness([{ productCode: "bill", tier: "BASIC" }]);
    expect((await api("POST", "/auth/logout", { cookie: biz.manager })).status).toBe(200);
    expectError(await api("GET", "/me", { cookie: biz.manager }), 401, "UNAUTHENTICATED");
  });

  it("rejects state-changing requests without the CSRF header", async () => {
    const biz = await createBusiness([{ productCode: "bill", tier: "BASIC" }]);
    expectError(await api("POST", "/bill/categories", { cookie: biz.manager, body: { name: "X" }, csrf: false }), 403, "CSRF_REJECTED");
  });
});

describe("tenant onboarding & multi-product access", () => {
  it("SGV HOTEL: Stay Growth annual + Dine Basic monthly, Bill not subscribed", async () => {
    const admin = await adminLogin();
    const code = uniqueCode("SGV");
    const res = await api("POST", "/admin/businesses", {
      cookie: admin,
      body: {
        name: "SGV HOTEL", category: "HOTEL", ownerName: "S. G. Varma", phone: "9876543210", code,
        products: [
          { productCode: "stay", tier: "GROWTH", billingCycle: "ANNUAL", markSetupPaid: true, markSubscriptionPaid: true },
          { productCode: "dine", tier: "BASIC", billingCycle: "MONTHLY" },
        ],
        paymentMethod: "UPI",
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.managerUsername).toBe(`${code}@manager`);
    expect(res.body.temporaryPassword).toMatch(/^.{12}$/);
    expect(res.body.tenantId).toMatch(/^[0-9a-f-]{36}$/);

    const manager = await login(res.body.managerUsername, res.body.temporaryPassword);
    const me = await api("GET", "/me", { cookie: manager });
    const byCode = Object.fromEntries(me.body.products.map((p: any) => [p.code, p]));
    expect(byCode.stay.subscription).toMatchObject({ tier: "GROWTH", billingCycle: "ANNUAL", state: "ACTIVE" });
    expect(byCode.dine.subscription).toMatchObject({ tier: "BASIC", billingCycle: "MONTHLY", state: "ACTIVE" });
    expect(byCode.bill.subscription).toBeNull();
    expect(byCode.stay.role.code).toBe("manager");

    // The same manager account opens both subscribed products...
    expect((await api("GET", "/stay/dashboard", { cookie: manager })).status).toBe(200);
    expect((await api("GET", "/dine/dashboard", { cookie: manager })).status).toBe(200);
    // ...but not the unsubscribed one
    expectError(await api("GET", "/bill/dashboard", { cookie: manager }), 403, "PRODUCT_NOT_SUBSCRIBED");

    // Invoices: setup + first period per product; Stay ones are paid
    const detail = await api("GET", `/admin/businesses/${res.body.tenantId}`, { cookie: admin });
    const stayInv = detail.body.invoices.filter((i: any) => i.productCode === "stay");
    expect(stayInv.map((i: any) => i.status).sort()).toEqual(["PAID", "PAID"]);
    const setup = stayInv.find((i: any) => i.kind === "SETUP");
    expect(setup.subtotal).toBe(10_000_00);
    expect(setup.taxAmount).toBe(1_800_00);
    const dineInv = detail.body.invoices.filter((i: any) => i.productCode === "dine");
    expect(dineInv.every((i: any) => i.status === "ISSUED")).toBe(true);
  });

  it("rejects duplicate and reserved business codes", async () => {
    const admin = await adminLogin();
    const biz = await createBusiness([{ productCode: "bill", tier: "BASIC" }]);
    const body = { name: "Dup", category: "RETAIL", ownerName: "Owner", phone: "9876500000", products: [{ productCode: "bill", tier: "BASIC", billingCycle: "MONTHLY" }] };
    expectError(await api("POST", "/admin/businesses", { cookie: admin, body: { ...body, code: biz.code } }), 409);
    expectError(await api("POST", "/admin/businesses", { cookie: admin, body: { ...body, code: "SAF" } }), 400, "VALIDATION_ERROR");
  });

  it("tenant users cannot use Super Admin APIs and admins cannot open tenant apps", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "GROWTH" }]);
    expectError(await api("GET", "/admin/overview", { cookie: biz.manager }), 403, "PLATFORM_ONLY");
    expectError(await api("GET", "/dine/dashboard", { cookie: biz.admin }), 403, "TENANT_ONLY");
  });

  it("adds a second product later and grants the manager access automatically", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    expectError(await api("GET", "/bill/dashboard", { cookie: biz.manager }), 403, "PRODUCT_NOT_SUBSCRIBED");
    const add = await api("POST", `/admin/businesses/${biz.tenantId}/products`, { cookie: biz.admin, body: { productCode: "bill", tier: "GROWTH", billingCycle: "ANNUAL" } });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect((await api("GET", "/bill/dashboard", { cookie: biz.manager })).status).toBe(200);
    // Bill Flow bootstraps a default POS counter
    const counters = await api("GET", "/bill/counters", { cookie: biz.manager });
    expect(counters.body.items.map((c: any) => c.name)).toContain("Counter 1");
  });

  it("Super Admin dashboard reports the required metrics", async () => {
    const admin = await adminLogin();
    const o = await api("GET", "/admin/overview", { cookie: admin });
    expect(o.status).toBe(200);
    for (const k of ["totalBusinesses", "activeSubscriptions", "basicCustomers", "growthCustomers", "mrr", "annualPrepaidRevenue", "setupRevenue", "expiredSubscriptions", "upcomingRenewals"])
      expect(o.body).toHaveProperty(k);
    expect(o.body.productCustomers).toHaveProperty("dine");
    expect(o.body.annualPrepaidRevenue).toBeGreaterThanOrEqual(18_000_00);
  });
});

describe("plan entitlements & role permissions (enforced by the API)", () => {
  it("Dine Basic includes waiter, KDS and cashier dashboards but not Growth modules", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    for (const p of ["/dine/waiter/board", "/dine/kitchen/tickets", "/dine/cashier/board", "/dine/menu-items", "/dine/reports/sales"])
      expect((await api("GET", p, { cookie: biz.manager })).status, p).toBe(200);
    for (const p of ["/dine/suppliers", "/dine/purchases", "/dine/wastage", "/dine/analytics", "/dine/recipes", "/dine/staff/employees", "/dine/staff/attendance"])
      expectError(await api("GET", p, { cookie: biz.manager }), 403, "FEATURE_NOT_IN_PLAN");
  });

  it("upgrading to Growth unlocks Growth modules immediately; a tenant override can revoke one", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const subs = await api("GET", `/admin/subscriptions?q=${biz.code}`, { cookie: biz.admin });
    const sub = subs.body.items[0];
    const up = await api("POST", `/admin/subscriptions/${sub.id}/change-plan`, { cookie: biz.admin, body: { tier: "GROWTH", effective: "NOW" } });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.invoice.kind).toBe("PRORATION");
    expect((await api("GET", "/dine/suppliers", { cookie: biz.manager })).status).toBe(200);
    // Per-tenant revoke
    expect((await api("PUT", `/admin/businesses/${biz.tenantId}/features/dine.kds`, { cookie: biz.admin, body: { mode: "revoke" } })).status).toBe(200);
    expectError(await api("GET", "/dine/kitchen/tickets", { cookie: biz.manager }), 403, "FEATURE_NOT_IN_PLAN");
    await api("PUT", `/admin/businesses/${biz.tenantId}/features/dine.kds`, { cookie: biz.admin, body: { mode: "inherit" } });
    expect((await api("GET", "/dine/kitchen/tickets", { cookie: biz.manager })).status).toBe(200);
  });

  it("roles only reach their own screens", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const waiter = await createStaff(biz.manager, "dine", "waiter1", [{ product: "dine", roleCode: "waiter" }]);
    const kitchen = await createStaff(biz.manager, "dine", "chef1", [{ product: "dine", roleCode: "kitchen" }]);
    expect((await api("GET", "/dine/waiter/board", { cookie: waiter.cookie })).status).toBe(200);
    expectError(await api("GET", "/dine/kitchen/tickets", { cookie: waiter.cookie }), 403, "PERMISSION_DENIED");
    expectError(await api("POST", "/dine/tables", { cookie: waiter.cookie, body: { name: "T9" } }), 403, "PERMISSION_DENIED");
    expectError(await api("GET", "/dine/dashboard", { cookie: waiter.cookie }), 403, "PERMISSION_DENIED");
    expect((await api("GET", "/dine/kitchen/tickets", { cookie: kitchen.cookie })).status).toBe(200);
    expectError(await api("GET", "/dine/cashier/board", { cookie: kitchen.cookie }), 403, "PERMISSION_DENIED");
    expectError(await api("GET", "/dine/team", { cookie: waiter.cookie }), 403, "PERMISSION_DENIED");
  });

  it("a Bill-only employee cannot open Stay even when the business has Stay", async () => {
    const biz = await createBusiness([{ productCode: "bill", tier: "BASIC" }, { productCode: "stay", tier: "BASIC" }]);
    const cashier = await createStaff(biz.manager, "bill", "cash1", [{ product: "bill", roleCode: "cashier" }]);
    expect((await api("GET", "/bill/cashier", { cookie: cashier.cookie })).status).toBe(200);
    expectError(await api("GET", "/stay/front-desk", { cookie: cashier.cookie }), 403, "PRODUCT_ACCESS_DENIED");
    // Explicitly authorise a shared account for Stay too
    const upd = await api("PATCH", `/bill/team/${cashier.id}`, { cookie: biz.manager, body: { access: [{ product: "stay", roleCode: "receptionist" }] } });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect((await api("GET", "/stay/front-desk", { cookie: cashier.cookie })).status).toBe(200);
    // Permissions stay separate per product: receptionist in Stay, cashier in Bill
    expectError(await api("GET", "/stay/expenses", { cookie: cashier.cookie }), 403, "PERMISSION_DENIED");
  });

  it("cannot grant access to a product the business has not subscribed to", async () => {
    const biz = await createBusiness([{ productCode: "bill", tier: "BASIC" }]);
    const res = await api("POST", "/bill/team", { cookie: biz.manager, body: { fullName: "X Y", handle: "xy", access: [{ product: "dine", roleCode: "waiter" }] } });
    expectError(res, 403, "PERMISSION_DENIED");
  });

  it("suspension, expiry and grace period gate access", async () => {
    const d = (n: number) => new Date(Date.now() + n * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const biz = await createBusiness([{ productCode: "bill", tier: "BASIC", startDate: d(-40), expiryDate: d(30) }]);
    const subId = (await api("GET", `/admin/subscriptions?q=${biz.code}`, { cookie: biz.admin })).body.items[0].id;
    await api("POST", `/admin/subscriptions/${subId}/status`, { cookie: biz.admin, body: { action: "suspend", reason: "Non-payment" } });
    expectError(await api("GET", "/bill/dashboard", { cookie: biz.manager }), 403, "SUBSCRIPTION_SUSPENDED");
    // The billing page stays reachable so the owner can pay
    expect((await api("GET", "/bill/subscription", { cookie: biz.manager })).status).toBe(200);
    await api("POST", `/admin/subscriptions/${subId}/status`, { cookie: biz.admin, body: { action: "reactivate" } });
    expect((await api("GET", "/bill/dashboard", { cookie: biz.manager })).status).toBe(200);

    // Expired 3 days ago, grace 7 days -> still usable (GRACE)
    expect((await api("PATCH", `/admin/subscriptions/${subId}`, { cookie: biz.admin, body: { expiryDate: d(-3), graceDays: 7 } })).status).toBe(200);
    // Expiry before activation is rejected
    expectError(await api("PATCH", `/admin/subscriptions/${subId}`, { cookie: biz.admin, body: { expiryDate: d(-60) } }), 400);
    const me = await api("GET", "/me", { cookie: biz.manager });
    expect(me.body.products.find((p: any) => p.code === "bill").subscription.state).toBe("GRACE");
    expect((await api("GET", "/bill/dashboard", { cookie: biz.manager })).status).toBe(200);
    // Grace over -> 402
    await api("PATCH", `/admin/subscriptions/${subId}`, { cookie: biz.admin, body: { graceDays: 1 } });
    expectError(await api("GET", "/bill/dashboard", { cookie: biz.manager }), 402, "SUBSCRIPTION_EXPIRED");
  });

  it("suspending the whole business blocks every product", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    await api("POST", `/admin/businesses/${biz.tenantId}/status`, { cookie: biz.admin, body: { status: "SUSPENDED", reason: "test" } });
    // Sessions were revoked on suspension
    expectError(await api("GET", "/dine/dashboard", { cookie: biz.manager }), 401);
    const again = await login(biz.managerUsername, STRONG_PASSWORD);
    expectError(await api("GET", "/dine/dashboard", { cookie: again }), 403, "TENANT_SUSPENDED");
  });

  it("access denials are written to the audit log", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    await api("GET", "/dine/analytics", { cookie: biz.manager });
    const logs = await api("GET", `/admin/audit-logs?tenantId=${biz.tenantId}&action=access_denied`, { cookie: biz.admin });
    expect(logs.body.items.some((l: any) => l.meta?.code === "FEATURE_NOT_IN_PLAN")).toBe(true);
  });
});
