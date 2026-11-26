import { afterEach, describe, expect, it } from "vitest";
import { currentBusinessDate } from "@/lib/business-day";
import { addDays } from "@/lib/dates";
import { setWhatsAppSender, type ReportMessage } from "@/server/core/whatsapp";
import { api, createBusiness, createStaff, expectError } from "../helpers";
import { TEST_ENV } from "../env";

afterEach(() => setWhatsAppSender(null));

async function billProduct(cookie: string) {
  const p = await api("POST", "/bill/products", { cookie, body: { name: "Tea powder 250g", sku: `TEA-${Date.now()}`, price: 10000, costPrice: 7000, taxRate: 0, reorderLevel: 1, openingStock: 50 } });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  return p.body;
}

async function dineMenu(cookie: string) {
  const cat = await api("POST", "/dine/menu-categories", { cookie, body: { name: "Mains" } });
  const dosa = await api("POST", "/dine/menu-items", { cookie, body: { name: "Masala dosa", categoryId: cat.body.id, price: 12000, taxRate: 0 } });
  expect(dosa.status, JSON.stringify(dosa.body)).toBe(201);
  return dosa.body;
}

describe("Day book, daily numbers and expenses", () => {
  it("Bill (Basic): bill numbers restart per day, expenses land on the business day, day book totals any range", async () => {
    const biz = await createBusiness([{ productCode: "bill", tier: "BASIC" }]);
    const tea = await billProduct(biz.manager);
    const cashier = await createStaff(biz.manager, "bill", "c1", [{ product: "bill", roleCode: "cashier" }]);
    const today = currentBusinessDate({ openingTime: "09:00", closingTime: "23:00" });

    const sell = () => api("POST", "/bill/sales", { cookie: cashier.cookie, body: { items: [{ productId: tea.id, qty: 1 }], paymentMethod: "CASH", amountPaid: 10000 } });
    const s1 = await sell();
    const s2 = await sell();
    expect(s1.status, JSON.stringify(s1.body)).toBe(201);
    expect([s1.body.dailyNo, s2.body.dailyNo]).toEqual([1, 2]);
    expect(s2.body.saleNo).toBe(s1.body.saleNo + 1);
    expect(s1.body.businessDate.slice(0, 10)).toBe(today);

    // Expenses: manager only; no date = today's business day
    expectError(await api("POST", "/bill/expenses", { cookie: cashier.cookie, body: { category: "TEA_SNACKS", description: "Tea", amount: 5000 } }), 403, "PERMISSION_DENIED");
    const e1 = await api("POST", "/bill/expenses", { cookie: biz.manager, body: { category: "TEA_SNACKS", description: "Tea for staff", amount: 5000 } });
    expect(e1.status, JSON.stringify(e1.body)).toBe(201);
    expect(e1.body.expenseDate.slice(0, 10)).toBe(today);
    const e2 = await api("POST", "/bill/expenses", { cookie: biz.manager, body: { category: "RENT", description: "Shop rent", amount: 300000, expenseDate: addDays(today, -1), method: "UPI" } });
    expect(e2.status, JSON.stringify(e2.body)).toBe(201);

    const day = await api("GET", "/bill/day-book", { cookie: biz.manager });
    expect(day.status, JSON.stringify(day.body)).toBe(200);
    expect(day.body).toMatchObject({ from: today, to: today, countLabel: "Bills" });
    expect(day.body.totals).toMatchObject({ count: 2, sales: 20000, expenses: 5000, net: 15000 });

    const week = await api("GET", `/bill/day-book?from=${addDays(today, -6)}&to=${today}`, { cookie: biz.manager });
    expect(week.body.daily).toHaveLength(7);
    expect(week.body.totals).toMatchObject({ count: 2, sales: 20000, expenses: 305000, net: -285000 });
    expect(week.body.expensesByCategory[0]).toEqual({ category: "RENT", amount: 300000 });

    // Cashier cannot open the day book; Basic plan has no WhatsApp report
    expectError(await api("GET", "/bill/day-book", { cookie: cashier.cookie }), 403, "PERMISSION_DENIED");
    expectError(await api("GET", "/bill/daily-reports", { cookie: biz.manager }), 403, "FEATURE_NOT_IN_PLAN");
    expectError(await api("GET", `/bill/day-book?from=${today}&to=${addDays(today, -1)}`, { cookie: biz.manager }), 400, "BAD_RANGE");

    const pdf = await api("GET", `/bill/day-book/pdf?from=${addDays(today, -6)}&to=${today}`, { cookie: biz.manager });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(pdf.body).subarray(0, 4).toString()).toBe("%PDF");

    // A daily number searches today's bills
    const found = await api("GET", `/bill/sales?from=${today}&to=${today}&q=2`, { cookie: biz.manager });
    expect(found.body.items.map((s: any) => s.id)).toContain(s2.body.id);
  });

  it("Dine (Growth): closing after midnight keeps orders on the previous business day; report goes to WhatsApp once", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "GROWTH" }]);
    const dosa = await dineMenu(biz.manager);

    // Closing time 23:59, at or before the opening time: the shop closes after midnight,
    // so until 23:59 today everything still counts for yesterday.
    const hours = { openingTime: "23:59", closingTime: "23:59" };
    const set = await api("PUT", "/dine/settings", { cookie: biz.manager, body: { ...hours, reportWhatsApp: "+91 98765 43210" } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expectError(await api("PUT", "/dine/settings", { cookie: biz.manager, body: { closingTime: "25:00" } }), 400);
    const bday = currentBusinessDate(hours);

    const order = () => api("POST", "/dine/orders", { cookie: biz.manager, body: { type: "TAKEAWAY", source: "POS", items: [{ menuItemId: dosa.id, qty: 1 }], sendToKitchen: true } });
    const o1 = await order();
    const o2 = await order();
    expect(o1.status, JSON.stringify(o1.body)).toBe(201);
    expect([o1.body.dailyNo, o2.body.dailyNo]).toEqual([1, 2]);
    expect(o1.body.businessDate.slice(0, 10)).toBe(bday);
    expect(o2.body.tickets[0].label).toBe("Takeaway #002");
    for (const o of [o1, o2]) {
      const paid = await api("POST", `/dine/orders/${o.body.id}/settle`, { cookie: biz.manager, body: { paymentMethod: "UPI" } });
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    }
    expect((await api("POST", "/dine/expenses", { cookie: biz.manager, body: { category: "GAS_FUEL", description: "Gas cylinder", amount: 110000 } })).body.expenseDate.slice(0, 10)).toBe(bday);

    const dash = await api("GET", "/dine/dashboard", { cookie: biz.manager });
    expect(dash.body).toMatchObject({ ordersToday: 2, salesToday: 24000 });
    const orders = await api("GET", `/dine/orders?date=${bday}`, { cookie: biz.manager });
    expect(orders.body.items.map((x: any) => x.dailyNo).sort()).toEqual([1, 2]);

    // Staff never see the owner's WhatsApp number
    const waiter = await createStaff(biz.manager, "dine", "w1", [{ product: "dine", roleCode: "waiter" }]);
    expect((await api("GET", "/me/products/dine", { cookie: waiter.cookie })).body.settings.reportWhatsApp).toBeUndefined();
    expect((await api("GET", "/me/products/dine", { cookie: biz.manager })).body.settings.reportWhatsApp).toBe("+91 98765 43210");

    // "Send now" builds the PDF and sends it to the owner
    const sent: ReportMessage[] = [];
    setWhatsAppSender(async (m) => { sent.push(m); return { messageId: "wamid.test" }; });
    const send = await api("POST", "/dine/daily-reports/send", { cookie: biz.manager, body: { date: bday } });
    expect(send.status, JSON.stringify(send.body)).toBe(200);
    expect(send.body).toMatchObject({ status: "SENT", sentTo: "919876543210" });
    expect(sent).toHaveLength(1);
    expect(Buffer.from(sent[0].pdf).subarray(0, 4).toString()).toBe("%PDF");
    expect(sent[0].params[2]).toBe("Rs 240.00");
    expect(sent[0].params[3]).toBe("Rs 1,100.00");

    const history = await api("GET", "/dine/daily-reports", { cookie: biz.manager });
    expect(history.body.items[0]).toMatchObject({ businessDate: bday, status: "SENT", summary: { count: 2, sales: 24000, expenses: 110000 } });

    // The scheduled job needs the secret, and never sends an already-sent day again
    expectError(await api("POST", "/jobs/daily-reports", { headers: { "x-cron-secret": "wrong" } }), 401);
    const run = await api("POST", "/jobs/daily-reports", { headers: { "x-cron-secret": TEST_ENV.CRON_SECRET } });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(sent.filter((m) => m.to === "919876543210" && m.params[1] === sent[0].params[1])).toHaveLength(1);

    // Waiters cannot send reports or read the day book
    expectError(await api("POST", "/dine/daily-reports/send", { cookie: waiter.cookie, body: {} }), 403, "PERMISSION_DENIED");
    expectError(await api("GET", "/dine/day-book", { cookie: waiter.cookie }), 403, "PERMISSION_DENIED");
  });

  it("Stay: expenses keep working through the shared route and feed the day book", async () => {
    const biz = await createBusiness([{ productCode: "stay", tier: "BASIC" }]);
    const e = await api("POST", "/stay/expenses", { cookie: biz.manager, body: { category: "LAUNDRY", description: "Linen wash", amount: 45000 } });
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    const day = await api("GET", "/stay/day-book", { cookie: biz.manager });
    expect(day.body).toMatchObject({ countLabel: "Check-ins" });
    expect(day.body.totals.expenses).toBe(45000);
    const list = await api("GET", "/stay/expenses", { cookie: biz.manager });
    expect(list.body.items).toHaveLength(1);
  });
});
