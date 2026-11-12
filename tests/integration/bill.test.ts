import { describe, expect, it } from "vitest";
import { api, createBusiness, createStaff, expectError } from "../helpers";

async function setupCatalog(cookie: string, openingStock = 10) {
  const cat = await api("POST", "/bill/categories", { cookie, body: { name: "Grocery" } });
  const soap = await api("POST", "/bill/products", {
    cookie,
    body: { name: "Bath Soap 100g", sku: "SOAP-100", barcode: "8901234567890", categoryId: cat.body.id, price: 10000, costPrice: 7000, taxRate: 1800, reorderLevel: 3, openingStock },
  });
  expect(soap.status, JSON.stringify(soap.body)).toBe(201);
  return { cat: cat.body, soap: soap.body };
}

describe("SAF Bill Flow (Basic)", () => {
  it("barcode POS sale: server prices, stock deduction, invoice, void, purchase record", async () => {
    const biz = await createBusiness([{ productCode: "bill", tier: "BASIC" }]);
    const { soap } = await setupCatalog(biz.manager);
    const cashier = await createStaff(biz.manager, "bill", "c1", [{ product: "bill", roleCode: "cashier" }]);

    const scan = await api("GET", "/bill/products/lookup?code=8901234567890", { cookie: cashier.cookie });
    expect(scan.body).toMatchObject({ id: soap.id, stock: 10 });
    expectError(await api("GET", "/bill/products/lookup?code=0000", { cookie: cashier.cookie }), 404);

    // 2 x 100 + 18% = 236.00; cash 300 -> change 64
    const sale = await api("POST", "/bill/sales", {
      cookie: cashier.cookie,
      body: { items: [{ productId: soap.id, qty: 2 }], paymentMethod: "CASH", amountPaid: 30000, customer: { name: "Ravi", phone: "9800011111" } },
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body).toMatchObject({ subtotal: 20000, taxTotal: 3600, total: 23600, changeDue: 6400, status: "COMPLETED" });
    expect(sale.body.invoiceNo).toMatch(/^BF\/\d{4}-\d{2}\/\d{5}$/);
    expect(sale.body.customer.name).toBe("Ravi");
    expect((await api("GET", "/bill/products/lookup?code=SOAP-100", { cookie: cashier.cookie })).body.stock).toBe(8);

    // Underpayment and overselling are refused
    expectError(await api("POST", "/bill/sales", { cookie: cashier.cookie, body: { items: [{ productId: soap.id, qty: 1 }], paymentMethod: "CASH", amountPaid: 100 } }), 400);
    expectError(await api("POST", "/bill/sales", { cookie: cashier.cookie, body: { items: [{ productId: soap.id, qty: 9 }], paymentMethod: "UPI" } }), 409, "INSUFFICIENT_STOCK");

    const inv = await api("GET", `/public/invoice/bill/${sale.body.publicToken}`);
    expect(inv.body.total).toBe(23600);

    // Cashier dashboard
    const dash = await api("GET", "/bill/cashier", { cookie: cashier.cookie });
    expect(dash.body.totals).toMatchObject({ count: 1, amount: 23600, cashInDrawer: 23600 });

    // Only a manager may void; stock returns
    expectError(await api("POST", `/bill/sales/${sale.body.id}/void`, { cookie: cashier.cookie, body: { reason: "mistake" } }), 403, "PERMISSION_DENIED");
    expect((await api("POST", `/bill/sales/${sale.body.id}/void`, { cookie: biz.manager, body: { reason: "Customer returned" } })).status).toBe(200);
    expect((await api("GET", "/bill/stock", { cookie: biz.manager })).body.items[0].stock).toBe(10);

    // Basic purchase record receives stock immediately and updates the cost price
    const pur = await api("POST", "/bill/purchases", { cookie: biz.manager, body: { supplierName: "Wholesale Mart", items: [{ productId: soap.id, quantity: 24, unitCost: 6800 }] } });
    expect(pur.status, JSON.stringify(pur.body)).toBe(201);
    expect(pur.body.status).toBe("RECEIVED");
    const stock = await api("GET", "/bill/stock", { cookie: biz.manager });
    expect(stock.body.items[0]).toMatchObject({ stock: 34, costValue: 34 * 6800 });

    // Growth-only modules are refused by the API
    expectError(await api("POST", "/bill/stock/adjust", { cookie: biz.manager, body: { productId: soap.id, quantity: -1, reason: "DAMAGED" } }), 403, "FEATURE_NOT_IN_PLAN");
    expectError(await api("POST", "/bill/purchases", { cookie: biz.manager, body: { status: "ORDERED", items: [{ productId: soap.id, quantity: 1, unitCost: 1 }] } }), 403, "FEATURE_NOT_IN_PLAN");
    for (const p of ["/bill/suppliers", "/bill/analytics", "/bill/stock/valuation", "/bill/staff/employees"])
      expectError(await api("GET", p, { cookie: biz.manager }), 403, "FEATURE_NOT_IN_PLAN");

    const report = await api("GET", "/bill/reports/sales", { cookie: biz.manager });
    expect(report.body.totals).toMatchObject({ bills: 0, voided: 1 });
    const sales = await api("GET", "/bill/sales?status=VOID", { cookie: biz.manager });
    expect(sales.body.items).toHaveLength(1);
  });

  it("two counters cannot both sell the last unit", async () => {
    const biz = await createBusiness([{ productCode: "bill", tier: "BASIC" }]);
    const { soap } = await setupCatalog(biz.manager, 1);
    const attempt = () => api("POST", "/bill/sales", { cookie: biz.manager, body: { items: [{ productId: soap.id, qty: 1 }], paymentMethod: "UPI" } });
    const results = await Promise.all([attempt(), attempt(), attempt()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect((await api("GET", "/bill/stock", { cookie: biz.manager })).body.items[0].stock).toBe(0);
    // Invoice numbers stay gapless even though two attempts rolled back
    const next = await api("POST", "/bill/purchases", { cookie: biz.manager, body: { items: [{ productId: soap.id, quantity: 1, unitCost: 7000 }] } });
    expect(next.status).toBe(201);
    const again = await attempt();
    expect(again.body.invoiceNo.endsWith("00002")).toBe(true);
  });
});

describe("SAF Bill Flow (Growth)", () => {
  it("stock adjustments, suppliers, purchase orders, counters, branch transfer and analytics", async () => {
    const biz = await createBusiness([{ productCode: "bill", tier: "GROWTH" }]);
    const { soap } = await setupCatalog(biz.manager);
    const store = await createStaff(biz.manager, "bill", "store1", [{ product: "bill", roleCode: "storekeeper" }]);

    const adj = await api("POST", "/bill/stock/adjust", { cookie: store.cookie, body: { productId: soap.id, quantity: -2, reason: "DAMAGED", note: "Wet carton" } });
    expect(adj.body.stock).toBe(8);
    expectError(await api("POST", "/bill/stock/adjust", { cookie: store.cookie, body: { productId: soap.id, quantity: -50, reason: "THEFT_LOSS" } }), 409, "INSUFFICIENT_STOCK");
    const records = await api("GET", "/bill/stock/adjustments", { cookie: biz.manager });
    expect(records.body.items[0]).toMatchObject({ quantity: -2, balanceAfter: 8 });

    const sup = await api("POST", "/bill/suppliers", { cookie: store.cookie, body: { name: "HUL Distributor" } });
    const po = await api("POST", "/bill/purchases", { cookie: store.cookie, body: { supplierId: sup.body.id, status: "ORDERED", items: [{ productId: soap.id, quantity: 12, unitCost: 6900 }] } });
    expect(po.body.status).toBe("ORDERED");
    expect((await api("GET", "/bill/stock", { cookie: biz.manager })).body.items[0].stock).toBe(8);
    expect((await api("POST", `/bill/purchases/${po.body.id}/receive`, { cookie: store.cookie })).status).toBe(200);
    expectError(await api("POST", `/bill/purchases/${po.body.id}/receive`, { cookie: store.cookie }), 409);
    expect((await api("GET", "/bill/stock", { cookie: biz.manager })).body.items[0].stock).toBe(20);

    // Multiple POS counters
    const counter = await api("POST", "/bill/counters", { cookie: biz.manager, body: { name: "Counter 2" } });
    expect(counter.status, JSON.stringify(counter.body)).toBe(201);
    const sale = await api("POST", "/bill/sales", { cookie: biz.manager, body: { items: [{ productId: soap.id, qty: 5 }], paymentMethod: "CARD", counterId: counter.body.id, discount: 5000 } });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    // 500 - 50 discount = 450 taxable, 18% = 81 -> 531.00
    expect(sale.body).toMatchObject({ subtotal: 50000, discount: 5000, taxTotal: 8100, total: 53100 });

    // Multi-branch: transfer stock to a second branch
    const branch = await api("POST", "/bill/branches", { cookie: biz.manager, body: { name: "City Outlet", code: "city" } });
    const trf = await api("POST", "/bill/stock/transfer", { cookie: biz.manager, body: { toBranchId: branch.body.id, items: [{ productId: soap.id, quantity: 6 }] } });
    expect(trf.status, JSON.stringify(trf.body)).toBe(200);
    expect((await api("GET", "/bill/stock", { cookie: biz.manager })).body.items[0].stock).toBe(9);
    expect((await api("GET", "/bill/stock", { cookie: biz.manager, headers: { "x-saf-branch": branch.body.id } })).body.items[0].stock).toBe(6);

    const an = await api("GET", "/bill/analytics", { cookie: biz.manager });
    expect(an.status).toBe(200);
    // revenue 500 - 50 = 450; cost 5 x 69 = 345 -> margin 105
    expect(an.body.summary).toMatchObject({ bills: 1, grossMargin: 10500 });
    expect(an.body.counters[0].name).toBe("Counter 2");
    expect((await api("GET", "/bill/stock/valuation", { cookie: biz.manager })).status).toBe(200);
    expect((await api("GET", "/bill/stock/movements", { cookie: biz.manager })).body.items.length).toBeGreaterThan(3);
  });
});
