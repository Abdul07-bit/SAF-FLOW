import { z } from "zod";
import { assertPublicLinkFresh } from "../core/public-links";
import type { BillMovementType, Prisma } from "@prisma/client";
import { addDays, endOfDayIST, financialYear, istDate, istMinutes, startOfDayIST, todayIST } from "@/lib/dates";
import { computeTotals } from "@/lib/money";
import { billCategories, billCounters, billCustomers, billProducts, billSuppliers } from "@/shared/resources";
import { route, type Ctx } from "../http/router";
import { registerCrud } from "../http/crud";
import { badRequest, conflict, HttpError, notFound } from "../http/errors";
import { nextSeq, withPlatform, withTenant, type Tx } from "../db";
import { token } from "../core/ids";
import { getProductSettings } from "../core/settings";
import { fileUrl } from "../core/storage";
import { rangeQuery } from "./dine";

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const TENDER = z.enum(["CASH", "UPI", "CARD", "WALLET", "CREDIT", "OTHER"]);

// ---------------------------------------------------------------------------
// Stock primitive
// ---------------------------------------------------------------------------

/**
 * Atomic stock movement for one product at one branch. Decrements use a
 * conditional UPDATE so two counters can never oversell the last unit.
 */
export async function moveBillStock(
  db: Tx, tenantId: string, productId: string, branchId: string, delta: number, type: BillMovementType,
  meta: { reason?: string; reference?: string; userId?: string | null; allowNegative?: boolean },
) {
  const q = round3(delta);
  await db.billStockLevel.upsert({
    where: { productId_branchId: { productId, branchId } },
    create: { tenantId, productId, branchId, quantity: 0 },
    update: {},
  });
  if (q < 0 && !meta.allowNegative) {
    const r = await db.billStockLevel.updateMany({ where: { productId, branchId, quantity: { gte: -q } }, data: { quantity: { increment: q } } });
    if (r.count === 0) {
      const p = await db.billProduct.findUnique({ where: { id: productId }, select: { name: true } });
      const lvl = await db.billStockLevel.findUnique({ where: { productId_branchId: { productId, branchId } } });
      throw new HttpError(409, "INSUFFICIENT_STOCK", `Only ${lvl?.quantity ?? 0} of ${p?.name ?? "this product"} in stock.`, { productId, available: lvl?.quantity ?? 0 });
    }
  } else {
    await db.billStockLevel.update({ where: { productId_branchId: { productId, branchId } }, data: { quantity: { increment: q } } });
  }
  const lvl = await db.billStockLevel.findUniqueOrThrow({ where: { productId_branchId: { productId, branchId } } });
  const balance = round3(lvl.quantity);
  if (balance !== lvl.quantity) await db.billStockLevel.update({ where: { id: lvl.id }, data: { quantity: balance } });
  await db.billStockMovement.create({
    data: { tenantId, productId, branchId, type, quantity: q, balanceAfter: balance, reason: meta.reason, reference: meta.reference, userId: meta.userId ?? null },
  });
  return balance;
}

async function stockMap(db: Tx, branchId: string, productIds: string[]) {
  const levels = await db.billStockLevel.findMany({ where: { branchId, productId: { in: productIds } } });
  return new Map(levels.map((l) => [l.productId, l.quantity]));
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

registerCrud(billCategories, { model: "billCategory", orderBy: { name: "asc" } });
registerCrud(billCustomers, { model: "billCustomer", orderBy: { name: "asc" } });
registerCrud(billSuppliers, { model: "billSupplier", orderBy: { name: "asc" } });
registerCrud(billCounters, { model: "billCounter", orderBy: { name: "asc" } });
registerCrud(billProducts, {
  model: "billProduct",
  include: { category: { select: { name: true } } },
  orderBy: { name: "asc" },
  virtual: ["openingStock"],
  beforeCreate: (_ctx, d) => ({ ...d, barcode: d.barcode || null }),
  beforeUpdate: (_ctx, d) => ("barcode" in d ? { ...d, barcode: d.barcode || null } : d),
  listHook: async (ctx, rows) => {
    const m = await stockMap(ctx.db, ctx.branchId, rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, stock: m.get(r.id) ?? 0, lowStock: (m.get(r.id) ?? 0) <= r.reorderLevel }));
  },
  afterCreate: async (ctx, row, input) => {
    const opening = Number(input.openingStock ?? 0);
    if (opening > 0) await moveBillStock(ctx.db, ctx.tenantId, row.id, ctx.branchId, opening, "OPENING", { reason: "Opening stock", userId: ctx.user.id });
  },
});

route({
  method: "GET", path: "/bill/products/lookup", tag: "bill", summary: "Find a product by barcode or SKU (POS scan)",
  auth: { product: "bill", feature: "pos", permission: ["pos.use", "products.view"] },
  query: z.object({ code: z.string().trim().min(1).max(60) }),
  handler: async (ctx) => {
    const code = ctx.query.code;
    const OR: Prisma.BillProductWhereInput[] = [{ sku: { equals: code, mode: "insensitive" } }];
    if (ctx.has("barcode")) OR.unshift({ barcode: code });
    const p = await ctx.db.billProduct.findFirst({ where: { tenantId: ctx.tenantId, isActive: true, OR }, include: { category: { select: { name: true } } } });
    if (!p) throw notFound(`Product with code ${code}`);
    const lvl = await ctx.db.billStockLevel.findUnique({ where: { productId_branchId: { productId: p.id, branchId: ctx.branchId } } });
    return { ...p, stock: lvl?.quantity ?? 0 };
  },
});

// ---------------------------------------------------------------------------
// Dashboard & cashier
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/bill/dashboard", tag: "bill", summary: "Retail dashboard", auth: { product: "bill", feature: "dashboard", permission: "dashboard.view" },
  handler: async (ctx) => {
    const today = todayIST();
    const scope = { tenantId: ctx.tenantId, branchId: ctx.branchId, status: "COMPLETED" as const };
    const [todaySales, week, products] = await Promise.all([
      ctx.db.billSale.findMany({ where: { ...scope, createdAt: { gte: startOfDayIST(today), lte: endOfDayIST(today) } }, include: { items: true } }),
      ctx.db.billSale.findMany({ where: { ...scope, createdAt: { gte: startOfDayIST(addDays(today, -6)) } }, select: { total: true, createdAt: true } }),
      ctx.has("low_stock_alerts") ? ctx.db.billProduct.findMany({ where: { tenantId: ctx.tenantId, isActive: true }, select: { id: true, name: true, reorderLevel: true, unit: true } }) : Promise.resolve([]),
    ]);
    const stock = await stockMap(ctx.db, ctx.branchId, products.map((p) => p.id));
    const low = products.filter((p) => (stock.get(p.id) ?? 0) <= p.reorderLevel);
    const total = todaySales.reduce((a, s) => a + s.total, 0);
    const methods: Record<string, number> = {};
    const top: Record<string, { name: string; qty: number; revenue: number }> = {};
    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, sales: 0 }));
    let margin = 0;
    for (const s of todaySales) {
      methods[s.paymentMethod] = (methods[s.paymentMethod] ?? 0) + s.total;
      hourly[Math.floor(istMinutes(s.createdAt) / 60)].sales += s.total;
      for (const i of s.items) {
        top[i.productId] ??= { name: i.name, qty: 0, revenue: 0 };
        top[i.productId].qty += i.qty;
        top[i.productId].revenue += Math.round(i.unitPrice * i.qty);
        margin += Math.round((i.unitPrice - i.costPrice) * i.qty) - i.discount;
      }
    }
    const days = Array.from({ length: 7 }, (_, i) => ({ date: addDays(today, i - 6), sales: 0 }));
    for (const s of week) {
      const d = days.find((x) => x.date === istDate(s.createdAt));
      if (d) d.sales += s.total;
    }
    return {
      salesToday: total, transactions: todaySales.length, avgBasket: todaySales.length ? Math.round(total / todaySales.length) : 0,
      itemsSold: round3(todaySales.reduce((a, s) => a + s.items.reduce((b, i) => b + i.qty, 0), 0)), grossMarginToday: margin,
      paymentSplit: Object.entries(methods).map(([method, amount]) => ({ method, amount })),
      hourly: hourly.filter((h) => h.hour >= 7 && h.hour <= 23), last7Days: days,
      topProducts: Object.values(top).sort((a, b) => b.revenue - a.revenue).slice(0, 8),
      lowStock: low.slice(0, 10).map((p) => ({ ...p, stock: stock.get(p.id) ?? 0 })), lowStockCount: low.length,
    };
  },
});

route({
  method: "GET", path: "/bill/cashier", tag: "bill", summary: "Cashier dashboard: my shift totals and recent bills",
  auth: { product: "bill", feature: "cashier", permission: "pos.use" },
  handler: async (ctx) => {
    const today = todayIST();
    const [mine, counters] = await Promise.all([
      ctx.db.billSale.findMany({
        where: { tenantId: ctx.tenantId, branchId: ctx.branchId, cashierId: ctx.user.id, createdAt: { gte: startOfDayIST(today), lte: endOfDayIST(today) } },
        include: { customer: { select: { name: true } }, counter: { select: { name: true } } }, orderBy: { createdAt: "desc" },
      }),
      ctx.db.billCounter.findMany({ where: { tenantId: ctx.tenantId, branchId: ctx.branchId, isActive: true }, orderBy: { name: "asc" } }),
    ]);
    const done = mine.filter((s) => s.status === "COMPLETED");
    const byMethod: Record<string, number> = {};
    for (const s of done) byMethod[s.paymentMethod] = (byMethod[s.paymentMethod] ?? 0) + s.total;
    const cash = done.filter((s) => s.paymentMethod === "CASH").reduce((a, s) => a + s.total, 0);
    return { totals: { count: done.length, amount: done.reduce((a, s) => a + s.total, 0), cashInDrawer: cash, voided: mine.length - done.length, byMethod }, recent: mine.slice(0, 25), counters };
  },
});

// ---------------------------------------------------------------------------
// POS sales
// ---------------------------------------------------------------------------

const saleInclude = {
  items: true,
  customer: { select: { id: true, name: true, phone: true } },
  cashier: { select: { fullName: true } },
  counter: { select: { name: true } },
} satisfies Prisma.BillSaleInclude;

route({
  method: "POST", path: "/bill/sales", tag: "bill", summary: "Complete a POS sale (prices and stock are verified server-side)",
  auth: { product: "bill", feature: "pos", permission: "pos.use" },
  body: z.object({
    items: z.array(z.object({ productId: z.uuid(), qty: z.number().positive().max(100000), discount: z.number().int().min(0).default(0) })).min(1).max(300),
    discount: z.number().int().min(0).default(0),
    paymentMethod: TENDER,
    amountPaid: z.number().int().min(0).optional(),
    customerId: z.uuid().optional(),
    customer: z.object({ name: z.string().trim().min(1).max(100), phone: z.string().trim().regex(/^[+\d][\d\s-]{6,18}$/) }).optional(),
    counterId: z.uuid().optional(),
  }),
  handler: async (ctx) => {
    const b = ctx.body;
    const settings = await getProductSettings(ctx.db, ctx.tenantId, "bill");
    const ids = [...new Set(b.items.map((i) => i.productId))];
    const products = await ctx.db.billProduct.findMany({ where: { id: { in: ids }, tenantId: ctx.tenantId, isActive: true } });
    if (products.length !== ids.length) throw badRequest("One or more products are unavailable.");

    let counterId: string | null = null;
    if (b.counterId) {
      const c = await ctx.db.billCounter.findFirst({ where: { id: b.counterId, tenantId: ctx.tenantId, branchId: ctx.branchId, isActive: true } });
      if (!c) throw badRequest("Unknown POS counter.");
      counterId = c.id;
    }

    let customerId: string | null = null;
    if (b.customerId) {
      const c = await ctx.db.billCustomer.findFirst({ where: { id: b.customerId, tenantId: ctx.tenantId } });
      if (!c) throw badRequest("Unknown customer.");
      customerId = c.id;
    } else if (b.customer) {
      ctx.require({ feature: "customers", permission: "customers.manage" });
      const c = await ctx.db.billCustomer.upsert({
        where: { tenantId_phone: { tenantId: ctx.tenantId, phone: b.customer.phone } },
        create: { tenantId: ctx.tenantId, ...b.customer }, update: {},
      });
      customerId = c.id;
    }

    const lines = b.items.map((i) => {
      const p = products.find((x) => x.id === i.productId)!;
      return { p, qty: round3(i.qty), discount: i.discount };
    });
    const totals = computeTotals(lines.map((l) => ({ unitPrice: l.p.price, qty: l.qty, taxRate: l.p.taxRate, discount: l.discount })), b.discount);
    const amountPaid = b.amountPaid ?? totals.total;
    if (b.paymentMethod !== "CREDIT" && amountPaid < totals.total) throw badRequest("Amount received is less than the bill total.");
    if (b.paymentMethod === "CREDIT" && !customerId) throw badRequest("Select a customer for credit sales.");

    const fy = financialYear(todayIST()).label;
    const saleNo = await nextSeq(ctx.db, ctx.tenantId, "bill-sale");
    const invSeq = await nextSeq(ctx.db, ctx.tenantId, `bill-invoice-${fy}`);
    const sale = await ctx.db.billSale.create({
      data: {
        tenantId: ctx.tenantId, branchId: ctx.branchId, counterId, saleNo,
        invoiceNo: `${settings.invoicePrefix}/${fy}/${String(invSeq).padStart(5, "0")}`,
        customerId, cashierId: ctx.user.id, subtotal: totals.subtotal, discount: totals.discount, taxTotal: totals.taxTotal,
        total: totals.total, paymentMethod: b.paymentMethod, amountPaid,
        changeDue: b.paymentMethod === "CASH" ? Math.max(0, amountPaid - totals.total) : 0, publicToken: token(18),
        items: {
          create: lines.map((l, idx) => ({
            tenantId: ctx.tenantId, productId: l.p.id, name: l.p.name, barcode: l.p.barcode, qty: l.qty, unitPrice: l.p.price,
            costPrice: l.p.costPrice, taxRate: l.p.taxRate, discount: l.discount + totals.lines[idx].allocatedDiscount, lineTotal: totals.lines[idx].lineTotal,
          })),
        },
      },
    });
    for (const l of lines)
      await moveBillStock(ctx.db, ctx.tenantId, l.p.id, ctx.branchId, -l.qty, "SALE", { reference: sale.invoiceNo, userId: ctx.user.id, allowNegative: settings.allowNegativeStock });
    await ctx.audit("bill.sale.create", { type: "bill_sale", id: sale.id }, { invoiceNo: sale.invoiceNo, total: sale.total });
    ctx.status = 201;
    const full = await ctx.db.billSale.findUniqueOrThrow({ where: { id: sale.id }, include: saleInclude });
    return { ...full, invoiceUrl: `/invoice/bill/${sale.publicToken}` };
  },
});

const SALES_READ = { product: "bill", feature: ["invoices", "pos", "cashier"], permission: "sales.view" } as const;

route({
  method: "GET", path: "/bill/sales", tag: "bill", summary: "Sales / invoices", auth: SALES_READ,
  query: rangeQuery.and(z.object({ q: z.string().max(60).optional(), status: z.enum(["COMPLETED", "VOID"]).optional() })),
  handler: async (ctx) => {
    const where: Prisma.BillSaleWhereInput = {
      tenantId: ctx.tenantId, branchId: ctx.branchId, createdAt: { gte: ctx.query.gte, lte: ctx.query.lte },
      ...(ctx.query.status ? { status: ctx.query.status } : {}),
      ...(ctx.query.q ? { OR: [{ invoiceNo: { contains: ctx.query.q, mode: "insensitive" } }, { customer: { name: { contains: ctx.query.q, mode: "insensitive" } } }, { customer: { phone: { contains: ctx.query.q } } }] } : {}),
    };
    const items = await ctx.db.billSale.findMany({ where, include: saleInclude, orderBy: { createdAt: "desc" }, take: 500 });
    return { items, from: ctx.query.from, to: ctx.query.to, total: items.filter((s) => s.status === "COMPLETED").reduce((a, s) => a + s.total, 0) };
  },
});

route({
  method: "GET", path: "/bill/sales/:id", tag: "bill", summary: "Sale detail", auth: SALES_READ,
  handler: async (ctx) => {
    const s = await ctx.db.billSale.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId }, include: saleInclude });
    if (!s) throw notFound("Sale");
    return { ...s, invoiceUrl: `/invoice/bill/${s.publicToken}` };
  },
});

route({
  method: "POST", path: "/bill/sales/:id/void", tag: "bill", summary: "Void a sale and return items to stock",
  auth: { product: "bill", feature: "invoices", permission: "sales.void" },
  body: z.object({ reason: z.string().trim().min(3).max(200) }),
  handler: async (ctx) => {
    const s = await ctx.db.billSale.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId, branchId: ctx.branchId }, include: { items: true } });
    if (!s) throw notFound("Sale");
    if (s.status === "VOID") throw conflict("Sale is already void.");
    await ctx.db.billSale.update({ where: { id: s.id }, data: { status: "VOID", voidReason: ctx.body.reason } });
    for (const i of s.items)
      await moveBillStock(ctx.db, ctx.tenantId, i.productId, s.branchId, i.qty, "VOID", { reference: s.invoiceNo, reason: ctx.body.reason, userId: ctx.user.id });
    await ctx.audit("bill.sale.void", { type: "bill_sale", id: s.id }, { invoiceNo: s.invoiceNo, reason: ctx.body.reason, total: s.total });
    return { ok: true };
  },
});

route({
  method: "GET", path: "/bill/customers/:id/history", tag: "bill", summary: "Customer purchase history and lifetime value",
  auth: { product: "bill", feature: "customers", permission: "customers.view" },
  handler: async (ctx) => {
    const c = await ctx.db.billCustomer.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId } });
    if (!c) throw notFound("Customer");
    const sales = await ctx.db.billSale.findMany({ where: { customerId: c.id, status: "COMPLETED" }, orderBy: { createdAt: "desc" }, take: 100 });
    const credit = sales.filter((s) => s.paymentMethod === "CREDIT").reduce((a, s) => a + s.total, 0);
    return { customer: c, sales, lifetimeValue: sales.reduce((a, s) => a + s.total, 0), visits: sales.length, creditOutstanding: credit };
  },
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/bill/stock", tag: "bill", summary: "Stock levels at the current branch",
  auth: { product: "bill", feature: "inventory", permission: "inventory.view" },
  query: z.object({ q: z.string().max(60).optional(), low: z.enum(["0", "1"]).optional() }),
  handler: async (ctx) => {
    const products = await ctx.db.billProduct.findMany({
      where: { tenantId: ctx.tenantId, isActive: true, ...(ctx.query.q ? { OR: [{ name: { contains: ctx.query.q, mode: "insensitive" } }, { sku: { contains: ctx.query.q, mode: "insensitive" } }, { barcode: ctx.query.q }] } : {}) },
      include: { category: { select: { name: true } } }, orderBy: { name: "asc" },
    });
    const m = await stockMap(ctx.db, ctx.branchId, products.map((p) => p.id));
    let items = products.map((p) => {
      const stock = m.get(p.id) ?? 0;
      return { id: p.id, name: p.name, sku: p.sku, barcode: p.barcode, unit: p.unit, category: p.category?.name ?? null, stock, reorderLevel: p.reorderLevel, low: stock <= p.reorderLevel, costValue: Math.round(Math.max(0, stock) * p.costPrice), retailValue: Math.round(Math.max(0, stock) * p.price) };
    });
    if (ctx.query.low === "1") items = items.filter((i) => i.low);
    return { items, totals: { costValue: items.reduce((a, i) => a + i.costValue, 0), retailValue: items.reduce((a, i) => a + i.retailValue, 0), lowCount: items.filter((i) => i.low).length } };
  },
});

route({
  method: "GET", path: "/bill/stock/low", tag: "bill", summary: "Low-stock alerts",
  auth: { product: "bill", feature: "low_stock_alerts", permission: "inventory.view" },
  handler: async (ctx) => {
    const products = await ctx.db.billProduct.findMany({ where: { tenantId: ctx.tenantId, isActive: true }, orderBy: { name: "asc" } });
    const m = await stockMap(ctx.db, ctx.branchId, products.map((p) => p.id));
    return { items: products.filter((p) => (m.get(p.id) ?? 0) <= p.reorderLevel).map((p) => ({ id: p.id, name: p.name, sku: p.sku, unit: p.unit, stock: m.get(p.id) ?? 0, reorderLevel: p.reorderLevel })) };
  },
});

route({
  method: "POST", path: "/bill/stock/:productId/stock-in", tag: "bill", summary: "Add received stock (stock management)",
  auth: { product: "bill", feature: "stock", permission: "inventory.manage" },
  body: z.object({ quantity: z.number().positive().max(1_000_000), reason: z.string().max(200).optional() }),
  handler: async (ctx) => {
    const p = await ctx.db.billProduct.findFirst({ where: { id: ctx.params.productId, tenantId: ctx.tenantId } });
    if (!p) throw notFound("Product");
    const balance = await moveBillStock(ctx.db, ctx.tenantId, p.id, ctx.branchId, ctx.body.quantity, "PURCHASE", { reason: ctx.body.reason ?? "Stock in", userId: ctx.user.id });
    return { stock: balance };
  },
});

export const ADJUSTMENT_REASONS = ["DAMAGED", "EXPIRED", "THEFT_LOSS", "COUNT_CORRECTION", "RETURN_TO_SUPPLIER", "INTERNAL_USE", "OTHER"] as const;

route({
  method: "POST", path: "/bill/stock/adjust", tag: "bill", summary: "Record a stock adjustment with a reason (audit trail)",
  auth: { product: "bill", feature: "stock_adjustments", permission: "inventory.manage" },
  body: z.object({ productId: z.uuid(), quantity: z.number().finite().refine((n) => n !== 0, "Quantity cannot be zero").refine((n) => Math.abs(n) <= 1_000_000), reason: z.enum(ADJUSTMENT_REASONS), note: z.string().max(200).optional() }),
  handler: async (ctx) => {
    const p = await ctx.db.billProduct.findFirst({ where: { id: ctx.body.productId, tenantId: ctx.tenantId } });
    if (!p) throw notFound("Product");
    const balance = await moveBillStock(ctx.db, ctx.tenantId, p.id, ctx.branchId, ctx.body.quantity, "ADJUSTMENT", {
      reason: `${ctx.body.reason}${ctx.body.note ? `: ${ctx.body.note}` : ""}`, userId: ctx.user.id,
    });
    await ctx.audit("bill.stock.adjust", { type: "bill_product", id: p.id }, { quantity: ctx.body.quantity, reason: ctx.body.reason });
    return { stock: balance };
  },
});

route({
  method: "GET", path: "/bill/stock/adjustments", tag: "bill", summary: "Stock adjustment records",
  auth: { product: "bill", feature: "stock_adjustments", permission: "inventory.view" }, query: rangeQuery,
  handler: async (ctx) => ({
    items: await ctx.db.billStockMovement.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId, type: "ADJUSTMENT", createdAt: { gte: ctx.query.gte, lte: ctx.query.lte } },
      include: { product: { select: { name: true, sku: true, unit: true, costPrice: true } } }, orderBy: { createdAt: "desc" },
    }),
  }),
});

route({
  method: "GET", path: "/bill/stock/movements", tag: "bill", summary: "Stock ledger (advanced inventory)",
  auth: { product: "bill", feature: "inventory_advanced", permission: "inventory.view" },
  query: rangeQuery.and(z.object({ productId: z.uuid().optional() })),
  handler: async (ctx) => ({
    items: await ctx.db.billStockMovement.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId, createdAt: { gte: ctx.query.gte, lte: ctx.query.lte }, ...(ctx.query.productId ? { productId: ctx.query.productId } : {}) },
      include: { product: { select: { name: true, sku: true, unit: true } } }, orderBy: { createdAt: "desc" }, take: 2000,
    }),
  }),
});

route({
  method: "GET", path: "/bill/stock/valuation", tag: "bill", summary: "Inventory valuation, fast movers and dead stock",
  auth: { product: "bill", feature: "inventory_advanced", permission: "inventory.view" },
  handler: async (ctx) => {
    const since = startOfDayIST(addDays(todayIST(), -59));
    const [products, sold] = await Promise.all([
      ctx.db.billProduct.findMany({ where: { tenantId: ctx.tenantId, isActive: true }, include: { category: { select: { name: true } } } }),
      ctx.db.billStockMovement.groupBy({ by: ["productId"], _sum: { quantity: true }, where: { tenantId: ctx.tenantId, branchId: ctx.branchId, type: "SALE", createdAt: { gte: since } } }),
    ]);
    const m = await stockMap(ctx.db, ctx.branchId, products.map((p) => p.id));
    const rows = products.map((p) => {
      const stock = m.get(p.id) ?? 0;
      const sold60 = -(sold.find((s) => s.productId === p.id)?._sum.quantity ?? 0);
      const daily = sold60 / 60;
      return {
        id: p.id, name: p.name, sku: p.sku, category: p.category?.name ?? null, stock, sold60d: round3(sold60),
        costValue: Math.round(Math.max(0, stock) * p.costPrice), retailValue: Math.round(Math.max(0, stock) * p.price),
        daysOfCover: daily > 0 ? Math.floor(stock / daily) : null, dead: sold60 === 0 && stock > 0,
      };
    });
    return {
      totals: { costValue: rows.reduce((a, r) => a + r.costValue, 0), retailValue: rows.reduce((a, r) => a + r.retailValue, 0), deadStockValue: rows.filter((r) => r.dead).reduce((a, r) => a + r.costValue, 0), skus: rows.length },
      fastMovers: [...rows].sort((a, b) => b.sold60d - a.sold60d).slice(0, 15),
      deadStock: rows.filter((r) => r.dead).sort((a, b) => b.costValue - a.costValue),
      items: rows.sort((a, b) => b.costValue - a.costValue),
    };
  },
});

route({
  method: "POST", path: "/bill/stock/transfer", tag: "bill", summary: "Transfer stock between branches",
  auth: { product: "bill", feature: "multi_branch", permission: "inventory.manage" },
  body: z.object({ toBranchId: z.uuid(), items: z.array(z.object({ productId: z.uuid(), quantity: z.number().positive().max(1_000_000) })).min(1).max(200), note: z.string().max(200).optional() }),
  handler: async (ctx) => {
    if (ctx.body.toBranchId === ctx.branchId) throw badRequest("Choose a different destination branch.");
    const to = ctx.access.branches.find((b) => b.id === ctx.body.toBranchId);
    if (!to) throw badRequest("Unknown destination branch.");
    const ref = `TRF-${Date.now().toString(36).toUpperCase()}`;
    for (const i of ctx.body.items) {
      const p = await ctx.db.billProduct.findFirst({ where: { id: i.productId, tenantId: ctx.tenantId } });
      if (!p) throw badRequest("Unknown product.");
      await moveBillStock(ctx.db, ctx.tenantId, p.id, ctx.branchId, -i.quantity, "TRANSFER_OUT", { reference: ref, reason: `To ${to.name}`, userId: ctx.user.id });
      await moveBillStock(ctx.db, ctx.tenantId, p.id, to.id, i.quantity, "TRANSFER_IN", { reference: ref, reason: ctx.body.note, userId: ctx.user.id });
    }
    return { reference: ref };
  },
});

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

const PURCH_READ = { product: "bill", feature: ["purchase_records", "purchase_management"], permission: ["purchases.view", "purchases.manage"] } as const;
const PURCH_WRITE = { product: "bill", feature: "purchase_records", permission: "purchases.manage" } as const;
const PO = { product: "bill", feature: "purchase_management", permission: "purchases.manage" } as const;

route({
  method: "GET", path: "/bill/purchases", tag: "bill", summary: "Purchase records / orders", auth: PURCH_READ,
  handler: async (ctx) => ({
    items: await ctx.db.billPurchase.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: { supplier: { select: { name: true } }, items: { include: { product: { select: { name: true, unit: true, sku: true } } } } },
      orderBy: { orderedAt: "desc" }, take: 300,
    }),
  }),
});

async function receiveBillPurchase(ctx: Ctx, id: string) {
  const p = await ctx.db.billPurchase.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, include: { items: true } });
  for (const i of p.items) {
    await moveBillStock(ctx.db, ctx.tenantId, i.productId, p.branchId, i.quantity, "PURCHASE", { reference: `PUR #${p.purchaseNo}`, userId: ctx.user.id });
    if (i.unitCost > 0) await ctx.db.billProduct.update({ where: { id: i.productId }, data: { costPrice: i.unitCost } });
  }
  await ctx.db.billPurchase.update({ where: { id: p.id }, data: { status: "RECEIVED", receivedAt: new Date() } });
}

route({
  method: "POST", path: "/bill/purchases", tag: "bill", summary: "Record a purchase (Basic: received immediately; Growth: purchase order)", auth: PURCH_WRITE,
  body: z.object({
    supplierId: z.uuid().optional(), supplierName: z.string().max(100).optional(), invoiceRef: z.string().max(60).optional(), notes: z.string().max(300).optional(),
    status: z.enum(["RECEIVED", "ORDERED"]).default("RECEIVED"),
    items: z.array(z.object({ productId: z.uuid(), quantity: z.number().positive().max(1_000_000), unitCost: z.number().int().min(0) })).min(1).max(200),
  }),
  handler: async (ctx) => {
    const b = ctx.body;
    if (b.status === "ORDERED") ctx.require({ feature: "purchase_management" });
    if (b.supplierId) {
      ctx.require({ feature: "suppliers" });
      if (!(await ctx.db.billSupplier.findFirst({ where: { id: b.supplierId, tenantId: ctx.tenantId } }))) throw badRequest("Unknown supplier.");
    }
    const ids = [...new Set(b.items.map((i) => i.productId))];
    if ((await ctx.db.billProduct.count({ where: { id: { in: ids }, tenantId: ctx.tenantId } })) !== ids.length) throw badRequest("Unknown product.");
    const purchaseNo = await nextSeq(ctx.db, ctx.tenantId, "bill-purchase");
    const p = await ctx.db.billPurchase.create({
      data: {
        tenantId: ctx.tenantId, branchId: ctx.branchId, purchaseNo, supplierId: b.supplierId ?? null, supplierName: b.supplierName || null,
        invoiceRef: b.invoiceRef || null, notes: b.notes || null, status: "ORDERED", createdById: ctx.user.id,
        total: Math.round(b.items.reduce((a, i) => a + i.quantity * i.unitCost, 0)),
        items: { create: b.items.map((i) => ({ ...i, quantity: round3(i.quantity), tenantId: ctx.tenantId })) },
      },
    });
    if (b.status === "RECEIVED") await receiveBillPurchase(ctx, p.id);
    ctx.status = 201;
    return ctx.db.billPurchase.findUniqueOrThrow({ where: { id: p.id } });
  },
});

route({
  method: "POST", path: "/bill/purchases/:id/receive", tag: "bill", summary: "Receive a purchase order into stock", auth: PO,
  handler: async (ctx) => {
    const p = await ctx.db.billPurchase.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId, branchId: ctx.branchId } });
    if (!p) throw notFound("Purchase");
    if (p.status !== "ORDERED") throw conflict("Only open purchase orders can be received.");
    await receiveBillPurchase(ctx, p.id);
    return { ok: true };
  },
});

route({
  method: "POST", path: "/bill/purchases/:id/cancel", tag: "bill", summary: "Cancel a purchase order", auth: PO,
  handler: async (ctx) => {
    const p = await ctx.db.billPurchase.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId, branchId: ctx.branchId } });
    if (!p) throw notFound("Purchase");
    if (p.status !== "ORDERED") throw conflict("Only open purchase orders can be cancelled.");
    await ctx.db.billPurchase.update({ where: { id: p.id }, data: { status: "CANCELLED" } });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Reports & analytics
// ---------------------------------------------------------------------------

async function completedSales(ctx: Ctx, gte: Date, lte: Date) {
  return ctx.db.billSale.findMany({
    where: { tenantId: ctx.tenantId, branchId: ctx.branchId, status: "COMPLETED", createdAt: { gte, lte } },
    include: { items: { include: { product: { select: { categoryId: true, category: { select: { name: true } } } } } }, cashier: { select: { fullName: true } }, counter: { select: { name: true } } },
  });
}

route({
  method: "GET", path: "/bill/reports/sales", tag: "bill", summary: "Sales report: totals, daily trend, payment split, top products",
  auth: { product: "bill", feature: "reports_basic", permission: "reports.view" }, query: rangeQuery,
  handler: async (ctx) => {
    const { from, to, gte, lte } = ctx.query;
    const [sales, voided] = await Promise.all([
      completedSales(ctx, gte, lte),
      ctx.db.billSale.aggregate({ _count: true, _sum: { total: true }, where: { tenantId: ctx.tenantId, branchId: ctx.branchId, status: "VOID", createdAt: { gte, lte } } }),
    ]);
    const days: Record<string, { date: string; sales: number; bills: number }> = {};
    for (let d = from; d <= to; d = addDays(d, 1)) days[d] = { date: d, sales: 0, bills: 0 };
    const methods: Record<string, number> = {};
    const top: Record<string, { name: string; qty: number; revenue: number }> = {};
    const cats: Record<string, number> = {};
    for (const s of sales) {
      const d = istDate(s.createdAt);
      if (days[d]) { days[d].sales += s.total; days[d].bills++; }
      methods[s.paymentMethod] = (methods[s.paymentMethod] ?? 0) + s.total;
      for (const i of s.items) {
        top[i.productId] ??= { name: i.name, qty: 0, revenue: 0 };
        top[i.productId].qty = round3(top[i.productId].qty + i.qty);
        top[i.productId].revenue += Math.round(i.unitPrice * i.qty);
        const c = i.product.category?.name ?? "Uncategorised";
        cats[c] = (cats[c] ?? 0) + Math.round(i.unitPrice * i.qty);
      }
    }
    const sum = (k: "subtotal" | "discount" | "taxTotal" | "total") => sales.reduce((a, s) => a + s[k], 0);
    return {
      from, to,
      totals: { bills: sales.length, gross: sum("subtotal"), discount: sum("discount"), tax: sum("taxTotal"), net: sum("total"), avgBasket: sales.length ? Math.round(sum("total") / sales.length) : 0, voided: voided._count, voidedAmount: voided._sum.total ?? 0 },
      daily: Object.values(days),
      paymentSplit: Object.entries(methods).map(([method, amount]) => ({ method, amount })),
      topProducts: Object.values(top).sort((a, b) => b.revenue - a.revenue).slice(0, 15),
      byCategory: Object.entries(cats).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
    };
  },
});

route({
  method: "GET", path: "/bill/analytics", tag: "bill", summary: "Advanced analytics: margins, heatmap, cashier/counter performance, customers",
  auth: { product: "bill", feature: "analytics_advanced", permission: "analytics.view" }, query: rangeQuery,
  handler: async (ctx) => {
    const { from, to, gte, lte } = ctx.query;
    const span = Math.max(1, Math.round((lte.getTime() - gte.getTime()) / 86_400_000));
    const [sales, prev] = await Promise.all([
      completedSales(ctx, gte, lte),
      ctx.db.billSale.aggregate({ _sum: { total: true }, _count: true, where: { tenantId: ctx.tenantId, branchId: ctx.branchId, status: "COMPLETED", createdAt: { gte: startOfDayIST(addDays(from, -span)), lt: gte } } }),
    ]);
    const heat = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    const cashiers: Record<string, { name: string; bills: number; sales: number }> = {};
    const counters: Record<string, { name: string; bills: number; sales: number }> = {};
    const catMargin: Record<string, { name: string; revenue: number; cost: number }> = {};
    const customers: Record<string, { bills: number; sales: number }> = {};
    const basket = { "1": 0, "2-3": 0, "4-6": 0, "7-10": 0, "10+": 0 };
    let revenue = 0, cost = 0;
    for (const s of sales) {
      const ist = new Date(s.createdAt.getTime() + 330 * 60_000);
      heat[ist.getUTCDay()][ist.getUTCHours()] += s.total;
      const cn = s.cashier?.fullName ?? "Unknown";
      cashiers[cn] ??= { name: cn, bills: 0, sales: 0 };
      cashiers[cn].bills++; cashiers[cn].sales += s.total;
      const ctr = s.counter?.name ?? "Default";
      counters[ctr] ??= { name: ctr, bills: 0, sales: 0 };
      counters[ctr].bills++; counters[ctr].sales += s.total;
      if (s.customerId) { customers[s.customerId] ??= { bills: 0, sales: 0 }; customers[s.customerId].bills++; customers[s.customerId].sales += s.total; }
      const n = s.items.length;
      basket[n === 1 ? "1" : n <= 3 ? "2-3" : n <= 6 ? "4-6" : n <= 10 ? "7-10" : "10+"]++;
      for (const i of s.items) {
        const r = Math.round(i.unitPrice * i.qty) - i.discount;
        const c = Math.round(i.costPrice * i.qty);
        revenue += r; cost += c;
        const cat = i.product.category?.name ?? "Uncategorised";
        catMargin[cat] ??= { name: cat, revenue: 0, cost: 0 };
        catMargin[cat].revenue += r; catMargin[cat].cost += c;
      }
    }
    const total = sales.reduce((a, s) => a + s.total, 0);
    const custList = Object.values(customers);
    const topCustomerIds = Object.entries(customers).sort((a, b) => b[1].sales - a[1].sales).slice(0, 10);
    const names = await ctx.db.billCustomer.findMany({ where: { id: { in: topCustomerIds.map(([id]) => id) } }, select: { id: true, name: true, phone: true } });
    return {
      from, to,
      summary: {
        sales: total, bills: sales.length, avgBasket: sales.length ? Math.round(total / sales.length) : 0,
        grossMargin: revenue - cost, marginPct: revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : 0,
        prevSales: prev._sum.total ?? 0, growthPct: prev._sum.total ? Math.round(((total - prev._sum.total) / prev._sum.total) * 1000) / 10 : null,
        identifiedCustomerPct: sales.length ? Math.round((sales.filter((s) => s.customerId).length / sales.length) * 1000) / 10 : 0,
        repeatCustomers: custList.filter((c) => c.bills > 1).length,
      },
      heatmap: heat,
      cashiers: Object.values(cashiers).sort((a, b) => b.sales - a.sales),
      counters: Object.values(counters).sort((a, b) => b.sales - a.sales),
      categoryMargin: Object.values(catMargin).map((c) => ({ ...c, margin: c.revenue - c.cost, marginPct: c.revenue ? Math.round(((c.revenue - c.cost) / c.revenue) * 1000) / 10 : 0 })).sort((a, b) => b.revenue - a.revenue),
      basketSize: Object.entries(basket).map(([bucket, count]) => ({ bucket, count })),
      topCustomers: topCustomerIds.map(([id, v]) => ({ ...names.find((n) => n.id === id), ...v })),
    };
  },
});

// ---------------------------------------------------------------------------
// Public invoice
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/public/invoice/bill/:token", tag: "public", summary: "Printable retail invoice",
  auth: { public: true }, rateLimit: { limit: 60, windowMs: 60_000 },
  handler: async (ctx) => {
    const ref = await withPlatform((db) => db.billSale.findUnique({ where: { publicToken: ctx.params.token }, select: { id: true, tenantId: true } }));
    if (!ref) throw notFound("Invoice");
    return withTenant(ref.tenantId, async (db) => {
      const s = await db.billSale.findUniqueOrThrow({ where: { id: ref.id }, include: saleInclude });
      assertPublicLinkFresh(s.createdAt);
      const business = await db.business.findUniqueOrThrow({ where: { tenantId: ref.tenantId } });
      const settings = await getProductSettings(db, ref.tenantId, "bill");
      return {
        kind: "bill", status: s.status,
        seller: { name: settings.storeName || business.name, address: [business.address, business.city, business.state, business.pincode].filter(Boolean).join(", "), phone: business.phone, gstin: settings.gstin || business.gstin, logoUrl: fileUrl(business.logoKey) },
        invoiceNo: s.invoiceNo, date: s.createdAt, customer: { name: s.customer?.name ?? null, phone: s.customer?.phone ?? null },
        meta: [s.counter?.name ?? "", `Cashier: ${s.cashier?.fullName ?? "-"}`, `Paid by ${s.paymentMethod}`].filter(Boolean),
        lines: s.items.map((i) => ({ name: i.name, qty: i.qty, rate: i.unitPrice, taxRate: i.taxRate, amount: Math.round(i.unitPrice * i.qty), discount: i.discount })),
        subtotal: s.subtotal, discount: s.discount, tax: s.taxTotal, total: s.total, amountPaid: s.amountPaid, changeDue: s.changeDue,
        footer: settings.receiptFooter,
      };
    });
  },
});
