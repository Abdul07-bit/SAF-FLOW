import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { currentBusinessDate } from "@/lib/business-day";
import { addDays, dateOnly, type ISODate } from "@/lib/dates";
import { withTenant } from "@/server/db";
import { checkRestaurant } from "@/server/core/payables-alerts";
import { setWhatsAppTemplateSender, type TemplateMessage } from "@/server/core/whatsapp";
import { api, createBusiness, createStaff, expectError } from "../helpers";
import { TEST_ENV } from "../env";

const today: ISODate = currentBusinessDate({ openingTime: "09:00", closingTime: "23:00" });
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const saved = { ...process.env };
afterEach(() => {
  setWhatsAppTemplateSender(null);
  for (const k of ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_PAYABLES_TEMPLATE"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function restaurant() {
  return createBusiness([{ productCode: "dine", tier: "GROWTH" }]);
}

async function supplier(cookie: string, body: Record<string, unknown> = {}) {
  const r = await api("POST", "/dine/payables/suppliers", { cookie, body: { name: `Supplier ${randomUUID().slice(0, 6)}`, category: "CHICKEN", ...body } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; name: string };
}

function buy(cookie: string, supplierId: string, o: { qty?: string | number; rate?: number; paid?: number; date?: ISODate; dueDate?: ISODate | null; clientRef?: string; product?: string } = {}) {
  return api("POST", "/dine/payables/purchases", {
    cookie,
    body: {
      supplierId, billDate: o.date, dueDate: o.dueDate, clientRef: o.clientRef,
      items: [{ productName: o.product ?? "Chicken", quantity: o.qty ?? "20", unit: "KG", rate: o.rate ?? 22_000 }],
      ...(o.paid ? { amountPaid: o.paid, paymentMethod: "CASH" } : {}),
    },
  });
}

const pay = (cookie: string, supplierId: string, amount: number, extra: Record<string, unknown> = {}) =>
  api("POST", "/dine/payables/payments", { cookie, body: { supplierId, amount, method: "UPI", ...extra } });

async function account(cookie: string, id: string) {
  const r = await api("GET", `/dine/payables/suppliers/${id}`, { cookie });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { account: { balance: number; overdue: number; purchases: number; paid: number }; openBills: { id: string; due: number }[] };
}

async function ledger(cookie: string, id: string, q = "") {
  const r = await api("GET", `/dine/payables/suppliers/${id}/ledger${q}`, { cookie });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { opening: number; closing: number; totals: { increase: number; decrease: number }; entries: { type: string; increase: number; decrease: number; balance: number; date: string }[] };
}

const bill = async (cookie: string, id: string) => (await api("GET", `/dine/payables/purchases/${id}`, { cookie })).body;

describe("Supplier credit & payables", () => {
  it("records unpaid, partly paid and fully paid purchases; the ledger matches the example in the brief", async () => {
    const biz = await restaurant();
    const abc = await supplier(biz.manager, { name: "ABC Chicken Centre", businessName: "ABC Poultry Pvt Ltd", phone: "9876500001", whatsapp: "9876500001", paymentTermsDays: 7 });

    // 1. Fully unpaid: 20 KG x Rs 220 = Rs 4,400 on credit, due after the supplier's 7 days.
    const d0 = addDays(today, -2);
    const a = await buy(biz.manager, abc.id, { date: d0 });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({ total: 440_000, due: 440_000, paidAtPurchase: 0, displayStatus: "UNPAID", dueDate: addDays(d0, 7), number: expect.stringMatching(/^SP-\d+$/) });
    expect(a.body.items[0]).toMatchObject({ productName: "Chicken", quantity: "20", unit: "KG", rate: 22_000, amount: 440_000 });

    // Partial payment the next day: Rs 1,000 -> Rs 3,400 owed.
    const p1 = await pay(biz.manager, abc.id, 100_000, { paymentDate: addDays(today, -1) });
    expect(p1.status, JSON.stringify(p1.body)).toBe(201);
    expect((await bill(biz.manager, a.body.id))).toMatchObject({ due: 340_000, displayStatus: "PARTIALLY_PAID" });

    // New purchase Rs 2,000 and a payment of Rs 2,000 today.
    const b = await buy(biz.manager, abc.id, { qty: "10", rate: 20_000, product: "Chicken legs" });
    expect(b.body.total).toBe(200_000);
    expect((await pay(biz.manager, abc.id, 200_000)).status).toBe(201);

    const l = await ledger(biz.manager, abc.id);
    expect(l.entries.map((e) => [e.type, e.increase, e.decrease, e.balance])).toEqual([
      ["PURCHASE", 440_000, 0, 440_000],
      ["PAYMENT", 0, 100_000, 340_000],
      ["PURCHASE", 200_000, 0, 540_000],
      ["PAYMENT", 0, 200_000, 340_000],
    ]);
    expect(l.closing).toBe(340_000);
    // FIFO: both payments went to the older bill first.
    expect(await bill(biz.manager, a.body.id)).toMatchObject({ due: 140_000, displayStatus: "PARTIALLY_PAID" });
    expect(await bill(biz.manager, b.body.id)).toMatchObject({ due: 200_000, displayStatus: "UNPAID" });

    // 2/3. Fully paid and partly paid at the time of purchase.
    const full = await buy(biz.manager, abc.id, { qty: "1", rate: 50_000, paid: 50_000 });
    expect(full.body).toMatchObject({ total: 50_000, paidAtPurchase: 50_000, due: 0, displayStatus: "PAID" });
    const part = await buy(biz.manager, abc.id, { qty: "2.5", rate: 13_333, paid: 10_000 });
    expect(part.body).toMatchObject({ total: 33_333, paidAtPurchase: 10_000, due: 23_333, displayStatus: "PARTIALLY_PAID" });
    expectError(await buy(biz.manager, abc.id, { qty: "1", rate: 100, paid: 101 }), 400);

    const acc = await account(biz.manager, abc.id);
    expect(acc.account.balance).toBe(340_000 + 23_333);
    expect(acc.account.balance).toBe(acc.openBills.reduce((s, x) => s + x.due, 0));

    // Validation: bad quantities, future dates, a due date before the purchase.
    expectError(await buy(biz.manager, abc.id, { qty: "1.2345" }), 400);
    expectError(await buy(biz.manager, abc.id, { qty: "0" }), 400);
    expectError(await buy(biz.manager, abc.id, { date: addDays(today, 1) }), 400);
    expectError(await buy(biz.manager, abc.id, { dueDate: addDays(today, -1) }), 400);
    expectError(await api("POST", "/dine/payables/purchases", { cookie: biz.manager, body: { supplierId: abc.id, items: [] } }), 400);
  });

  it("multiple bills and payments: explicit allocation, FIFO for the rest, advances, opening balance", async () => {
    const biz = await restaurant();
    // 9. Opening balance: Rs 5,000 owed before using SAF Flow.
    const veg = await supplier(biz.manager, { name: "Fresh Vegetables", category: "VEGETABLES", openingBalance: 500_000, openingBalanceDate: addDays(today, -30) });
    let l = await ledger(biz.manager, veg.id);
    expect(l.entries).toEqual([expect.objectContaining({ type: "OPENING_BALANCE", increase: 500_000, balance: 500_000 })]);

    const b1 = await buy(biz.manager, veg.id, { qty: "10", rate: 10_000, date: addDays(today, -5) }); // Rs 1,000
    const b2 = await buy(biz.manager, veg.id, { qty: "10", rate: 20_000, date: addDays(today, -3) }); // Rs 2,000
    expect((await account(biz.manager, veg.id)).account.balance).toBe(800_000);

    // 6. Pay against an older specific invoice: Rs 1,500 with Rs 1,000 named for b1; the rest goes to the oldest open bill (the opening balance).
    const p = await pay(biz.manager, veg.id, 150_000, { allocations: [{ purchaseId: b1.body.id, amount: 100_000 }] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(await bill(biz.manager, b1.body.id)).toMatchObject({ due: 0, displayStatus: "PAID" });
    const opening = (await api("GET", `/dine/payables/purchases?supplierId=${veg.id}&q=`, { cookie: biz.manager })).body.items.find((x: any) => x.kind === "OPENING_BALANCE");
    expect(opening.due).toBe(450_000);
    // Allocation errors: more than the bill's due, a bill twice, more than the payment.
    expectError(await pay(biz.manager, veg.id, 50_000, { allocations: [{ purchaseId: b1.body.id, amount: 1 }] }), 400);
    expectError(await pay(biz.manager, veg.id, 50_000, { allocations: [{ purchaseId: b2.body.id, amount: 30_000 }, { purchaseId: b2.body.id, amount: 1 }] }), 400);
    expectError(await pay(biz.manager, veg.id, 10_000, { allocations: [{ purchaseId: b2.body.id, amount: 20_000 }] }), 400);

    // 5. Multiple partial payments.
    for (const amt of [100_000, 100_000, 50_000]) expect((await pay(biz.manager, veg.id, amt)).status).toBe(201);
    expect((await account(biz.manager, veg.id)).account.balance).toBe(400_000);

    // Overpayment is refused unless confirmed as an advance.
    expectError(await pay(biz.manager, veg.id, 400_001), 409, "EXCEEDS_BALANCE");
    const adv = await pay(biz.manager, veg.id, 450_000, { allowAdvance: true });
    expect(adv.status, JSON.stringify(adv.body)).toBe(201);
    expect(adv.body.isAdvance).toBe(true);
    let acc = await account(biz.manager, veg.id);
    expect(acc.account.balance).toBe(-50_000);
    expect(acc.openBills).toHaveLength(0);
    const list = await api("GET", "/dine/payables/suppliers?status=advance", { cookie: biz.manager });
    expect(list.body.items.map((x: any) => x.id)).toEqual([veg.id]);

    // The advance settles the next purchase automatically.
    const b3 = await buy(biz.manager, veg.id, { qty: "8", rate: 10_000 }); // Rs 800
    expect(b3.body).toMatchObject({ total: 80_000, due: 30_000, displayStatus: "PARTIALLY_PAID" });
    acc = await account(biz.manager, veg.id);
    expect(acc.account.balance).toBe(30_000);

    // The ledger always reconciles with the bills.
    l = await ledger(biz.manager, veg.id);
    expect(l.closing).toBe(30_000);
    expect(l.totals.increase - l.totals.decrease).toBe(30_000);
    const payments = await api("GET", `/dine/payables/payments?supplierId=${veg.id}`, { cookie: biz.manager });
    expect(payments.body.totalPaid).toBe(150_000 + 250_000 + 450_000);
    expect(payments.body.items.every((x: any) => x.unallocated === 0)).toBe(true);
  });

  it("8. duplicate submissions and simultaneous payments never double count", async () => {
    const biz = await restaurant();
    const s = await supplier(biz.manager);
    const ref = randomUUID();
    const [x, y] = await Promise.all([buy(biz.manager, s.id, { clientRef: ref }), buy(biz.manager, s.id, { clientRef: ref })]);
    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect(x.body.id).toBe(y.body.id);
    expect((await account(biz.manager, s.id)).account.balance).toBe(440_000);

    const payRef = randomUUID();
    const again = await Promise.all([1, 2, 3].map(() => pay(biz.manager, s.id, 100_000, { clientRef: payRef })));
    expect(again.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(again.map((r) => r.body.id)).size).toBe(1);
    expect((await account(biz.manager, s.id)).account.balance).toBe(340_000);

    // Two people paying the whole balance at the same moment: only one succeeds.
    const race = await Promise.all([pay(biz.manager, s.id, 340_000), pay(biz.manager, s.id, 340_000)]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await account(biz.manager, s.id)).account.balance).toBe(0);

    // The same clientRef cannot be reused for another supplier.
    const other = await supplier(biz.manager);
    expectError(await buy(biz.manager, other.id, { clientRef: ref }), 409, "DUPLICATE_REQUEST");
  });

  it("7/8/11. cancellations, returns, reversals and corrections are audited reversals, never edits", async () => {
    const biz = await restaurant();
    const s = await supplier(biz.manager, { name: "Grocery Store", category: "GROCERIES" });
    const wrong = await buy(biz.manager, s.id, { qty: "10", rate: 10_000, paid: 40_000 }); // Rs 1,000, Rs 400 paid
    const good = await buy(biz.manager, s.id, { qty: "5", rate: 10_000 }); // Rs 500
    expect((await account(biz.manager, s.id)).account.balance).toBe(110_000);

    // Amounts cannot be edited through the API...
    expectError(await api("PATCH", `/dine/payables/purchases/${wrong.body.id}`, { cookie: biz.manager, body: { total: 1 } }), 400, "UNKNOWN_FIELDS");
    const patched = await api("PATCH", `/dine/payables/purchases/${wrong.body.id}`, { cookie: biz.manager, body: { invoiceNo: "INV-77", notes: "checked" } });
    expect(patched.body).toMatchObject({ invoiceNo: "INV-77", total: 100_000 });
    // ...or in the database, by any role.
    await expect(withTenant(biz.tenantId, (db) => db.supplierPurchase.update({ where: { id: wrong.body.id }, data: { total: 1 } }))).rejects.toThrow(/SAF_PAYABLES_IMMUTABLE/);
    await expect(withTenant(biz.tenantId, (db) => db.supplierLedgerEntry.deleteMany({ where: { supplierId: s.id } }))).rejects.toThrow();
    await expect(withTenant(biz.tenantId, (db) => db.supplierPurchase.delete({ where: { id: wrong.body.id } }))).rejects.toThrow();

    // 11. Correct a wrong purchase: cancel it (the Rs 400 paid with it moves to the other bill), then re-enter.
    expectError(await api("POST", `/dine/payables/purchases/${wrong.body.id}/cancel`, { cookie: biz.manager, body: { reason: "" } }), 400);
    const c = await api("POST", `/dine/payables/purchases/${wrong.body.id}/cancel`, { cookie: biz.manager, body: { reason: "Entered 10 kg instead of 1 kg" } });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.displayStatus).toBe("CANCELLED");
    expectError(await api("POST", `/dine/payables/purchases/${wrong.body.id}/cancel`, { cookie: biz.manager, body: { reason: "again" } }), 409, "ALREADY_CANCELLED");
    expect(await bill(biz.manager, good.body.id)).toMatchObject({ due: 10_000 });
    expect((await account(biz.manager, s.id)).account.balance).toBe(10_000);
    const fixed = await buy(biz.manager, s.id, { qty: "1", rate: 10_000 });
    expect((await account(biz.manager, s.id)).account.balance).toBe(20_000);
    expect((await bill(biz.manager, wrong.body.id)).allocations.every((x: any) => x.voidedAt)).toBe(true);

    // Cancel and also reverse the payment made with it.
    const third = await buy(biz.manager, s.id, { qty: "3", rate: 10_000, paid: 30_000 });
    const c2 = await api("POST", `/dine/payables/purchases/${third.body.id}/cancel`, { cookie: biz.manager, body: { reason: "Duplicate entry", reversePayments: true } });
    expect(c2.status, JSON.stringify(c2.body)).toBe(200);
    expect((await account(biz.manager, s.id)).account.balance).toBe(20_000);

    // 7. Goods returned on a bill: Rs 50 credit against it.
    const ret = await api("POST", "/dine/payables/adjustments", { cookie: biz.manager, body: { supplierId: s.id, direction: "DECREASE", kind: "RETURN", amount: 5_000, purchaseId: fixed.body.id, reason: "Half a kilo spoilt" } });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    expect(await bill(biz.manager, fixed.body.id)).toMatchObject({ due: 5_000 });
    expect((await account(biz.manager, s.id)).account.balance).toBe(15_000);
    expectError(await api("POST", "/dine/payables/adjustments", { cookie: biz.manager, body: { supplierId: s.id, direction: "DECREASE", kind: "DISCOUNT", amount: 15_001, reason: "too much" } }), 409, "EXCEEDS_BALANCE");
    const extra = await api("POST", "/dine/payables/adjustments", { cookie: biz.manager, body: { supplierId: s.id, direction: "INCREASE", kind: "CORRECTION", amount: 2_000, reason: "Delivery charge missed" } });
    expect(extra.status).toBe(201);
    expect((await account(biz.manager, s.id)).account.balance).toBe(17_000);

    // Wrong payment: reverse it; the bills it settled are owed again.
    const p = await pay(biz.manager, s.id, 10_000);
    expect((await account(biz.manager, s.id)).account.balance).toBe(7_000);
    const rev = await api("POST", `/dine/payables/payments/${p.body.id}/reverse`, { cookie: biz.manager, body: { reason: "Paid from the wrong account" } });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expectError(await api("POST", `/dine/payables/payments/${p.body.id}/reverse`, { cookie: biz.manager, body: { reason: "again" } }), 409, "ALREADY_REVERSED");
    expect((await account(biz.manager, s.id)).account.balance).toBe(17_000);
    const revAdj = await api("POST", `/dine/payables/adjustments/${ret.body.id}/reverse`, { cookie: biz.manager, body: { reason: "Supplier refused the return" } });
    expect(revAdj.status).toBe(200);
    expect((await account(biz.manager, s.id)).account.balance).toBe(22_000);

    // Every step is in the ledger and the running balance matches.
    const l = await ledger(biz.manager, s.id);
    expect(l.entries.map((e) => e.type)).toEqual(expect.arrayContaining(["PURCHASE_CANCELLED", "PAYMENT_REVERSED", "ADJUSTMENT_DECREASE", "ADJUSTMENT_INCREASE", "ADJUSTMENT_REVERSED"]));
    expect(l.closing).toBe(22_000);
    const open = (await account(biz.manager, s.id)).openBills.reduce((a, x) => a + x.due, 0);
    expect(open + 2_000).toBe(22_000); // open bills + the unbilled delivery charge
  });

  it("10/12. overdue bills, supplier deactivation, alerts and the dashboard", async () => {
    const biz = await restaurant();
    const waiter = await createStaff(biz.manager, "dine", "w1", [{ product: "dine", roleCode: "waiter" }]);
    const s = await supplier(biz.manager, { name: "Meat Mart", category: "MEAT", creditLimit: 500_000 });
    const late = await buy(biz.manager, s.id, { qty: "10", rate: 30_000, date: addDays(today, -10), dueDate: addDays(today, -3) }); // Rs 3,000 overdue
    expect(late.body).toMatchObject({ displayStatus: "OVERDUE", daysOverdue: 3 });
    await buy(biz.manager, s.id, { qty: "10", rate: 30_000 }); // Rs 3,000 more: over the Rs 5,000 limit

    const sum = await api("GET", "/dine/payables/summary", { cookie: biz.manager });
    expect(sum.status, JSON.stringify(sum.body)).toBe(200);
    expect(sum.body).toMatchObject({ totalOutstanding: 600_000, overdueAmount: 300_000, overdueBills: 1, activeSuppliers: 1, newCreditToday: 300_000, newCreditBillsToday: 1 });
    expect(sum.body.overLimit.map((x: any) => x.id)).toEqual([s.id]);
    expect(sum.body.suppliers[0]).toMatchObject({ name: "Meat Mart", purchases: 600_000, paid: 0, balance: 600_000, overdue: 300_000 });

    const alerts = await api("GET", "/dine/payables/alerts", { cookie: biz.manager });
    expect(alerts.body.overdueBills.map((b: any) => b.id)).toEqual([late.body.id]);
    expect(alerts.body.overLimit.map((x: any) => x.id)).toEqual([s.id]);

    // Notifications go to people who can see supplier credit, not to every staff member.
    const mine = await api("GET", "/me/notifications", { cookie: biz.manager });
    expect(mine.body.items.map((n: any) => n.title)).toEqual(expect.arrayContaining([expect.stringContaining("Credit purchase from Meat Mart"), "Meat Mart is over its credit limit"]));
    const waiters = await api("GET", "/me/notifications", { cookie: waiter.cookie });
    expect(waiters.body.items.some((n: any) => String(n.kind).startsWith("SUPPLIER_"))).toBe(false);

    // 12. Deactivate with a balance: no new purchases, payments still allowed, still in reports.
    expect((await api("PATCH", `/dine/payables/suppliers/${s.id}`, { cookie: biz.manager, body: { isActive: false } })).status).toBe(200);
    expectError(await buy(biz.manager, s.id), 409, "SUPPLIER_INACTIVE");
    expect((await pay(biz.manager, s.id, 100_000)).status).toBe(201);
    const inactive = await api("GET", "/dine/payables/suppliers?status=inactive", { cookie: biz.manager });
    expect(inactive.body.items[0]).toMatchObject({ id: s.id, balance: 500_000, isActive: false });
    const report = await api("GET", "/dine/payables/reports?period=month", { cookie: biz.manager });
    expect(report.body.suppliers.map((x: any) => x.id)).toContain(s.id);

    // End-of-day check: overdue alert once, summaries, WhatsApp honestly reported as not configured.
    const first = await checkRestaurant(biz.tenantId, today);
    expect(first!.map((x) => x.title)).toEqual(expect.arrayContaining(["Payment overdue: Meat Mart", "Daily supplier credit summary"]));
    expect(await checkRestaurant(biz.tenantId, today)).toBeNull(); // once per business day
    const history = await api("GET", "/dine/payables/alerts", { cookie: biz.manager });
    const overdueAlert = history.body.history.find((h: any) => h.kind === "OVERDUE");
    expect(overdueAlert.channels).toEqual({ inApp: "SENT", whatsapp: "OFF" });
    // The same bill is not reported as newly overdue the next day.
    const next = await checkRestaurant(biz.tenantId, addDays(today, 1));
    expect(next!.some((x) => x.title.startsWith("Payment overdue"))).toBe(false);
  });

  it("WhatsApp alerts go out only when the server and the business have it set up", async () => {
    const biz = await restaurant();
    const s = await supplier(biz.manager);
    await buy(biz.manager, s.id, { date: addDays(today, -5), dueDate: addDays(today, -1) });
    const sent: TemplateMessage[] = [];
    setWhatsAppTemplateSender(async (m) => { sent.push(m); return { messageId: "wamid.test" }; });

    const settings = await api("PUT", "/dine/payables/settings", { cookie: biz.manager, body: { whatsappEnabled: true, whatsappNumber: "+91 98765 43210" } });
    expect(settings.body).toMatchObject({ whatsappEnabled: true, whatsappReady: false });
    const r1 = await checkRestaurant(biz.tenantId, addDays(today, -1));
    expect(r1!.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(0);
    const h1 = (await api("GET", "/dine/payables/alerts", { cookie: biz.manager })).body.history;
    expect(h1.find((h: any) => h.kind === "OVERDUE").channels.whatsapp).toBe("NOT_CONFIGURED");

    process.env.WHATSAPP_TOKEN = "test-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
    process.env.WHATSAPP_PAYABLES_TEMPLATE = "supplier_credit_alert";
    expect((await api("GET", "/dine/payables/settings", { cookie: biz.manager })).body.whatsappReady).toBe(true);
    await checkRestaurant(biz.tenantId, today);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]).toMatchObject({ to: "919876543210", template: "supplier_credit_alert" });
    expect(sent[0].params).toHaveLength(3);
  });

  it("reports: day / week / month / custom reconcile, compare with the previous period, and closed days never change", async () => {
    const biz = await restaurant();
    const a = await supplier(biz.manager, { name: "ABC Chicken", openingBalance: 100_000, openingBalanceDate: addDays(today, -40) });
    const b = await supplier(biz.manager, { name: "Dairy Farm", category: "DAIRY" });
    const y = addDays(today, -1);
    const yesterdays = await buy(biz.manager, a.id, { qty: "5", rate: 20_000, date: y }); // Rs 1,000 yesterday
    await pay(biz.manager, a.id, 50_000, { paymentDate: y });
    await buy(biz.manager, b.id, { qty: "10", rate: 5_000, paid: 20_000 }); // Rs 500 today, Rs 200 paid
    await pay(biz.manager, a.id, 30_000);

    const day = await api("GET", "/dine/payables/reports?period=day", { cookie: biz.manager });
    expect(day.status, JSON.stringify(day.body)).toBe(200);
    expect(day.body).toMatchObject({ from: today, to: today, opening: 150_000, closing: 150_000 + 50_000 - 20_000 - 30_000, newCredit: 30_000, reconciled: true });
    expect(day.body.flow).toMatchObject({ purchases: 50_000, payments: 50_000 });
    expect(day.body.previous).toMatchObject({ from: y, to: y, purchases: 100_000, payments: 50_000, closing: 150_000 });
    expect(day.body.suppliers.map((s: any) => s.name)).toEqual(["ABC Chicken", "Dairy Farm"]);
    expect(day.body.highest).toMatchObject({ name: "ABC Chicken", closing: 120_000 });
    expect(day.body.suppliers.reduce((t: number, s: any) => t + s.closing, 0)).toBe(day.body.closing);

    const before = await api("GET", `/dine/payables/reports?period=day&date=${y}`, { cookie: biz.manager });
    expect(before.body).toMatchObject({ opening: 100_000, closing: 150_000 });
    // Cancelling yesterday's purchase today shows up today; yesterday's report stays as it was.
    await api("POST", `/dine/payables/purchases/${yesterdays.body.id}/cancel`, { cookie: biz.manager, body: { reason: "Wrong supplier" } });
    const after = await api("GET", `/dine/payables/reports?period=day&date=${y}`, { cookie: biz.manager });
    expect(after.body).toMatchObject({ opening: 100_000, closing: 150_000 });
    const dayAfter = await api("GET", "/dine/payables/reports?period=day", { cookie: biz.manager });
    expect(dayAfter.body.flow.cancellations).toBe(100_000);
    expect(dayAfter.body.closing).toBe(50_000);
    expect(dayAfter.body.reconciled).toBe(true);

    for (const period of ["week", "month"]) {
      const r = await api("GET", `/dine/payables/reports?period=${period}`, { cookie: biz.manager });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.reconciled).toBe(true);
      expect(r.body.opening + r.body.flow.increase - r.body.flow.decrease).toBe(r.body.closing);
      expect(r.body.closing).toBe(50_000);
    }
    const custom = await api("GET", `/dine/payables/reports?period=custom&from=${addDays(today, -45)}&to=${today}`, { cookie: biz.manager });
    expect(custom.body).toMatchObject({ opening: 0, closing: 50_000, reconciled: true });
    expect(custom.body.flow.openingBalances).toBe(100_000);
    expectError(await api("GET", "/dine/payables/reports?period=custom", { cookie: biz.manager }), 400);
    expectError(await api("GET", `/dine/payables/reports?period=custom&from=${today}&to=${y}`, { cookie: biz.manager }), 400, "BAD_RANGE");

    const pdf = await api("GET", "/dine/payables/reports/pdf?period=week", { cookie: biz.manager });
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(pdf.body).subarray(0, 4).toString()).toBe("%PDF");
    const csv = await api("GET", "/dine/payables/reports/csv?period=month", { cookie: biz.manager });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.body).toContain("ABC Chicken");
    expect(csv.body).toContain("Owed at end,500.00");
    const lcsv = await api("GET", `/dine/payables/suppliers/${a.id}/ledger?format=csv`, { cookie: biz.manager });
    expect(lcsv.body).toContain("Opening balance");

    // Ledger for a date range starts from the balance brought forward.
    const l = await ledger(biz.manager, a.id, `?from=${today}&to=${today}`);
    expect(l.opening).toBe(150_000);
    expect(l.closing).toBe(l.opening + l.totals.increase - l.totals.decrease);
  });

  it("tenant isolation, permissions and plans", async () => {
    const a = await restaurant();
    const b = await restaurant();
    const s = await supplier(a.manager, { name: "Private Supplier" });
    const p = await buy(a.manager, s.id);

    // Another restaurant sees nothing and can change nothing.
    expect((await api("GET", "/dine/payables/suppliers?status=all", { cookie: b.manager })).body.items).toEqual([]);
    expectError(await api("GET", `/dine/payables/suppliers/${s.id}`, { cookie: b.manager }), 404);
    expectError(await api("GET", `/dine/payables/purchases/${p.body.id}`, { cookie: b.manager }), 404);
    expectError(await api("GET", `/dine/payables/suppliers/${s.id}/ledger`, { cookie: b.manager }), 404);
    expectError(await pay(b.manager, s.id, 100), 404);
    expectError(await buy(b.manager, s.id), 404);
    expectError(await api("POST", `/dine/payables/purchases/${p.body.id}/cancel`, { cookie: b.manager, body: { reason: "attack" } }), 404);
    const own = await supplier(b.manager);
    expectError(await pay(b.manager, own.id, 100, { allowAdvance: true, allocations: [{ purchaseId: p.body.id, amount: 100 }] }), 400);
    expect((await api("GET", "/dine/payables/reports?period=month", { cookie: b.manager })).body.closing).toBe(0);
    // Row-level security below the API.
    expect(await withTenant(b.tenantId, (db) => db.supplierLedgerEntry.count({ where: { supplierId: s.id } }))).toBe(0);
    await expect(withTenant(b.tenantId, (db) => db.supplierLedgerEntry.create({
      data: { tenantId: a.tenantId, supplierId: s.id, entryDate: dateOnly(today), entryType: "PAYMENT", decrease: 1, description: "smuggled" },
    }))).rejects.toThrow();
    await expect(withTenant(b.tenantId, (db) => db.supplierPurchase.create({
      data: { tenantId: b.tenantId, supplierId: s.id, billNo: 999_999, billDate: dateOnly(today), total: 1 },
    }))).rejects.toThrow(/SAF_CROSS_TENANT_REF/);

    // Roles: waiters and cashiers have no access; only managers (and owners) do.
    const waiter = await createStaff(a.manager, "dine", "w9", [{ product: "dine", roleCode: "waiter" }]);
    const cashier = await createStaff(a.manager, "dine", "c9", [{ product: "dine", roleCode: "cashier" }]);
    for (const c of [waiter.cookie, cashier.cookie]) {
      expectError(await api("GET", "/dine/payables/summary", { cookie: c }), 403, "PERMISSION_DENIED");
      expectError(await pay(c, s.id, 100), 403, "PERMISSION_DENIED");
    }
    expectError(await api("GET", "/dine/payables/summary"), 401);
    expectError(await api("POST", "/dine/payables/payments", { cookie: a.manager, body: { supplierId: s.id, amount: 1, method: "CASH" }, csrf: false }), 403, "CSRF_REJECTED");

    // Basic plan: not included.
    const basic = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    expectError(await api("GET", "/dine/payables/summary", { cookie: basic.manager }), 403, "FEATURE_NOT_IN_PLAN");
  });

  it("the database itself refuses over-settlement and rewrites; the scheduled job runs the check", async () => {
    const biz = await restaurant();
    const s = await supplier(biz.manager);
    const b = await buy(biz.manager, s.id, { qty: "1", rate: 10_000 });
    const p = await pay(biz.manager, s.id, 10_000);
    const alloc = (amount: number) => withTenant(biz.tenantId, (db) => db.supplierPaymentAllocation.create({
      data: { tenantId: biz.tenantId, supplierId: s.id, purchaseId: b.body.id, paymentId: p.body.id, amount },
    }));
    // Bill and payment are both fully used: even one more paisa is refused below the API.
    await expect(alloc(1)).rejects.toThrow(/SAF_ALLOCATION_INVALID/);
    await expect(withTenant(biz.tenantId, (db) => db.supplierPaymentAllocation.updateMany({ where: { paymentId: p.body.id }, data: { amount: 1 } }))).rejects.toThrow(/SAF_PAYABLES_IMMUTABLE/);
    await expect(withTenant(biz.tenantId, (db) => db.supplierPayment.update({ where: { id: p.body.id }, data: { amount: 1 } }))).rejects.toThrow(/SAF_PAYABLES_IMMUTABLE/);
    await api("POST", `/dine/payables/purchases/${b.body.id}/cancel`, { cookie: biz.manager, body: { reason: "test" } });
    await expect(withTenant(biz.tenantId, (db) => db.supplierPurchase.update({ where: { id: b.body.id }, data: { status: "ACTIVE", cancelledAt: null } }))).rejects.toThrow(/SAF_PAYABLES_IMMUTABLE/);
    await expect(alloc(1)).rejects.toThrow(/SAF_ALLOCATION_INVALID/); // cancelled bill
    expect((await account(biz.manager, s.id)).account.balance).toBe(-10_000);

    const job = await api("POST", "/jobs/daily-reports", { headers: { "x-cron-secret": TEST_ENV.CRON_SECRET } });
    expect(job.status, JSON.stringify(job.body)).toBe(200);
    expect(job.body.supplierCredit).toMatchObject({ due: expect.any(Number), failed: 0 });
  });

  it("bill photos are private; received stock purchase orders become supplier bills when linked", async () => {
    const biz = await restaurant();
    const s = await supplier(biz.manager, { name: "Agro Traders", category: "GROCERIES" });
    const p = await buy(biz.manager, s.id);
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array(PNG_1PX)], "bill.png", { type: "image/png" }));
    const up = await api("POST", `/dine/payables/purchases/${p.body.id}/attachment`, { cookie: biz.manager, body: fd });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.url).toMatch(/\/payables\/.+\?exp=\d+&sig=/);
    expect((await api("GET", up.body.url.replace(/^\/api/, ""))).status).toBe(200);
    expectError(await api("GET", up.body.url.replace(/^\/api/, "").replace(/\?.*$/, "")), 404); // no signature, no file
    const bad = new FormData();
    bad.append("file", new File([new TextEncoder().encode("<svg onload=alert(1)>")], "x.png", { type: "image/png" }));
    expectError(await api("POST", `/dine/payables/purchases/${p.body.id}/attachment`, { cookie: biz.manager, body: bad }), 400);

    // Inventory link: off by default, so a received order does not create a bill...
    const rice = await api("POST", "/dine/stock-items", { cookie: biz.manager, body: { name: "Rice", kind: "INGREDIENT", unit: "kg", quantity: 0, reorderLevel: 1, costPerUnit: 5000 } });
    const po1 = await api("POST", "/dine/purchases", { cookie: biz.manager, body: { supplierId: s.id, receiveNow: true, items: [{ stockItemId: rice.body.id, quantity: 25, unitCost: 5_000 }] } });
    expect(po1.status, JSON.stringify(po1.body)).toBe(201);
    expect((await account(biz.manager, s.id)).account.balance).toBe(440_000);
    // ...and once linked, each received order becomes exactly one unpaid bill.
    await api("PUT", "/dine/payables/settings", { cookie: biz.manager, body: { linkStockPurchases: true } });
    const po2 = await api("POST", "/dine/purchases", { cookie: biz.manager, body: { supplierId: s.id, items: [{ stockItemId: rice.body.id, quantity: 10.5, unitCost: 5_000 }] } });
    expect((await api("POST", `/dine/purchases/${po2.body.id}/receive`, { cookie: biz.manager })).status).toBe(200);
    expectError(await api("POST", `/dine/purchases/${po2.body.id}/receive`, { cookie: biz.manager }), 409);
    const bills = await api("GET", `/dine/payables/purchases?supplierId=${s.id}`, { cookie: biz.manager });
    const linked = bills.body.items.filter((x: any) => x.dinePurchaseId);
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ dinePurchaseId: po2.body.id, total: 52_500, displayStatus: "UNPAID" });
    expect(linked[0].items[0]).toMatchObject({ productName: "Rice", quantity: "10.5", unit: "KG" });
    expect((await account(biz.manager, s.id)).account.balance).toBe(440_000 + 52_500);
    // The existing purchase screens still work as before.
    expect((await api("GET", "/dine/purchases", { cookie: biz.manager })).status).toBe(200);
  });
});
