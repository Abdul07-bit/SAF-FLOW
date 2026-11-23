import { describe, expect, it } from "vitest";
import { api, createBusiness, createStaff, expectError } from "../helpers";

async function setupMenu(cookie: string) {
  const cat = await api("POST", "/dine/menu-categories", { cookie, body: { name: "Mains" } });
  const water = await api("POST", "/dine/stock-items", { cookie, body: { name: "Water bottle 1L", kind: "PRODUCT", unit: "bottle", quantity: 20, reorderLevel: 5, costPerUnit: 1000 } });
  const rice = await api("POST", "/dine/stock-items", { cookie, body: { name: "Basmati rice", kind: "INGREDIENT", unit: "kg", quantity: 10, reorderLevel: 2, costPerUnit: 9000 } });
  const biryani = await api("POST", "/dine/menu-items", { cookie, body: { name: "Veg Biryani", categoryId: cat.body.id, price: 22000, taxRate: 500 } });
  const bottle = await api("POST", "/dine/menu-items", { cookie, body: { name: "Mineral water", categoryId: cat.body.id, price: 2000, taxRate: 1800, stockItemId: water.body.id } });
  const table = await api("POST", "/dine/tables", { cookie, body: { name: "T1", seats: 4 } });
  for (const r of [cat, water, rice, biryani, bottle, table]) expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { cat: cat.body, water: water.body, rice: rice.body, biryani: biryani.body, bottle: bottle.body, table: table.body };
}

describe("SAF Dine Flow (Basic)", () => {
  it("waiter -> KOT -> kitchen -> served -> cashier settles; stock & table update; invoice issued", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const m = await setupMenu(biz.manager);
    const waiter = await createStaff(biz.manager, "dine", "w1", [{ product: "dine", roleCode: "waiter" }]);
    const chef = await createStaff(biz.manager, "dine", "k1", [{ product: "dine", roleCode: "kitchen" }]);
    const cashier = await createStaff(biz.manager, "dine", "c1", [{ product: "dine", roleCode: "cashier" }]);

    const order = await api("POST", "/dine/orders", {
      cookie: waiter.cookie,
      body: { tableId: m.table.id, guests: 2, items: [{ menuItemId: m.biryani.id, qty: 2 }, { menuItemId: m.bottle.id, qty: 3 }] },
    });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    // 2 x 220 @5% + 3 x 20 @18%  => 440 + 22 + 60 + 10.80 = 532.80
    expect(order.body.subtotal).toBe(50000);
    expect(order.body.taxTotal).toBe(2200 + 1080);
    expect(order.body.total).toBe(53280);
    expect(order.body.tickets).toHaveLength(1);
    expect(order.body.items.every((i: any) => i.status === "SENT")).toBe(true);

    // Table is occupied; a second order on it is refused
    expectError(await api("POST", "/dine/orders", { cookie: waiter.cookie, body: { tableId: m.table.id, items: [] } }), 409, "TABLE_OCCUPIED");

    // Kitchen display
    const kds = await api("GET", "/dine/kitchen/tickets", { cookie: chef.cookie });
    const kot = kds.body.items.find((k: any) => k.orderId === order.body.id);
    expect(kot.label).toBe("Table T1");
    expect((await api("POST", `/dine/kitchen/tickets/${kot.id}/status`, { cookie: chef.cookie, body: { status: "PREPARING" } })).status).toBe(200);
    expect((await api("POST", `/dine/kitchen/tickets/${kot.id}/status`, { cookie: chef.cookie, body: { status: "READY" } })).status).toBe(200);
    // Kitchen cannot mark served (waiter's job); waiter can
    expectError(await api("POST", `/dine/kitchen/tickets/${kot.id}/status`, { cookie: chef.cookie, body: { status: "SERVED" } }), 403);
    const board = await api("GET", "/dine/waiter/board", { cookie: waiter.cookie });
    expect(board.body.ready.some((r: any) => r.id === kot.id)).toBe(true);
    expect((await api("POST", `/dine/kitchen/tickets/${kot.id}/status`, { cookie: waiter.cookie, body: { status: "SERVED" } })).status).toBe(200);

    // Waiter cannot settle; cashier can, with a discount
    expectError(await api("POST", `/dine/orders/${order.body.id}/settle`, { cookie: waiter.cookie, body: { paymentMethod: "CASH" } }), 403);
    const settled = await api("POST", `/dine/orders/${order.body.id}/settle`, { cookie: cashier.cookie, body: { paymentMethod: "UPI", discount: 5000, customerPhone: "9800000000" } });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.order.status).toBe("PAID");
    expect(settled.body.order.invoiceNo).toMatch(/^DF\/\d{4}-\d{2}\/\d{5}$/);
    expect(settled.body.order.total).toBeLessThan(53280);
    expect(settled.body.whatsappUrl).toContain("https://wa.me/919800000000");

    // Table freed, packaged product stock deducted 1:1 (Basic product management)
    const t = await api("GET", `/dine/tables/${m.table.id}`, { cookie: biz.manager });
    expect(t.body.status).toBe("FREE");
    const water = await api("GET", `/dine/stock-items/${m.water.id}`, { cookie: biz.manager });
    expect(water.body.quantity).toBe(17);
    // Ingredient deduction is a Growth feature: rice unchanged on Basic
    const rice = await api("GET", `/dine/stock-items/${m.rice.id}`, { cookie: biz.manager });
    expect(rice.body.quantity).toBe(10);

    // Public invoice and report
    const pub = await api("GET", `/public/invoice/dine/${settled.body.order.publicToken}`);
    expect(pub.status).toBe(200);
    expect(pub.body.total).toBe(settled.body.order.total);
    const report = await api("GET", "/dine/reports/sales", { cookie: biz.manager });
    expect(report.body.totals.orders).toBe(1);
    expect(report.body.paymentSplit[0].method).toBe("UPI");
  });

  it("QR menu & table ordering: customer orders, waiter accepts, kitchen receives", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const m = await setupMenu(biz.manager);
    const menu = await api("GET", `/public/dine/menu/${m.table.qrToken}`);
    expect(menu.status).toBe(200);
    expect(menu.body.orderingEnabled).toBe(true);
    expect(menu.body.categories[0].items.length).toBe(2);

    const placed = await api("POST", `/public/dine/menu/${m.table.qrToken}/order`, { body: { items: [{ menuItemId: m.biryani.id, qty: 1 }], customerName: "Guest" } });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body.awaitingConfirmation).toBe(true);

    const board = await api("GET", "/dine/waiter/board", { cookie: biz.manager });
    expect(board.body.pendingQr).toBe(1);
    const orderId = board.body.tables.find((t: any) => t.id === m.table.id).order.id;
    expect((await api("POST", `/dine/orders/${orderId}/accept`, { cookie: biz.manager, body: {} })).status).toBe(200);
    const kds = await api("GET", "/dine/kitchen/tickets", { cookie: biz.manager });
    expect(kds.body.items.some((k: any) => k.orderId === orderId)).toBe(true);

    const track = await api("GET", `/public/dine/orders/${placed.body.orderToken}`);
    expect(track.body.items[0].status).toBe("SENT");

    // Sold-out items cannot be ordered
    await api("POST", `/dine/menu-items/${m.biryani.id}/availability`, { cookie: biz.manager, body: { isAvailable: false } });
    expectError(await api("POST", `/public/dine/menu/${m.table.qrToken}/order`, { body: { items: [{ menuItemId: m.biryani.id, qty: 1 }] } }), 409);
  });

  it("split settle: UPI + cash parts are counted separately in collections and reports", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const m = await setupMenu(biz.manager);
    const o = await api("POST", "/dine/orders", { cookie: biz.manager, body: { type: "TAKEAWAY", source: "POS", items: [{ menuItemId: m.biryani.id, qty: 3 }] } });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const total = 3 * 22000 + Math.round(3 * 22000 * 0.05); // 693.00

    // Checked against the total after discount: 400 + 293 is wrong once Rs 10 is taken off
    expectError(await api("POST", `/dine/orders/${o.body.id}/settle`, { cookie: biz.manager, body: { paymentMethod: "SPLIT", discount: 1000, split: [{ method: "UPI", amount: 40000 }, { method: "CASH", amount: total - 40000 }] } }), 400);
    const settled = await api("POST", `/dine/orders/${o.body.id}/settle`, { cookie: biz.manager, body: { paymentMethod: "SPLIT", split: [{ method: "UPI", amount: 40000 }, { method: "CASH", amount: total - 40000 }] } });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.order).toMatchObject({ status: "PAID", paymentMethod: "SPLIT", total });

    const board = await api("GET", "/dine/cashier/board", { cookie: biz.manager });
    expect(board.body.collections).toMatchObject({ total, count: 1, byMethod: { UPI: 40000, CASH: total - 40000 } });
    const report = await api("GET", "/dine/reports/sales", { cookie: biz.manager });
    expect(Object.fromEntries(report.body.paymentSplit.map((x: any) => [x.method, x.amount]))).toEqual({ UPI: 40000, CASH: total - 40000 });
  });

  it("QR menu disappears when the subscription is suspended", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const m = await setupMenu(biz.manager);
    const sub = (await api("GET", `/admin/subscriptions?q=${biz.code}`, { cookie: biz.admin })).body.items[0];
    await api("POST", `/admin/subscriptions/${sub.id}/status`, { cookie: biz.admin, body: { action: "suspend" } });
    expectError(await api("GET", `/public/dine/menu/${m.table.qrToken}`), 404, "MENU_UNAVAILABLE");
  });
});

describe("SAF Dine Flow (Growth)", () => {
  it("recipes auto-deduct ingredients; wastage and purchases move stock", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "GROWTH" }]);
    const m = await setupMenu(biz.manager);
    const recipe = await api("PUT", `/dine/menu-items/${m.biryani.id}/recipe`, { cookie: biz.manager, body: { items: [{ stockItemId: m.rice.id, quantity: 0.25 }] } });
    expect(recipe.status, JSON.stringify(recipe.body)).toBe(200);
    const recipes = await api("GET", "/dine/recipes", { cookie: biz.manager });
    expect(recipes.body.items.find((r: any) => r.id === m.biryani.id).foodCost).toBe(2250);

    const o = await api("POST", "/dine/orders", { cookie: biz.manager, body: { type: "TAKEAWAY", source: "POS", items: [{ menuItemId: m.biryani.id, qty: 4 }] } });
    expect((await api("POST", `/dine/orders/${o.body.id}/settle`, { cookie: biz.manager, body: { paymentMethod: "CASH" } })).status).toBe(200);
    expect((await api("GET", `/dine/stock-items/${m.rice.id}`, { cookie: biz.manager })).body.quantity).toBe(9);

    const w = await api("POST", "/dine/wastage", { cookie: biz.manager, body: { stockItemId: m.rice.id, quantity: 0.5, reason: "Spilled" } });
    expect(w.status).toBe(201);
    expect(w.body.costValue).toBe(4500);
    expect((await api("GET", `/dine/stock-items/${m.rice.id}`, { cookie: biz.manager })).body.quantity).toBe(8.5);

    const sup = await api("POST", "/dine/suppliers", { cookie: biz.manager, body: { name: "Agro Traders", phone: "9811111111" } });
    const po = await api("POST", "/dine/purchases", { cookie: biz.manager, body: { supplierId: sup.body.id, items: [{ stockItemId: m.rice.id, quantity: 5, unitCost: 9500 }] } });
    expect(po.status, JSON.stringify(po.body)).toBe(201);
    expect((await api("POST", `/dine/purchases/${po.body.id}/receive`, { cookie: biz.manager })).status).toBe(200);
    const rice = await api("GET", `/dine/stock-items/${m.rice.id}`, { cookie: biz.manager });
    expect(rice.body.quantity).toBe(13.5);
    expect(rice.body.costPerUnit).toBe(9500);

    const ledger = await api("GET", `/dine/stock/movements?stockItemId=${m.rice.id}`, { cookie: biz.manager });
    expect(ledger.body.items.map((x: any) => x.type).sort()).toEqual(["OPENING", "PURCHASE", "SALE", "WASTAGE"]);
    const analytics = await api("GET", "/dine/analytics", { cookie: biz.manager });
    expect(analytics.status).toBe(200);
    // Food cost is valued at the current ingredient cost (Rs 95/kg after the purchase)
    expect(analytics.body.items[0].foodCost).toBe(9500);
  });
});
