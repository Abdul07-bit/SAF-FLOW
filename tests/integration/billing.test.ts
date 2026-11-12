import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addDays, addMonths, istDate, todayIST } from "@/lib/dates";
import { withTenant } from "@/server/db";
import { api, createBusiness, expectError } from "../helpers";
import { TEST_ENV } from "../env";

async function subOf(biz: { code: string; admin: string }, product?: string) {
  const r = await api("GET", `/admin/subscriptions?q=${biz.code}`, { cookie: biz.admin });
  return r.body.items.find((s: any) => !product || s.productCode === product);
}

describe("subscriptions & billing", () => {
  it("renewal extends from the day after expiry and records the payment", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC", billingCycle: "MONTHLY" }]);
    const before = await subOf(biz);
    const expiry = istDate(new Date(before.currentPeriodEnd));
    expect(expiry).toBe(addDays(addMonths(todayIST(), 1), -1));

    const r = await api("POST", `/admin/subscriptions/${before.id}/renew`, { cookie: biz.admin, body: { payment: { method: "UPI", reference: "UTR123" } } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.invoice).toMatchObject({ status: "PAID", subtotal: 59900, taxAmount: 10782, total: 70682 });
    const after = await subOf(biz);
    expect(istDate(new Date(after.currentPeriodEnd))).toBe(addDays(addMonths(addDays(expiry, 1), 1), -1));

    const pays = await api("GET", `/admin/payments?tenantId=${biz.tenantId}`, { cookie: biz.admin });
    expect(pays.body.items[0]).toMatchObject({ amount: 70682, method: "UPI", reference: "UTR123" });
  });

  it("manual payments: partial then full settles the invoice", async () => {
    const biz = await createBusiness([{ productCode: "bill", tier: "BASIC" }]);
    const invs = await api("GET", `/admin/invoices?tenantId=${biz.tenantId}&status=ISSUED`, { cookie: biz.admin });
    const setup = invs.body.items.find((i: any) => i.kind === "SETUP");
    expect(setup.total).toBe(590000);
    expect((await api("POST", "/admin/payments", { cookie: biz.admin, body: { invoiceId: setup.id, amount: 200000, method: "CASH" } })).status).toBe(201);
    expectError(await api("POST", "/admin/payments", { cookie: biz.admin, body: { invoiceId: setup.id, amount: 999999999, method: "CASH" } }), 400);
    expect((await api("POST", "/admin/payments", { cookie: biz.admin, body: { invoiceId: setup.id, method: "BANK_TRANSFER" } })).status).toBe(201);
    const detail = await api("GET", `/admin/invoices/${setup.id}`, { cookie: biz.admin });
    expect(detail.body.invoice.status).toBe("PAID");
    expectError(await api("POST", "/admin/payments", { cookie: biz.admin, body: { invoiceId: setup.id, method: "CASH" } }), 409);
  });

  it("the renewal job raises one invoice, reminds once a day and expires lapsed subscriptions", async () => {
    const biz = await createBusiness([{ productCode: "stay", tier: "BASIC", startDate: addDays(todayIST(), -27), expiryDate: addDays(todayIST(), 3) }]);
    const lapsed = await createBusiness([{ productCode: "stay", tier: "BASIC", startDate: addDays(todayIST(), -60), expiryDate: addDays(todayIST(), -20) }]);

    expectError(await api("POST", "/jobs/renewals", { headers: { "x-cron-secret": "wrong" } }), 401);
    const run = await api("POST", "/jobs/renewals", { headers: { "x-cron-secret": TEST_ENV.CRON_SECRET } });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(run.body.invoicesRaised).toBeGreaterThanOrEqual(1);
    expect(run.body.expired).toBeGreaterThanOrEqual(1);

    const invoices = async () => (await api("GET", `/admin/invoices?tenantId=${biz.tenantId}`, { cookie: biz.admin })).body.items.filter((i: any) => i.kind === "SUBSCRIPTION");
    expect(await invoices()).toHaveLength(2); // first period + renewal
    const notes = await api("GET", "/me/notifications", { cookie: biz.manager });
    expect(notes.body.items.filter((n: any) => n.kind === "RENEWAL_REMINDER")).toHaveLength(1);

    // Idempotent: a second run neither duplicates the invoice nor the reminder
    await api("POST", "/jobs/renewals", { headers: { "x-cron-secret": TEST_ENV.CRON_SECRET } });
    expect(await invoices()).toHaveLength(2);
    expect((await api("GET", "/me/notifications", { cookie: biz.manager })).body.items.filter((n: any) => n.kind === "RENEWAL_REMINDER")).toHaveLength(1);

    // The lapsed tenant is now EXPIRED and locked out, but can still see billing
    expect((await subOf(lapsed)).status).toBe("EXPIRED");
    expectError(await api("GET", "/stay/dashboard", { cookie: lapsed.manager }), 402, "SUBSCRIPTION_EXPIRED");
    const billing = await api("GET", "/stay/subscription", { cookie: lapsed.manager });
    expect(billing.status).toBe(200);
    expect(billing.body.plans).toHaveLength(2);
  });

  it("online payment: verified Razorpay signature pays the renewal invoice and extends the subscription", async () => {
    const biz = await createBusiness([{ productCode: "bill", tier: "BASIC", startDate: addDays(todayIST(), -27), expiryDate: addDays(todayIST(), 3), markSetupPaid: true, markSubscriptionPaid: true }]);
    await api("POST", "/jobs/renewals", { headers: { "x-cron-secret": TEST_ENV.CRON_SECRET } });
    const open = (await api("GET", `/admin/invoices?tenantId=${biz.tenantId}&status=ISSUED`, { cookie: biz.admin })).body.items;
    expect(open).toHaveLength(1);
    const inv = open[0];

    // Simulate the pending gateway order that /checkout creates after calling Razorpay
    const orderId = `order_${biz.code}`;
    await withTenant(biz.tenantId, (db) =>
      db.payment.create({ data: { tenantId: biz.tenantId, invoiceId: inv.id, subscriptionId: inv.subscriptionId, amount: inv.total, method: "RAZORPAY", status: "PENDING", gatewayOrderId: orderId } }),
    );
    const paymentId = "pay_test_1";
    expectError(await api("POST", "/bill/billing/razorpay/verify", { cookie: biz.manager, body: { orderId, paymentId, signature: "0".repeat(64) } }), 400, "INVALID_SIGNATURE");
    const signature = createHmac("sha256", TEST_ENV.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
    const ok = await api("POST", "/bill/billing/razorpay/verify", { cookie: biz.manager, body: { orderId, paymentId, signature } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // Replays are harmless
    expect((await api("POST", "/bill/billing/razorpay/verify", { cookie: biz.manager, body: { orderId, paymentId, signature } })).status).toBe(200);

    expect((await api("GET", `/admin/invoices/${inv.id}`, { cookie: biz.admin })).body.invoice.status).toBe("PAID");
    const sub = await subOf(biz);
    expect(istDate(new Date(sub.currentPeriodEnd))).toBe(addDays(addMonths(addDays(todayIST(), 4), 1), -1));
    const pays = await api("GET", `/admin/payments?tenantId=${biz.tenantId}&method=RAZORPAY`, { cookie: biz.admin });
    expect(pays.body.items).toHaveLength(1);
  });

  it("webhook: rejects bad signatures, settles on payment.captured", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const inv = (await api("GET", `/admin/invoices?tenantId=${biz.tenantId}&status=ISSUED`, { cookie: biz.admin })).body.items.find((i: any) => i.kind === "SETUP");
    const orderId = `order_wh_${biz.code}`;
    await withTenant(biz.tenantId, (db) =>
      db.payment.create({ data: { tenantId: biz.tenantId, invoiceId: inv.id, amount: inv.total, method: "RAZORPAY", status: "PENDING", gatewayOrderId: orderId } }),
    );
    const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_wh_1", order_id: orderId } } } });
    const post = (sig: string) =>
      api("POST", "/webhooks/razorpay", { headers: { "x-razorpay-signature": sig, "content-type": "application/json" }, body: JSON.parse(raw) });
    expectError(await post("deadbeef"), 400, "INVALID_SIGNATURE");
    const good = createHmac("sha256", TEST_ENV.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");
    expect((await post(good)).status).toBe(200);
    expect((await api("GET", `/admin/invoices/${inv.id}`, { cookie: biz.admin })).body.invoice.status).toBe("PAID");
  });

  it("pricing is configured per product and never hardcoded", async () => {
    const admin = (await createBusiness([{ productCode: "dine", tier: "BASIC" }])).admin;
    const plans = (await api("GET", "/admin/plans", { cookie: admin })).body;
    const billGrowth = plans.find((p: any) => p.productCode === "bill" && p.tier === "GROWTH");
    const stayGrowth = plans.find((p: any) => p.productCode === "stay" && p.tier === "GROWTH");
    expect(billGrowth).toMatchObject({ monthlyPrice: 179900, annualPrice: 1800000, setupFee: 1000000 });
    try {
      const upd = await api("PATCH", `/admin/plans/${billGrowth.id}`, { cookie: admin, body: { monthlyPrice: 149900, setupFee: 800000 } });
      expect(upd.status, JSON.stringify(upd.body)).toBe(200);
      // Only Bill Flow Growth changed
      const again = (await api("GET", "/admin/plans", { cookie: admin })).body;
      expect(again.find((p: any) => p.id === stayGrowth.id).monthlyPrice).toBe(179900);
      // New subscriptions are invoiced at the new price
      const biz = await createBusiness([{ productCode: "bill", tier: "GROWTH", billingCycle: "MONTHLY" }]);
      const invs = (await api("GET", `/admin/invoices?tenantId=${biz.tenantId}`, { cookie: admin })).body.items;
      expect(invs.find((i: any) => i.kind === "SUBSCRIPTION").subtotal).toBe(149900);
      expect(invs.find((i: any) => i.kind === "SETUP").subtotal).toBe(800000);
      // The tenant-facing plan comparison shows the configured price
      const cmp = await api("GET", "/bill/subscription", { cookie: biz.manager });
      expect(cmp.body.plans.find((p: any) => p.tier === "GROWTH").monthlyPrice).toBe(149900);
    } finally {
      await api("PATCH", `/admin/plans/${billGrowth.id}`, { cookie: admin, body: { monthlyPrice: 179900, setupFee: 1000000 } });
    }
  });

  it("a downgrade scheduled for period end applies at the next renewal", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "GROWTH" }]);
    const sub = await subOf(biz);
    const r = await api("POST", `/admin/subscriptions/${sub.id}/change-plan`, { cookie: biz.admin, body: { tier: "BASIC", effective: "PERIOD_END" } });
    expect(r.body.applied).toBe("PERIOD_END");
    // Still Growth until the period ends
    expect((await api("GET", "/dine/suppliers", { cookie: biz.manager })).status).toBe(200);
    expect((await subOf(biz)).pendingTier).toBe("BASIC");
    const renewed = await api("POST", `/admin/subscriptions/${sub.id}/renew`, { cookie: biz.admin, body: {} });
    expect(renewed.body.invoice.subtotal).toBe(59900);
    expect((await subOf(biz)).tier).toBe("BASIC");
    expectError(await api("GET", "/dine/suppliers", { cookie: biz.manager }), 403, "FEATURE_NOT_IN_PLAN");
  });

  it("tenants can request an upgrade; it reaches Super Admin support", async () => {
    const biz = await createBusiness([{ productCode: "bill", tier: "BASIC" }]);
    const req = await api("POST", "/bill/subscription/request", { cookie: biz.manager, body: { type: "UPGRADE", message: "Need attendance" } });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const tickets = await api("GET", "/admin/support/tickets?status=OPEN", { cookie: biz.admin });
    const t = tickets.body.find((x: any) => x.code === biz.code);
    expect(t.subject).toContain("upgrade");
    await api("POST", `/admin/support/tickets/${t.id}/messages`, { cookie: biz.admin, body: { body: "Upgraded, thank you." } });
    const mine = await api("GET", `/bill/support/tickets/${t.id}`, { cookie: biz.manager });
    expect(mine.body.messages).toHaveLength(2);
    expect(mine.body.messages[1].fromSaf).toBe(true);
    // Requesting an unsubscribed product from the activation page
    const act = await api("POST", "/catalog/stay/request", { cookie: biz.manager, body: { tier: "BASIC", billingCycle: "MONTHLY" } });
    expect(act.status).toBe(201);
    expect((await api("GET", "/catalog/stay", { cookie: biz.manager })).body.plans).toHaveLength(2);
  });
});
