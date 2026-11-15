import { describe, expect, it } from "vitest";
import { api, createBusiness, createStaff, expectError } from "../helpers";

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const imageForm = () => {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(PNG_1PX)], "qr.png", { type: "image/png" }));
  return fd;
};
const tokenOf = (url: string) => url.split("/").pop()!;

describe("business UPI: customers pay the shop's own UPI", () => {
  it("owner sets UPI; cashier shows the QR; unpaid bill carries it; paid bill is stamped", async () => {
    const biz = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const cookie = biz.manager;

    // Not configured yet: no QR, and nothing breaks.
    expect((await api("GET", "/dine/payments/upi?amount=50000", { cookie })).body.upi).toBeNull();

    // Only the owner may change where customer money goes.
    const cashier = await createStaff(cookie, "dine", "c9", [{ product: "dine", roleCode: "cashier" }]);
    expectError(await api("PUT", "/dine/business", { cookie: cashier.cookie, body: { upiId: "thief@okaxis" } }), 403);
    expectError(await api("POST", "/dine/business/upi-qr", { cookie: cashier.cookie, body: imageForm() }), 403);
    expectError(await api("PUT", "/dine/business", { cookie, body: { upiId: "not a upi id" } }), 400);
    const set = await api("PUT", "/dine/business", { cookie, body: { upiId: "spice.kitchen@okaxis", upiPayeeName: "Spice Kitchen" } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((await api("GET", "/me", { cookie })).body.tenant).toMatchObject({ upiId: "spice.kitchen@okaxis", upiPayeeName: "Spice Kitchen" });

    // Cashier screen: QR with the amount filled in.
    const qr = await api("GET", "/dine/payments/upi?amount=50000&note=Order%201", { cookie: cashier.cookie });
    expect(qr.body.upi).toMatchObject({ upiId: "spice.kitchen@okaxis", payeeName: "Spice Kitchen", amount: 50000, amountInQr: true });
    expect(qr.body.upi.link).toContain("am=500.00");
    expect(qr.body.upi.qr).toMatch(/^data:image\/png;base64,/);

    // An order: its bill can be shared before payment, with the QR for the total.
    const cat = await api("POST", "/dine/menu-categories", { cookie, body: { name: "Mains" } });
    const item = await api("POST", "/dine/menu-items", { cookie, body: { name: "Thali", categoryId: cat.body.id, price: 20000, taxRate: 500 } });
    const o = await api("POST", "/dine/orders", { cookie, body: { type: "TAKEAWAY", source: "POS", items: [{ menuItemId: item.body.id, qty: 2 }] } });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const order = (await api("GET", `/dine/orders/${o.body.id}`, { cookie })).body;
    const bill = await api("GET", `/public/invoice/dine/${order.publicToken}`);
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    expect(bill.body).toMatchObject({ isPaid: false, invoiceNo: null, total: order.total });
    expect(bill.body.pay).toMatchObject({ upiId: "spice.kitchen@okaxis", amount: order.total });

    // Cashier confirms the money arrived and settles as UPI: the invoice is stamped paid, no QR.
    const settled = await api("POST", `/dine/orders/${o.body.id}/settle`, { cookie: cashier.cookie, body: { paymentMethod: "UPI" } });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    const inv = await api("GET", `/public/invoice/dine/${tokenOf(settled.body.invoiceUrl)}`);
    expect(inv.body).toMatchObject({ isPaid: true, pay: null });
    expect(inv.body.invoiceNo).toBeTruthy();

    // Uploaded QR image is the fallback when no UPI ID is set.
    expect((await api("POST", "/dine/business/upi-qr", { cookie, body: imageForm() })).status).toBe(200);
    await api("PUT", "/dine/business", { cookie, body: { upiId: "" } });
    const fallback = (await api("GET", "/dine/payments/upi?amount=50000", { cookie })).body.upi;
    expect(fallback).toMatchObject({ upiId: null, amountInQr: false });
    expect(fallback.qr).toMatch(/^\/api\/files\/t\/.+\/upiqr\/.+\.png$/);
    expect((await api("GET", fallback.qr.replace(/^\/api/, ""))).status).toBe(200);
  });

  it("Super Admin sets the business UPI; another business's bill never shows it", async () => {
    const a = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const b = await createBusiness([{ productCode: "dine", tier: "BASIC" }]);
    const r = await api("PATCH", `/admin/businesses/${a.tenantId}`, { cookie: a.admin, body: { upiId: "shop-a@okicici", upiPayeeName: "Shop A" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await api("POST", `/admin/businesses/${a.tenantId}/upi-qr`, { cookie: a.admin, body: imageForm() })).status).toBe(200);
    expect((await api("GET", `/admin/businesses/${a.tenantId}`, { cookie: a.admin })).body.business).toMatchObject({ upiId: "shop-a@okicici" });
    expect((await api("GET", "/dine/payments/upi?amount=10000", { cookie: a.manager })).body.upi.upiId).toBe("shop-a@okicici");
    expect((await api("GET", "/dine/payments/upi?amount=10000", { cookie: b.manager })).body.upi).toBeNull();
  });
});
