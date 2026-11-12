import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ALL_FEATURES, PRODUCT_LIST, PRODUCTS, rolePermissionKeys } from "@/config/catalog";
import { addDays, addMonths, daysBetween, endOfMonth, financialYear, hhmmToMinutes, istDate, startOfDayIST } from "@/lib/dates";
import { computeTotals, formatINR, rupeesToPaise, taxOn } from "@/lib/money";
import { subscriptionState } from "@/server/core/access";
import { isValidBusinessCode, isValidHandle, normalizeUsername, temporaryPassword } from "@/server/core/ids";
import { periodExpiry } from "@/server/core/subscriptions";
import { passwordPolicyError } from "@/server/auth/password";
import { sniffImage } from "@/server/core/storage";
import { verifyPaymentSignature, verifyWebhookSignature } from "@/server/payments/razorpay";
import { listRoutes } from "@/server/api";
import { RESOURCES } from "@/shared/resources";

describe("money", () => {
  it("computes GST on the discounted value and always reconciles", () => {
    const t = computeTotals([{ unitPrice: 10000, qty: 3, taxRate: 500 }, { unitPrice: 3333, qty: 1, taxRate: 1800 }], 1000);
    expect(t.subtotal).toBe(33333);
    expect(t.discount).toBe(1000);
    expect(t.lines.reduce((a, l) => a + l.allocatedDiscount, 0)).toBe(1000);
    expect(t.total).toBe(t.subtotal - t.discount + t.taxTotal);
    expect(t.lines.reduce((a, l) => a + l.lineTotal, 0)).toBe(t.total);
  });
  it("caps the discount at the subtotal and handles empty bills", () => {
    expect(computeTotals([{ unitPrice: 500, qty: 1, taxRate: 500 }], 99999).total).toBe(0);
    expect(computeTotals([]).total).toBe(0);
  });
  it("formats and converts rupees", () => {
    expect(rupeesToPaise("599")).toBe(59900);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
    expect(taxOn(59900, 1800)).toBe(10782);
    expect(formatINR(1800000)).toContain("18,000");
  });
});

describe("dates (IST)", () => {
  it("clamps month arithmetic and computes inclusive subscription expiry", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(periodExpiry("2026-11-10", "MONTHLY")).toBe("2026-12-09");
    expect(periodExpiry("2026-11-10", "ANNUAL")).toBe("2027-11-09");
    expect(endOfMonth("2026-02-10")).toBe("2026-02-28");
    expect(daysBetween("2026-12-30", "2027-01-02")).toBe(3);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("uses the IST calendar day, not UTC", () => {
    expect(istDate(new Date("2026-11-10T19:00:00Z"))).toBe("2026-11-11");
    expect(startOfDayIST("2026-11-11").toISOString()).toBe("2026-11-10T18:30:00.000Z");
    expect(hhmmToMinutes("09:30")).toBe(570);
  });
  it("knows the Indian financial year", () => {
    expect(financialYear("2026-03-31").label).toBe("2025-26");
    expect(financialYear("2026-04-01").label).toBe("2026-27");
  });
});

describe("subscription state machine", () => {
  const base = { status: "ACTIVE" as const, startDate: new Date("2026-01-01T00:00:00Z"), currentPeriodEnd: new Date("2026-01-31T18:29:59Z"), graceDays: null };
  const at = (iso: string) => subscriptionState(base, 7, new Date(iso)).state;
  it("derives ACTIVE -> GRACE -> EXPIRED from dates alone", () => {
    expect(at("2026-01-15T00:00:00Z")).toBe("ACTIVE");
    expect(at("2026-02-03T00:00:00Z")).toBe("GRACE");
    expect(at("2026-02-08T00:00:00Z")).toBe("EXPIRED");
    expect(at("2025-12-25T00:00:00Z")).toBe("PENDING");
  });
  it("honours a per-subscription grace override and manual suspension", () => {
    expect(subscriptionState({ ...base, graceDays: 0 }, 7, new Date("2026-02-01T00:00:00Z")).state).toBe("EXPIRED");
    expect(subscriptionState({ ...base, status: "SUSPENDED" }, 7, new Date("2026-01-15T00:00:00Z")).state).toBe("SUSPENDED");
  });
});

describe("identity helpers", () => {
  it("normalises login IDs so SGV@manager is case-insensitive", () => {
    expect(normalizeUsername(" sgv@Manager ")).toBe("SGV@manager");
    expect(isValidBusinessCode("SGV")).toBe(true);
    for (const bad of ["S", "1AB", "SAF", "ADMIN", "sgv", "AB-C", "TOOLONGCODE123"]) expect(isValidBusinessCode(bad), bad).toBe(false);
    expect(isValidHandle("ravi.k")).toBe(true);
    expect(isValidHandle("Ravi")).toBe(false);
  });
  it("generates strong, unique temporary passwords", () => {
    const set = new Set(Array.from({ length: 200 }, () => temporaryPassword()));
    expect(set.size).toBe(200);
    for (const pw of set) {
      expect(pw).toHaveLength(12);
      expect(/[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d/.test(pw) && /[@#%*+=?]/.test(pw), pw).toBe(true);
      expect(passwordPolicyError(pw)).toBeNull();
    }
  });
  it("enforces the password policy", () => {
    expect(passwordPolicyError("short1")).toMatch(/8 characters/);
    expect(passwordPolicyError("allletters")).toMatch(/letters and numbers/);
    expect(passwordPolicyError("manager12345", "SGV@manager")).toMatch(/login ID/);
  });
  it("only recognises real PNG / JPEG bytes", () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("png");
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(sniffImage(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
});

describe("razorpay signatures", () => {
  it("accepts only the correct HMAC", () => {
    const sig = createHmac("sha256", "secret").update("order_1|pay_1").digest("hex");
    expect(verifyPaymentSignature("order_1", "pay_1", sig, "secret")).toBe(true);
    expect(verifyPaymentSignature("order_1", "pay_2", sig, "secret")).toBe(false);
    expect(verifyPaymentSignature("order_1", "pay_1", sig, "")).toBe(false);
    const body = '{"event":"payment.captured"}';
    expect(verifyWebhookSignature(body, createHmac("sha256", "wh").update(body).digest("hex"), "wh")).toBe(true);
    expect(verifyWebhookSignature(body + " ", createHmac("sha256", "wh").update(body).digest("hex"), "wh")).toBe(false);
  });
});

describe("product catalog integrity", () => {
  it("Dine Flow Basic includes the waiter dashboard, KDS and cashier dashboard", () => {
    const basic = PRODUCTS.dine.features.filter((f) => f.tier === "BASIC").map((f) => f.key);
    for (const k of ["dine.waiter", "dine.kds", "dine.cashier", "dine.pos", "dine.qr_menu", "dine.qr_ordering", "dine.whatsapp_invoice"]) expect(basic).toContain(k);
  });
  it("tiers are product specific and Growth-only modules are never in Basic", () => {
    const tierOf = (k: string) => ALL_FEATURES.find((f) => f.key === k)?.tier;
    for (const k of ["dine.ingredients", "dine.wastage", "stay.maintenance", "stay.multi_branch", "bill.multi_counter", "bill.stock_adjustments"]) expect(tierOf(k), k).toBe("GROWTH");
    for (const p of PRODUCT_LIST) for (const k of ["attendance", "shifts", "id_cards", "qr_verification", "staff_management"]) expect(tierOf(`${p.code}.${k}`), `${p.code}.${k}`).toBe("GROWTH");
    expect(tierOf("stay.housekeeping_status")).toBe("BASIC");
    expect(tierOf("bill.barcode")).toBe("BASIC");
    expect(new Set(ALL_FEATURES.map((f) => f.key)).size).toBe(ALL_FEATURES.length);
  });
  it("defines the required roles and every role permission exists", () => {
    expect(PRODUCTS.dine.roles.map((r) => r.code)).toEqual(["manager", "waiter", "cashier", "kitchen"]);
    expect(PRODUCTS.stay.roles.map((r) => r.code)).toEqual(["manager", "receptionist", "housekeeping", "cashier", "maintenance"]);
    expect(PRODUCTS.bill.roles.map((r) => r.code)).toEqual(["manager", "cashier", "inventory_staff", "storekeeper"]);
    for (const p of PRODUCT_LIST) {
      const known = new Set(p.permissions.map((x) => x.key));
      for (const r of p.roles) for (const k of rolePermissionKeys(p.code, r)) expect(known.has(k), `${p.code}/${r.code}: ${k}`).toBe(true);
    }
  });
});

describe("API authorisation policy (lint)", () => {
  const routes = listRoutes();
  const featureKeys = new Set(ALL_FEATURES.map((f) => f.key));
  const permKeys = new Set(PRODUCT_LIST.flatMap((p) => p.permissions.map((x) => x.key)));
  const arr = (v: unknown) => (v === undefined ? [] : typeof v === "string" ? [v] : [...(v as string[])]);

  it("only an explicit allowlist of endpoints is public", () => {
    const publicRoutes = routes.filter((r) => "public" in r.auth).map((r) => `${r.method} ${r.path}`).sort();
    expect(publicRoutes).toEqual([
      "GET /docs/openapi.json",
      "GET /files/*key",
      "GET /health",
      "GET /public/dine/menu/:qrToken",
      "GET /public/dine/orders/:token",
      "GET /public/invoice/bill/:token",
      "GET /public/invoice/dine/:token",
      "GET /public/invoice/stay/:token",
      "GET /public/verify/:token",
      "POST /auth/login",
      "POST /jobs/renewals",
      "POST /public/dine/menu/:qrToken/order",
      "POST /webhooks/razorpay",
    ]);
  });
  it("every /admin endpoint is Super Admin only, and nothing else is", () => {
    for (const r of routes) expect("platform" in r.auth, `${r.method} ${r.path}`).toBe(r.path.startsWith("/admin"));
  });
  it("every product endpoint names a permission, and all feature / permission keys exist", () => {
    const exempt = new Set(["GET /me/products/:product"]);
    for (const r of routes) {
      if (!("product" in r.auth)) continue;
      const id = `${r.method} ${r.path}`;
      const products = r.auth.product === ":product" ? (["dine", "stay", "bill"] as const) : [r.auth.product];
      if (!exempt.has(id)) expect(arr(r.auth.permission).length, `${id} has no permission`).toBeGreaterThan(0);
      // Shared /:product routes may name a feature only some products have
      // (e.g. multi_branch is Stay/Bill only): the route is then always
      // refused for the others. A key that exists nowhere is a typo.
      for (const f of arr(r.auth.feature)) expect(products.some((p) => featureKeys.has(`${p}.${f}`)), `${id}: feature ${f}`).toBe(true);
      for (const p of products)
        for (const k of arr(r.auth.permission)) expect(permKeys.has(`${p}.${k}`), `${id}: permission ${p}.${k}`).toBe(true);
    }
  });
  it("product routes live under their own product prefix", () => {
    for (const r of routes) {
      if (!("product" in r.auth) || r.auth.product === ":product") continue;
      expect(r.path.startsWith(`/${r.auth.product}/`), `${r.method} ${r.path}`).toBe(true);
    }
  });
  it("resource definitions reference real features and permissions", () => {
    for (const def of RESOURCES) {
      const products = def.product === ":product" ? (["dine", "stay", "bill"] as const) : [def.product];
      for (const side of [def.read, def.write]) {
        for (const f of arr(side.feature)) expect(products.some((p) => featureKeys.has(`${p}.${f}`)), `${def.key}: ${f}`).toBe(true);
        for (const p of products) for (const k of arr(side.permission)) expect(permKeys.has(`${p}.${k}`), `${def.key}: ${p}.${k}`).toBe(true);
      }
    }
  });
});
