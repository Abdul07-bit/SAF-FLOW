import { describe, expect, it } from "vitest";
import { addDays, endOfDayIST, istDate, todayIST } from "@/lib/dates";
import { withPlatform } from "@/server/db";
import { api, createBusiness, expectError } from "../helpers";
import { TEST_ENV } from "../env";

async function sub(biz: { code: string; admin: string }, product: string) {
  const r = await api("GET", `/admin/subscriptions?q=${biz.code}`, { cookie: biz.admin });
  return r.body.items.find((s: any) => s.productCode === product);
}
const invoices = async (biz: { tenantId: string; admin: string }) =>
  (await api("GET", `/admin/invoices?tenantId=${biz.tenantId}`, { cookie: biz.admin })).body.items as any[];

describe("free trial -> pause -> setup fee -> free days -> maintenance", () => {
  it("7-day Growth trial; paused after; setup paid gives the plan's free days", async () => {
    const today = todayIST();
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC", billingCycle: "ANNUAL", trial: true }]);

    // Trial: Growth features for 7 days, only the setup fee invoiced.
    let s = await sub(biz, "dine");
    expect(s).toMatchObject({ tier: "GROWTH", state: "ACTIVE", onTrial: true, pendingTier: "BASIC" });
    expect(istDate(new Date(s.currentPeriodEnd))).toBe(addDays(today, 6));
    let inv = await invoices(biz);
    expect(inv.map((i) => i.kind)).toEqual(["SETUP"]);
    expect(inv[0]).toMatchObject({ subtotal: 500000, status: "ISSUED" });
    expect((await api("GET", "/dine/dashboard", { cookie: biz.manager })).status).toBe(200);

    // Trial ends: paused immediately (no grace), billing page still reachable.
    const yesterday = endOfDayIST(addDays(today, -1));
    await withPlatform((db) => db.productSubscription.update({ where: { id: s.id }, data: { currentPeriodEnd: yesterday, trialEndsAt: yesterday } }));
    const paused = await api("GET", "/dine/dashboard", { cookie: biz.manager });
    expectError(paused, 402, "SUBSCRIPTION_EXPIRED");
    expect(paused.body.error.message).toContain("free trial");
    expect((await api("GET", "/dine/subscription", { cookie: biz.manager })).status).toBe(200);

    // The renewal job never bills maintenance before the setup fee is paid.
    await api("POST", "/jobs/renewals", { headers: { "x-cron-secret": TEST_ENV.CRON_SECRET } });
    expect((await invoices(biz)).map((i) => i.kind)).toEqual(["SETUP"]);
    const notes = (await api("GET", "/me/notifications", { cookie: biz.manager })).body.items;
    expect(notes.some((n: any) => n.title.includes("free trial ended"))).toBe(true);

    // Setup fee paid: Basic plan, 15 days free from today, access back.
    const pay = await api("POST", "/admin/payments", { cookie: biz.admin, body: { invoiceId: inv[0].id, method: "UPI", reference: "UTR-TRIAL-1" } });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    s = await sub(biz, "dine");
    expect(s).toMatchObject({ tier: "BASIC", state: "ACTIVE", onTrial: false, pendingTier: null, billingCycle: "ANNUAL" });
    expect(istDate(new Date(s.currentPeriodEnd))).toBe(addDays(today, 14));
    expect((await api("GET", "/dine/dashboard", { cookie: biz.manager })).status).toBe(200);

    // Maintenance is billed for the period after the free days, on the chosen cycle.
    await api("POST", "/jobs/renewals", { headers: { "x-cron-secret": TEST_ENV.CRON_SECRET } });
    inv = await invoices(biz);
    const maint = inv.find((i) => i.kind === "SUBSCRIPTION");
    expect(maint).toMatchObject({ billingCycle: "ANNUAL", subtotal: 600000, status: "ISSUED" });
    expect(istDate(new Date(maint.periodStart))).toBe(addDays(today, 15));
  });

  it("setup paid during the trial keeps the trial days: Growth gets 30 days after it", async () => {
    const today = todayIST();
    const biz = await createBusiness([{ productCode: "bill", tier: "GROWTH", trial: true, markSetupPaid: true }], { paymentMethod: "UPI", paymentReference: "UTR-ONB" });
    const s = await sub(biz, "bill");
    expect(s).toMatchObject({ tier: "GROWTH", onTrial: false, state: "ACTIVE" });
    expect(istDate(new Date(s.currentPeriodEnd))).toBe(addDays(today, 6 + 30));
    const inv = await invoices(biz);
    expect(inv.map((i) => i.kind)).toEqual(["SETUP"]);
    expect(inv[0]).toMatchObject({ subtotal: 1000000, status: "PAID" });
  });

  it("without the trial option, onboarding works as before", async () => {
    const biz = await createBusiness([{ productCode: "stay", tier: "BASIC" }]);
    const s = await sub(biz, "stay");
    expect(s).toMatchObject({ tier: "BASIC", onTrial: false });
    expect((await invoices(biz)).map((i) => i.kind).sort()).toEqual(["SETUP", "SUBSCRIPTION"]);
  });
});
