import { z } from "zod";
import { shopUpi } from "../payments/shop-upi";
import { assertPublicLinkFresh } from "../core/public-links";
import QRCode from "qrcode";
import type { DineMovementType, Prisma } from "@prisma/client";
import { addDays, endOfDayIST, financialYear, isISODate, istDate, istMinutes, startOfDayIST, todayIST } from "@/lib/dates";
import { computeTotals, formatINR } from "@/lib/money";
import { dineCategories, dineMenuItems, dineStockItems, dineSuppliers, dineTables } from "@/shared/resources";
import { route, type Ctx } from "../http/router";
import { registerCrud } from "../http/crud";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../http/errors";
import { nextSeq, withPlatform, withTenant, type Tx } from "../db";
import { token } from "../core/ids";
import { tenantEntitled } from "../core/access";
import { getProductSettings } from "../core/settings";
import { fileUrl } from "../core/storage";
import { whatsappLink } from "../core/notify";
import { addTenders, assertSplitMatches, describePayment, splitPartsSchema } from "@/shared/tender";

const isoDate = z.string().refine(isISODate, "Use YYYY-MM-DD");
const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export const rangeQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() }).transform((q) => {
  const to = q.to ?? todayIST();
  const from = q.from ?? to;
  if (from > to) throw new HttpError(400, "BAD_RANGE", "'from' must be on or before 'to'.");
  return { from, to, gte: startOfDayIST(from), lte: endOfDayIST(to) };
});

// ---------------------------------------------------------------------------
// CRUD resources
// ---------------------------------------------------------------------------

registerCrud(dineTables, {
  model: "dineTable",
  orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  beforeCreate: (_ctx, d) => ({ ...d, qrToken: token(16) }),
  mapOut: (t) => ({ ...t, qrUrl: `${appUrl()}/m/${t.qrToken}` }),
});

registerCrud(dineCategories, { model: "dineMenuCategory", orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });

const stripProductLink = (ctx: Ctx, d: Record<string, unknown>) => {
  if (d.stockItemId && !ctx.has("products")) throw forbidden("FEATURE_NOT_IN_PLAN", "Product management is not in your plan.");
  return d;
};
registerCrud(dineMenuItems, {
  model: "dineMenuItem",
  include: { category: { select: { name: true } }, stockItem: { select: { name: true, quantity: true, unit: true } } },
  orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  beforeCreate: stripProductLink,
  beforeUpdate: stripProductLink,
});

registerCrud(dineStockItems, {
  model: "dineStockItem",
  include: { supplier: { select: { name: true } } },
  orderBy: { name: "asc" },
  beforeCreate: (ctx, d) => {
    if (d.supplierId && !ctx.has("suppliers")) delete d.supplierId;
    return d;
  },
  afterCreate: async (ctx, row) => {
    if (row.quantity > 0)
      await ctx.db.dineStockMovement.create({
        data: { tenantId: ctx.tenantId, stockItemId: row.id, type: "OPENING", quantity: row.quantity, balanceAfter: row.quantity, userId: ctx.user.id, reason: "Opening stock" },
      });
  },
  beforeUpdate: (ctx, d) => {
    delete d.quantity; // stock changes only through movements
    if (d.supplierId && !ctx.has("suppliers")) delete d.supplierId;
    return d;
  },
});

registerCrud(dineSuppliers, { model: "dineSupplier", orderBy: { name: "asc" } });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function moveDineStock(
  db: Tx, tenantId: string, stockItemId: string, delta: number, type: DineMovementType,
  meta: { reference?: string; reason?: string; userId?: string | null },
) {
  const item = await db.dineStockItem.update({ where: { id: stockItemId }, data: { quantity: { increment: round3(delta) } } });
  const balance = round3(item.quantity);
  if (balance !== item.quantity) await db.dineStockItem.update({ where: { id: stockItemId }, data: { quantity: balance } });
  await db.dineStockMovement.create({
    data: { tenantId, stockItemId, type, quantity: round3(delta), balanceAfter: balance, reference: meta.reference, reason: meta.reason, userId: meta.userId ?? null },
  });
  return balance;
}

const orderInclude = {
  items: { orderBy: { createdAt: "asc" } },
  table: { select: { id: true, name: true } },
  waiter: { select: { id: true, fullName: true } },
  tickets: { orderBy: { kotNo: "asc" } },
} satisfies Prisma.DineOrderInclude;

async function loadOrder(ctx: Ctx, id: string) {
  const o = await ctx.db.dineOrder.findFirst({ where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId }, include: orderInclude });
  if (!o) throw notFound("Order");
  return o;
}

async function recalc(db: Tx, orderId: string, discount?: number) {
  const o = await db.dineOrder.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  const live = o.items.filter((i) => i.status !== "CANCELLED");
  const t = computeTotals(live.map((i) => ({ unitPrice: i.unitPrice, qty: i.qty, taxRate: i.taxRate })), discount ?? o.discount);
  return db.dineOrder.update({ where: { id: orderId }, data: { subtotal: t.subtotal, discount: t.discount, taxTotal: t.taxTotal, total: t.total } });
}

const itemInput = z.object({ menuItemId: z.uuid(), qty: z.number().int().min(1).max(500), notes: z.string().max(140).optional() });

async function priceItems(db: Tx, tenantId: string, items: z.infer<typeof itemInput>[]) {
  const ids = [...new Set(items.map((i) => i.menuItemId))];
  const menu = await db.dineMenuItem.findMany({ where: { id: { in: ids }, tenantId, isActive: true } });
  return items.map((i) => {
    const m = menu.find((x) => x.id === i.menuItemId);
    if (!m) throw badRequest("A menu item no longer exists.");
    if (!m.isAvailable) throw conflict(`${m.name} is sold out right now.`);
    return { menuItemId: m.id, name: m.name, unitPrice: m.price, taxRate: m.taxRate, qty: i.qty, notes: i.notes ?? null };
  });
}

async function sendKot(db: Tx, tenantId: string, order: { id: string; branchId: string; orderNo: number; type: string; table?: { name: string } | null }) {
  const pending = await db.dineOrderItem.findMany({ where: { orderId: order.id, status: "NEW" } });
  if (!pending.length) return null;
  const kotNo = await nextSeq(db, tenantId, `dine-kot-${istDate(new Date())}`);
  const kot = await db.dineKitchenOrder.create({
    data: {
      tenantId, branchId: order.branchId, orderId: order.id, kotNo,
      label: order.table ? `Table ${order.table.name}` : `${order.type === "DELIVERY" ? "Delivery" : "Takeaway"} #${order.orderNo}`,
    },
  });
  await db.dineOrderItem.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { status: "SENT", kotId: kot.id } });
  return kot;
}

function invoiceLinks(o: { publicToken: string; customerPhone: string | null; total: number; invoiceNo: string | null }, businessName: string) {
  const invoiceUrl = `${appUrl()}/invoice/dine/${o.publicToken}`;
  const text = `Thank you for dining at ${businessName}! Your bill ${o.invoiceNo ?? ""} of ${formatINR(o.total)}: ${invoiceUrl}`;
  return { invoiceUrl, whatsappUrl: whatsappLink(o.customerPhone, text) };
}

// ---------------------------------------------------------------------------
// Dashboard & boards
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/dine/dashboard", tag: "dine", summary: "Restaurant dashboard", auth: { product: "dine", feature: "dashboard", permission: "dashboard.view" },
  handler: async (ctx) => {
    const today = { gte: startOfDayIST(todayIST()), lte: endOfDayIST(todayIST()) };
    const scope = { tenantId: ctx.tenantId, branchId: ctx.branchId };
    const [paid, open, tables, stock, kots] = await Promise.all([
      ctx.db.dineOrder.findMany({ where: { ...scope, status: "PAID", paidAt: today }, include: { items: true } }),
      ctx.db.dineOrder.count({ where: { ...scope, status: "OPEN" } }),
      ctx.db.dineTable.groupBy({ by: ["status"], _count: true, where: { ...scope, isActive: true } }),
      ctx.has("low_stock_alerts") ? ctx.db.dineStockItem.findMany({ where: { tenantId: ctx.tenantId, isActive: true } }) : Promise.resolve([]),
      ctx.db.dineKitchenOrder.count({ where: { ...scope, status: { in: ["NEW", "PREPARING"] } } }),
    ]);
    const sales = paid.reduce((a, o) => a + o.total, 0);
    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, sales: 0 }));
    const methods: Record<string, number> = {};
    const items: Record<string, { name: string; qty: number; revenue: number }> = {};
    for (const o of paid) {
      hourly[Math.floor(istMinutes(o.paidAt!) / 60)].sales += o.total;
      addTenders(methods, o);
      for (const i of o.items.filter((x) => x.status !== "CANCELLED")) {
        items[i.menuItemId] ??= { name: i.name, qty: 0, revenue: 0 };
        items[i.menuItemId].qty += i.qty;
        items[i.menuItemId].revenue += i.unitPrice * i.qty;
      }
    }
    const low = stock.filter((s) => s.quantity <= s.reorderLevel);
    return {
      salesToday: sales, ordersToday: paid.length, avgTicket: paid.length ? Math.round(sales / paid.length) : 0,
      openOrders: open, kitchenQueue: kots,
      tables: Object.fromEntries(tables.map((t) => [t.status, t._count])),
      paymentSplit: Object.entries(methods).map(([method, amount]) => ({ method, amount })),
      hourly: hourly.filter((h) => h.hour >= 7),
      topItems: Object.values(items).sort((a, b) => b.qty - a.qty).slice(0, 8),
      lowStock: low.slice(0, 10).map((s) => ({ id: s.id, name: s.name, quantity: s.quantity, unit: s.unit, reorderLevel: s.reorderLevel })),
      lowStockCount: low.length,
    };
  },
});

route({
  method: "GET", path: "/dine/waiter/board", tag: "dine", summary: "Waiter dashboard: tables, ready food, QR orders to accept",
  auth: { product: "dine", feature: "waiter", permission: "orders.view" },
  handler: async (ctx) => {
    const scope = { tenantId: ctx.tenantId, branchId: ctx.branchId };
    const [tables, openOrders, ready] = await Promise.all([
      ctx.db.dineTable.findMany({ where: { ...scope, isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      ctx.db.dineOrder.findMany({ where: { ...scope, status: "OPEN" }, include: { items: true, waiter: { select: { fullName: true } } } }),
      ctx.db.dineKitchenOrder.findMany({ where: { ...scope, status: "READY" }, include: { items: true }, orderBy: { readyAt: "asc" } }),
    ]);
    return {
      tables: tables.map((t) => {
        const o = openOrders.find((x) => x.tableId === t.id);
        return {
          id: t.id, name: t.name, seats: t.seats, area: t.area, status: t.status,
          order: o ? {
            id: o.id, orderNo: o.orderNo, total: o.total, guests: o.guests, waiter: o.waiter?.fullName ?? null, createdAt: o.createdAt,
            items: o.items.filter((i) => i.status !== "CANCELLED").length,
            pendingQr: o.items.filter((i) => i.status === "PENDING_ACCEPT").length,
            ready: o.items.filter((i) => i.status === "READY").length,
          } : null,
        };
      }),
      ready: ready.map((k) => ({ id: k.id, kotNo: k.kotNo, label: k.label, readyAt: k.readyAt, items: k.items.filter((i) => i.status !== "CANCELLED").map((i) => ({ name: i.name, qty: i.qty })) })),
      takeaway: openOrders.filter((o) => !o.tableId).map((o) => ({ id: o.id, orderNo: o.orderNo, type: o.type, total: o.total, customerName: o.customerName })),
      pendingQr: openOrders.filter((o) => o.items.some((i) => i.status === "PENDING_ACCEPT")).length,
    };
  },
});

route({
  method: "GET", path: "/dine/cashier/board", tag: "dine", summary: "Cashier dashboard: bills to settle and today's collections",
  auth: { product: "dine", feature: ["cashier", "pos"], permission: "billing.settle" },
  handler: async (ctx) => {
    const scope = { tenantId: ctx.tenantId, branchId: ctx.branchId };
    const today = { gte: startOfDayIST(todayIST()), lte: endOfDayIST(todayIST()) };
    const [open, settled] = await Promise.all([
      ctx.db.dineOrder.findMany({ where: { ...scope, status: "OPEN" }, include: orderInclude, orderBy: { createdAt: "asc" } }),
      ctx.db.dineOrder.findMany({ where: { ...scope, status: "PAID", paidAt: today }, orderBy: { paidAt: "desc" }, include: { table: { select: { name: true } } } }),
    ]);
    const byMethod: Record<string, number> = {};
    for (const o of settled) addTenders(byMethod, o);
    return {
      open,
      settled: settled.slice(0, 50),
      collections: { total: settled.reduce((a, o) => a + o.total, 0), count: settled.length, byMethod },
    };
  },
});

// ---------------------------------------------------------------------------
// Tables & QR
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/dine/tables/:id/qr", tag: "dine", summary: "QR code image for a table (menu / ordering)",
  auth: { product: "dine", feature: ["qr_menu", "qr_ordering"], permission: "tables.view" },
  handler: async (ctx) => {
    const t = await ctx.db.dineTable.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId } });
    if (!t) throw notFound("Table");
    const url = `${appUrl()}/m/${t.qrToken}`;
    return { url, dataUrl: await QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: "M" }), table: t.name };
  },
});

route({
  method: "POST", path: "/dine/tables/:id/regenerate-qr", tag: "dine", summary: "Rotate a table's QR code (old prints stop working)",
  auth: { product: "dine", feature: "tables", permission: "tables.manage" },
  handler: async (ctx) => {
    const t = await ctx.db.dineTable.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId } });
    if (!t) throw notFound("Table");
    await ctx.db.dineTable.update({ where: { id: t.id }, data: { qrToken: token(16) } });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/dine/tables/:id/status", tag: "dine", summary: "Set table status (free / reserved / cleaning)",
  auth: { product: "dine", feature: ["tables", "waiter"], permission: ["tables.manage", "orders.manage"] },
  body: z.object({ status: z.enum(["FREE", "RESERVED", "CLEANING"]) }),
  handler: async (ctx) => {
    const t = await ctx.db.dineTable.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId, branchId: ctx.branchId } });
    if (!t) throw notFound("Table");
    const open = await ctx.db.dineOrder.count({ where: { tableId: t.id, status: "OPEN" } });
    if (open) throw conflict("This table has an open order. Settle or move it first.");
    await ctx.db.dineTable.update({ where: { id: t.id }, data: { status: ctx.body.status } });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

const ORDERS_READ = { product: "dine", feature: ["orders", "waiter", "cashier", "pos"], permission: "orders.view" } as const;
const ORDERS_WRITE = { product: "dine", feature: ["orders", "waiter", "pos"], permission: "orders.manage" } as const;

route({
  method: "GET", path: "/dine/orders", tag: "dine", summary: "List orders", auth: ORDERS_READ,
  query: z.object({ status: z.enum(["OPEN", "PAID", "CANCELLED"]).optional(), date: isoDate.optional(), q: z.string().max(40).optional() }),
  handler: async (ctx) => {
    const where: Prisma.DineOrderWhereInput = { tenantId: ctx.tenantId, branchId: ctx.branchId };
    if (ctx.query.status) where.status = ctx.query.status;
    if (ctx.query.date) where.createdAt = { gte: startOfDayIST(ctx.query.date), lte: endOfDayIST(ctx.query.date) };
    if (ctx.query.q) {
      const n = Number(ctx.query.q);
      where.OR = [{ customerName: { contains: ctx.query.q, mode: "insensitive" } }, { customerPhone: { contains: ctx.query.q } }, { invoiceNo: { contains: ctx.query.q } }, ...(Number.isInteger(n) ? [{ orderNo: n }] : [])];
    }
    const items = await ctx.db.dineOrder.findMany({ where, include: orderInclude, orderBy: { createdAt: "desc" }, take: 200 });
    return { items };
  },
});

route({
  method: "GET", path: "/dine/orders/:id", tag: "dine", summary: "Order detail", auth: ORDERS_READ,
  handler: (ctx) => loadOrder(ctx, ctx.params.id),
});

route({
  method: "POST", path: "/dine/orders", tag: "dine", summary: "Create an order (POS or waiter) and optionally send a KOT", auth: ORDERS_WRITE,
  body: z.object({
    tableId: z.uuid().nullable().optional(),
    type: z.enum(["DINE_IN", "TAKEAWAY", "DELIVERY"]).default("DINE_IN"),
    source: z.enum(["POS", "WAITER"]).default("WAITER"),
    customerName: z.string().max(80).optional(),
    customerPhone: z.string().max(20).optional(),
    guests: z.number().int().min(1).max(100).default(1),
    notes: z.string().max(200).optional(),
    items: z.array(itemInput).max(100).default([]),
    sendToKitchen: z.boolean().default(true),
  }),
  handler: async (ctx) => {
    const b = ctx.body;
    if (b.type === "DINE_IN" && !b.tableId) throw badRequest("Select a table for a dine-in order.");
    let table = null;
    if (b.tableId) {
      table = await ctx.db.dineTable.findFirst({ where: { id: b.tableId, tenantId: ctx.tenantId, branchId: ctx.branchId, isActive: true } });
      if (!table) throw badRequest("Unknown table.");
      const existing = await ctx.db.dineOrder.findFirst({ where: { tableId: table.id, status: "OPEN" } });
      if (existing) throw new HttpError(409, "TABLE_OCCUPIED", `Table ${table.name} already has an open order.`, { orderId: existing.id });
    }
    const lines = await priceItems(ctx.db, ctx.tenantId, b.items);
    const orderNo = await nextSeq(ctx.db, ctx.tenantId, "dine-order");
    const order = await ctx.db.dineOrder.create({
      data: {
        tenantId: ctx.tenantId, branchId: ctx.branchId, orderNo, tableId: table?.id ?? null, type: b.type, source: b.source,
        customerName: b.customerName || null, customerPhone: b.customerPhone || null, guests: b.guests, notes: b.notes || null,
        waiterId: b.source === "WAITER" ? ctx.user.id : null, createdById: ctx.user.id, publicToken: token(18),
        items: { create: lines.map((l) => ({ ...l, tenantId: ctx.tenantId })) },
      },
      include: { table: true },
    });
    if (table) await ctx.db.dineTable.update({ where: { id: table.id }, data: { status: "OCCUPIED" } });
    if (b.sendToKitchen) await sendKot(ctx.db, ctx.tenantId, order);
    await recalc(ctx.db, order.id);
    await ctx.audit("dine.order.create", { type: "dine_order", id: order.id }, { orderNo, items: lines.length });
    ctx.status = 201;
    return loadOrder(ctx, order.id);
  },
});

route({
  method: "POST", path: "/dine/orders/:id/items", tag: "dine", summary: "Add items to an open order", auth: ORDERS_WRITE,
  body: z.object({ items: z.array(itemInput).min(1).max(100), sendToKitchen: z.boolean().default(true) }),
  handler: async (ctx) => {
    const o = await loadOrder(ctx, ctx.params.id);
    if (o.status !== "OPEN") throw conflict("Only open orders can be changed.");
    const lines = await priceItems(ctx.db, ctx.tenantId, ctx.body.items);
    await ctx.db.dineOrderItem.createMany({ data: lines.map((l) => ({ ...l, tenantId: ctx.tenantId, orderId: o.id })) });
    if (ctx.body.sendToKitchen) await sendKot(ctx.db, ctx.tenantId, o);
    await recalc(ctx.db, o.id);
    return loadOrder(ctx, o.id);
  },
});

route({
  method: "POST", path: "/dine/orders/:id/kot", tag: "dine", summary: "Send unsent items to the kitchen as a KOT", auth: ORDERS_WRITE,
  handler: async (ctx) => {
    const o = await loadOrder(ctx, ctx.params.id);
    if (o.status !== "OPEN") throw conflict("Order is not open.");
    const kot = await sendKot(ctx.db, ctx.tenantId, o);
    if (!kot) throw badRequest("No new items to send.");
    return { kot };
  },
});

route({
  method: "POST", path: "/dine/orders/:id/accept", tag: "dine", summary: "Accept items a customer ordered by QR and send them to the kitchen",
  auth: { product: "dine", feature: "qr_ordering", permission: "orders.manage" },
  body: z.object({ reject: z.boolean().default(false) }),
  handler: async (ctx) => {
    const o = await loadOrder(ctx, ctx.params.id);
    const pending = o.items.filter((i) => i.status === "PENDING_ACCEPT");
    if (!pending.length) throw badRequest("Nothing waiting for acceptance.");
    await ctx.db.dineOrderItem.updateMany({
      where: { id: { in: pending.map((p) => p.id) } },
      data: { status: ctx.body.reject ? "CANCELLED" : "NEW" },
    });
    if (!ctx.body.reject) {
      if (!o.waiterId) await ctx.db.dineOrder.update({ where: { id: o.id }, data: { waiterId: ctx.user.id } });
      await sendKot(ctx.db, ctx.tenantId, o);
    }
    await recalc(ctx.db, o.id);
    return loadOrder(ctx, o.id);
  },
});

route({
  method: "PATCH", path: "/dine/order-items/:id", tag: "dine", summary: "Mark an item served, change quantity or cancel it", auth: ORDERS_WRITE,
  body: z.object({ status: z.enum(["SERVED", "CANCELLED"]).optional(), qty: z.number().int().min(1).max(500).optional() }),
  handler: async (ctx) => {
    const item = await ctx.db.dineOrderItem.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId }, include: { order: true } });
    if (!item || item.order.branchId !== ctx.branchId) throw notFound("Order item");
    if (item.order.status !== "OPEN") throw conflict("Order is closed.");
    if (ctx.body.qty !== undefined) {
      if (item.status !== "NEW" && item.status !== "PENDING_ACCEPT") throw conflict("Quantity can only change before the item is sent to the kitchen.");
      await ctx.db.dineOrderItem.update({ where: { id: item.id }, data: { qty: ctx.body.qty } });
    }
    if (ctx.body.status === "CANCELLED") {
      if (["PREPARING", "READY", "SERVED"].includes(item.status) && !ctx.can("billing.discount"))
        throw forbidden("PERMISSION_DENIED", "Only a cashier or manager can void an item already being prepared.");
      await ctx.db.dineOrderItem.update({ where: { id: item.id }, data: { status: "CANCELLED" } });
    }
    if (ctx.body.status === "SERVED") await ctx.db.dineOrderItem.update({ where: { id: item.id }, data: { status: "SERVED" } });
    await recalc(ctx.db, item.orderId);
    return loadOrder(ctx, item.orderId);
  },
});

route({
  method: "POST", path: "/dine/orders/:id/cancel", tag: "dine", summary: "Cancel an open order",
  auth: { product: "dine", feature: ["orders", "cashier", "pos"], permission: "billing.discount" },
  body: z.object({ reason: z.string().trim().min(3).max(200) }),
  handler: async (ctx) => {
    const o = await loadOrder(ctx, ctx.params.id);
    if (o.status !== "OPEN") throw conflict("Only open orders can be cancelled.");
    await ctx.db.dineOrder.update({ where: { id: o.id }, data: { status: "CANCELLED", cancelledReason: ctx.body.reason } });
    await ctx.db.dineOrderItem.updateMany({ where: { orderId: o.id }, data: { status: "CANCELLED" } });
    await ctx.db.dineKitchenOrder.updateMany({ where: { orderId: o.id, status: { in: ["NEW", "PREPARING", "READY"] } }, data: { status: "CANCELLED" } });
    if (o.tableId) await ctx.db.dineTable.update({ where: { id: o.tableId }, data: { status: "FREE" } });
    await ctx.audit("dine.order.cancel", { type: "dine_order", id: o.id }, { reason: ctx.body.reason, total: o.total });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/dine/orders/:id/settle", tag: "dine", summary: "Settle the bill: payment, invoice number, stock deduction, free table",
  auth: { product: "dine", feature: ["cashier", "pos"], permission: "billing.settle" },
  body: z.object({
    paymentMethod: z.enum(["CASH", "UPI", "CARD", "WALLET", "CREDIT", "OTHER", "SPLIT"]),
    /** Required when paymentMethod = SPLIT; the parts must add up to the bill total. */
    split: splitPartsSchema.optional(),
    discount: z.number().int().min(0).optional(),
    customerName: z.string().max(80).optional(),
    customerPhone: z.string().max(20).optional(),
  }),
  handler: async (ctx) => {
    const o = await loadOrder(ctx, ctx.params.id);
    if (o.status !== "OPEN") throw conflict("This order is already closed.");
    if (o.items.some((i) => i.status === "PENDING_ACCEPT")) throw conflict("Accept or reject the QR-ordered items first.");
    const live = o.items.filter((i) => i.status !== "CANCELLED");
    if (!live.length) throw badRequest("The order has no items.");
    if (ctx.body.paymentMethod === "SPLIT" && !ctx.body.split) throw badRequest("Enter the amount paid by each method for a split payment.");
    if (ctx.body.discount && ctx.body.discount !== o.discount && !ctx.can("billing.discount"))
      throw forbidden("PERMISSION_DENIED", "Your role cannot apply discounts.");

    const settings = await getProductSettings(ctx.db, ctx.tenantId, "dine");
    const seq = await nextSeq(ctx.db, ctx.tenantId, `dine-invoice-${financialYear(todayIST()).label}`);
    const invoiceNo = `${settings.invoicePrefix}/${financialYear(todayIST()).label}/${String(seq).padStart(5, "0")}`;
    await recalc(ctx.db, o.id, ctx.body.discount ?? o.discount);
    let split: { method: string; amount: number }[] | null = null;
    if (ctx.body.paymentMethod === "SPLIT") {
      // Checked against the recalculated total (discount applied), inside the same transaction.
      const { total } = await ctx.db.dineOrder.findUniqueOrThrow({ where: { id: o.id }, select: { total: true } });
      try { split = assertSplitMatches(ctx.body.split!, total); } catch (e) { throw badRequest((e as Error).message); }
    }
    const order = await ctx.db.dineOrder.update({
      where: { id: o.id },
      data: {
        status: "PAID", paymentMethod: ctx.body.paymentMethod, ...(split ? { paymentSplit: split } : {}), paidAt: new Date(), settledById: ctx.user.id, invoiceNo,
        ...(ctx.body.customerName ? { customerName: ctx.body.customerName } : {}),
        ...(ctx.body.customerPhone ? { customerPhone: ctx.body.customerPhone } : {}),
      },
    });
    await ctx.db.dineOrderItem.updateMany({ where: { orderId: o.id, status: "READY" }, data: { status: "SERVED" } });
    await ctx.db.dineKitchenOrder.updateMany({ where: { orderId: o.id, status: "READY" }, data: { status: "SERVED", servedAt: new Date() } });
    if (o.tableId) await ctx.db.dineTable.update({ where: { id: o.tableId }, data: { status: "FREE" } });

    // Stock: packaged products always (Basic); recipe ingredients with Growth auto-deduction.
    const menuIds = [...new Set(live.map((i) => i.menuItemId))];
    const menu = await ctx.db.dineMenuItem.findMany({ where: { id: { in: menuIds } }, include: { recipe: true } });
    const ref = `Order #${o.orderNo}`;
    const deductions = new Map<string, number>();
    for (const line of live) {
      const m = menu.find((x) => x.id === line.menuItemId);
      if (!m) continue;
      if (m.stockItemId && ctx.has("products")) deductions.set(m.stockItemId, (deductions.get(m.stockItemId) ?? 0) + line.qty);
      if (ctx.has("auto_deduction"))
        for (const r of m.recipe) deductions.set(r.stockItemId, (deductions.get(r.stockItemId) ?? 0) + r.quantity * line.qty);
    }
    for (const [stockItemId, qty] of deductions)
      await moveDineStock(ctx.db, ctx.tenantId, stockItemId, -qty, "SALE", { reference: ref, userId: ctx.user.id });

    await ctx.audit("dine.order.settle", { type: "dine_order", id: o.id }, { invoiceNo, total: order.total, method: ctx.body.paymentMethod, ...(split ? { split } : {}) });
    const business = await ctx.db.business.findUniqueOrThrow({ where: { tenantId: ctx.tenantId } });
    return {
      order: await loadOrder(ctx, o.id),
      ...(ctx.has("whatsapp_invoice") ? invoiceLinks(order, settings.restaurantName || business.name) : { invoiceUrl: `${appUrl()}/invoice/dine/${order.publicToken}` }),
    };
  },
});

route({
  method: "GET", path: "/dine/orders/:id/share", tag: "dine", summary: "Invoice link and WhatsApp share link",
  auth: { product: "dine", feature: "whatsapp_invoice", permission: ["billing.settle", "orders.view"] },
  query: z.object({ phone: z.string().max(20).optional() }),
  handler: async (ctx) => {
    const o = await loadOrder(ctx, ctx.params.id);
    if (o.status === "CANCELLED") throw conflict("This order was cancelled.");
    const business = await ctx.db.business.findUniqueOrThrow({ where: { tenantId: ctx.tenantId } });
    const settings = await getProductSettings(ctx.db, ctx.tenantId, "dine");
    return invoiceLinks({ ...o, customerPhone: ctx.query.phone || o.customerPhone }, settings.restaurantName || business.name);
  },
});

// ---------------------------------------------------------------------------
// Kitchen Display System
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/dine/kitchen/tickets", tag: "dine", summary: "Kitchen display: active KOTs",
  auth: { product: "dine", feature: "kds", permission: "kitchen.view" },
  handler: async (ctx) => {
    const recent = new Date(Date.now() - 30 * 60_000);
    const tickets = await ctx.db.dineKitchenOrder.findMany({
      where: {
        tenantId: ctx.tenantId, branchId: ctx.branchId,
        OR: [{ status: { in: ["NEW", "PREPARING"] } }, { status: "READY", readyAt: { gte: recent } }],
      },
      include: { items: { where: { status: { not: "CANCELLED" } } }, order: { select: { orderNo: true, type: true, notes: true, guests: true } } },
      orderBy: { createdAt: "asc" },
    });
    return { items: tickets, serverTime: new Date() };
  },
});

route({
  method: "POST", path: "/dine/kitchen/tickets/:id/status", tag: "dine", summary: "Move a KOT: NEW -> PREPARING -> READY -> SERVED",
  auth: { product: "dine", feature: ["kds", "waiter"], permission: ["kitchen.update", "orders.manage"] },
  body: z.object({ status: z.enum(["PREPARING", "READY", "SERVED"]) }),
  handler: async (ctx) => {
    const k = await ctx.db.dineKitchenOrder.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId, branchId: ctx.branchId } });
    if (!k) throw notFound("Kitchen ticket");
    const s = ctx.body.status;
    if (s !== "SERVED") ctx.require({ feature: "kds", permission: "kitchen.update" });
    else ctx.require({ permission: "orders.manage" });
    const now = new Date();
    await ctx.db.dineKitchenOrder.update({
      where: { id: k.id },
      data: { status: s, ...(s === "PREPARING" ? { startedAt: now } : s === "READY" ? { readyAt: now } : { servedAt: now }) },
    });
    await ctx.db.dineOrderItem.updateMany({ where: { kotId: k.id, status: { not: "CANCELLED" } }, data: { status: s } });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/dine/menu-items/:id/availability", tag: "dine", summary: "Mark an item available / sold out",
  auth: { product: "dine", feature: ["menu", "kds"], permission: ["menu.availability", "menu.manage"] },
  body: z.object({ isAvailable: z.boolean() }),
  handler: async (ctx) => {
    const m = await ctx.db.dineMenuItem.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId } });
    if (!m) throw notFound("Menu item");
    await ctx.db.dineMenuItem.update({ where: { id: m.id }, data: { isAvailable: ctx.body.isAvailable } });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Inventory (Basic) and advanced stock (Growth)
// ---------------------------------------------------------------------------

route({
  method: "POST", path: "/dine/stock-items/:id/adjust", tag: "dine", summary: "Stock in / correction (basic inventory)",
  auth: { product: "dine", feature: "inventory_basic", permission: "inventory.manage" },
  body: z.object({ quantity: z.number().finite().refine((n) => n !== 0, "Quantity cannot be zero"), type: z.enum(["PURCHASE", "ADJUSTMENT"]), reason: z.string().max(200).optional() }),
  handler: async (ctx) => {
    const s = await ctx.db.dineStockItem.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId } });
    if (!s) throw notFound("Stock item");
    if (s.quantity + ctx.body.quantity < 0) throw badRequest("Stock cannot go below zero.");
    const balance = await moveDineStock(ctx.db, ctx.tenantId, s.id, ctx.body.quantity, ctx.body.type, { reason: ctx.body.reason, userId: ctx.user.id });
    return { quantity: balance };
  },
});

route({
  method: "GET", path: "/dine/stock/low", tag: "dine", summary: "Low-stock alerts",
  auth: { product: "dine", feature: "low_stock_alerts", permission: "inventory.view" },
  handler: async (ctx) => {
    const items = await ctx.db.dineStockItem.findMany({ where: { tenantId: ctx.tenantId, isActive: true }, orderBy: { name: "asc" } });
    return { items: items.filter((i) => i.quantity <= i.reorderLevel) };
  },
});

route({
  method: "GET", path: "/dine/stock/movements", tag: "dine", summary: "Stock ledger (advanced stock management)",
  auth: { product: "dine", feature: "inventory_advanced", permission: "inventory.view" },
  query: z.object({ stockItemId: z.uuid().optional(), from: isoDate.optional(), to: isoDate.optional() }),
  handler: async (ctx) => {
    const to = ctx.query.to ?? todayIST();
    const from = ctx.query.from ?? addDays(to, -30);
    const items = await ctx.db.dineStockMovement.findMany({
      where: { tenantId: ctx.tenantId, ...(ctx.query.stockItemId ? { stockItemId: ctx.query.stockItemId } : {}), createdAt: { gte: startOfDayIST(from), lte: endOfDayIST(to) } },
      include: { stockItem: { select: { name: true, unit: true } } }, orderBy: { createdAt: "desc" }, take: 1000,
    });
    return { from, to, items };
  },
});

route({
  method: "GET", path: "/dine/stock/valuation", tag: "dine", summary: "Stock valuation and consumption summary",
  auth: { product: "dine", feature: "inventory_advanced", permission: "inventory.view" },
  handler: async (ctx) => {
    const items = await ctx.db.dineStockItem.findMany({ where: { tenantId: ctx.tenantId, isActive: true }, orderBy: { name: "asc" } });
    const since = startOfDayIST(addDays(todayIST(), -29));
    const usage = await ctx.db.dineStockMovement.groupBy({ by: ["stockItemId", "type"], _sum: { quantity: true }, where: { tenantId: ctx.tenantId, createdAt: { gte: since } } });
    return {
      totalValue: items.reduce((a, i) => a + Math.round(Math.max(0, i.quantity) * i.costPerUnit), 0),
      items: items.map((i) => {
        const used = -(usage.find((u) => u.stockItemId === i.id && u.type === "SALE")?._sum.quantity ?? 0);
        const wasted = -(usage.find((u) => u.stockItemId === i.id && u.type === "WASTAGE")?._sum.quantity ?? 0);
        const daily = used / 30;
        return {
          id: i.id, name: i.name, kind: i.kind, unit: i.unit, quantity: i.quantity, costPerUnit: i.costPerUnit,
          value: Math.round(Math.max(0, i.quantity) * i.costPerUnit), used30d: round3(used), wasted30d: round3(wasted),
          daysOfCover: daily > 0 ? Math.floor(i.quantity / daily) : null, reorderLevel: i.reorderLevel,
        };
      }),
    };
  },
});

// Recipes / ingredients (Growth)
const RECIPES = { product: "dine", feature: "ingredients", permission: ["inventory.manage", "menu.manage"] } as const;

route({
  method: "GET", path: "/dine/recipes", tag: "dine", summary: "Menu items with ingredient recipes and food cost", auth: RECIPES,
  handler: async (ctx) => {
    const items = await ctx.db.dineMenuItem.findMany({
      where: { tenantId: ctx.tenantId, isActive: true },
      include: { recipe: { include: { stockItem: { select: { name: true, unit: true, costPerUnit: true } } } }, category: { select: { name: true } } },
      orderBy: [{ category: { sortOrder: "asc" } }, { name: "asc" }],
    });
    return {
      items: items.map((m) => {
        const cost = Math.round(m.recipe.reduce((a, r) => a + r.quantity * r.stockItem.costPerUnit, 0));
        return {
          id: m.id, name: m.name, category: m.category.name, price: m.price, foodCost: cost,
          foodCostPct: m.price ? Math.round((cost / m.price) * 1000) / 10 : 0,
          recipe: m.recipe.map((r) => ({ stockItemId: r.stockItemId, name: r.stockItem.name, unit: r.stockItem.unit, quantity: r.quantity })),
        };
      }),
    };
  },
});

route({
  method: "PUT", path: "/dine/menu-items/:id/recipe", tag: "dine", summary: "Set the ingredients used per portion", auth: RECIPES,
  body: z.object({ items: z.array(z.object({ stockItemId: z.uuid(), quantity: z.number().positive().max(100000) })).max(50) }),
  handler: async (ctx) => {
    const m = await ctx.db.dineMenuItem.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId } });
    if (!m) throw notFound("Menu item");
    const ids = ctx.body.items.map((i) => i.stockItemId);
    if (new Set(ids).size !== ids.length) throw badRequest("Each ingredient can appear once.");
    const found = await ctx.db.dineStockItem.count({ where: { id: { in: ids }, tenantId: ctx.tenantId } });
    if (found !== ids.length) throw badRequest("Unknown ingredient.");
    await ctx.db.dineRecipeItem.deleteMany({ where: { menuItemId: m.id } });
    if (ids.length)
      await ctx.db.dineRecipeItem.createMany({ data: ctx.body.items.map((i) => ({ tenantId: ctx.tenantId, menuItemId: m.id, stockItemId: i.stockItemId, quantity: round3(i.quantity) })) });
    return { ok: true };
  },
});

// Purchases (Growth)
const PURCHASES = { product: "dine", feature: "purchases", permission: "purchases.manage" } as const;

route({
  method: "GET", path: "/dine/purchases", tag: "dine", summary: "Purchase orders", auth: PURCHASES,
  handler: async (ctx) => ({
    items: await ctx.db.dinePurchase.findMany({
      where: { tenantId: ctx.tenantId },
      include: { supplier: { select: { name: true } }, items: { include: { stockItem: { select: { name: true, unit: true } } } } },
      orderBy: { orderedAt: "desc" }, take: 200,
    }),
  }),
});

async function receiveDinePurchase(ctx: Ctx, purchaseId: string) {
  const p = await ctx.db.dinePurchase.findFirstOrThrow({ where: { id: purchaseId, tenantId: ctx.tenantId }, include: { items: true } });
  for (const i of p.items) {
    await moveDineStock(ctx.db, ctx.tenantId, i.stockItemId, i.quantity, "PURCHASE", { reference: `PO #${p.purchaseNo}`, userId: ctx.user.id });
    await ctx.db.dineStockItem.update({ where: { id: i.stockItemId }, data: { costPerUnit: i.unitCost } });
  }
  await ctx.db.dinePurchase.update({ where: { id: p.id }, data: { status: "RECEIVED", receivedAt: new Date() } });
}

route({
  method: "POST", path: "/dine/purchases", tag: "dine", summary: "Create a purchase order (optionally receive immediately)", auth: PURCHASES,
  body: z.object({
    supplierId: z.uuid(), invoiceRef: z.string().max(60).optional(), notes: z.string().max(300).optional(), receiveNow: z.boolean().default(false),
    items: z.array(z.object({ stockItemId: z.uuid(), quantity: z.number().positive().max(1_000_000), unitCost: z.number().int().min(0) })).min(1).max(100),
  }),
  handler: async (ctx) => {
    const sup = await ctx.db.dineSupplier.findFirst({ where: { id: ctx.body.supplierId, tenantId: ctx.tenantId } });
    if (!sup) throw badRequest("Unknown supplier.");
    const ids = [...new Set(ctx.body.items.map((i) => i.stockItemId))];
    if ((await ctx.db.dineStockItem.count({ where: { id: { in: ids }, tenantId: ctx.tenantId } })) !== ids.length) throw badRequest("Unknown stock item.");
    const purchaseNo = await nextSeq(ctx.db, ctx.tenantId, "dine-purchase");
    const p = await ctx.db.dinePurchase.create({
      data: {
        tenantId: ctx.tenantId, purchaseNo, supplierId: sup.id, invoiceRef: ctx.body.invoiceRef, notes: ctx.body.notes, createdById: ctx.user.id,
        total: Math.round(ctx.body.items.reduce((a, i) => a + i.quantity * i.unitCost, 0)),
        items: { create: ctx.body.items.map((i) => ({ ...i, quantity: round3(i.quantity), tenantId: ctx.tenantId })) },
      },
    });
    if (ctx.body.receiveNow) await receiveDinePurchase(ctx, p.id);
    ctx.status = 201;
    return p;
  },
});

route({
  method: "POST", path: "/dine/purchases/:id/receive", tag: "dine", summary: "Receive goods: adds stock and updates unit cost", auth: PURCHASES,
  handler: async (ctx) => {
    const p = await ctx.db.dinePurchase.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId } });
    if (!p) throw notFound("Purchase");
    if (p.status !== "ORDERED") throw conflict("Only ordered purchases can be received.");
    await receiveDinePurchase(ctx, p.id);
    return { ok: true };
  },
});

route({
  method: "POST", path: "/dine/purchases/:id/cancel", tag: "dine", summary: "Cancel a purchase order", auth: PURCHASES,
  handler: async (ctx) => {
    const p = await ctx.db.dinePurchase.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId } });
    if (!p) throw notFound("Purchase");
    if (p.status !== "ORDERED") throw conflict("Only ordered purchases can be cancelled.");
    await ctx.db.dinePurchase.update({ where: { id: p.id }, data: { status: "CANCELLED" } });
    return { ok: true };
  },
});

// Wastage (Growth)
const WASTAGE = { product: "dine", feature: "wastage", permission: "inventory.manage" } as const;

route({
  method: "GET", path: "/dine/wastage", tag: "dine", summary: "Wastage records", auth: WASTAGE, query: rangeQuery,
  handler: async (ctx) => {
    const items = await ctx.db.dineWastage.findMany({
      where: { tenantId: ctx.tenantId, createdAt: { gte: ctx.query.gte, lte: ctx.query.lte } },
      include: { stockItem: { select: { name: true, unit: true } } }, orderBy: { createdAt: "desc" },
    });
    return { items, totalCost: items.reduce((a, w) => a + w.costValue, 0), from: ctx.query.from, to: ctx.query.to };
  },
});

route({
  method: "POST", path: "/dine/wastage", tag: "dine", summary: "Record wastage (deducts stock)", auth: WASTAGE,
  body: z.object({ stockItemId: z.uuid(), quantity: z.number().positive().max(100000), reason: z.string().trim().min(2).max(200) }),
  handler: async (ctx) => {
    const s = await ctx.db.dineStockItem.findFirst({ where: { id: ctx.body.stockItemId, tenantId: ctx.tenantId } });
    if (!s) throw badRequest("Unknown stock item.");
    if (s.quantity < ctx.body.quantity) throw badRequest(`Only ${s.quantity} ${s.unit} in stock.`);
    await moveDineStock(ctx.db, ctx.tenantId, s.id, -ctx.body.quantity, "WASTAGE", { reason: ctx.body.reason, userId: ctx.user.id });
    const w = await ctx.db.dineWastage.create({
      data: { tenantId: ctx.tenantId, stockItemId: s.id, quantity: round3(ctx.body.quantity), reason: ctx.body.reason, costValue: Math.round(ctx.body.quantity * s.costPerUnit), recordedById: ctx.user.id },
    });
    ctx.status = 201;
    return w;
  },
});

// ---------------------------------------------------------------------------
// Reports (Basic) and analytics (Growth)
// ---------------------------------------------------------------------------

async function paidOrders(ctx: Ctx, gte: Date, lte: Date) {
  return ctx.db.dineOrder.findMany({
    where: { tenantId: ctx.tenantId, branchId: ctx.branchId, status: "PAID", paidAt: { gte, lte } },
    include: { items: { where: { status: { not: "CANCELLED" } } }, waiter: { select: { fullName: true } }, table: { select: { name: true } } },
  });
}

route({
  method: "GET", path: "/dine/reports/sales", tag: "dine", summary: "Sales report: totals, daily trend, payment split, top items",
  auth: { product: "dine", feature: "reports_basic", permission: "reports.view" }, query: rangeQuery,
  handler: async (ctx) => {
    const { from, to, gte, lte } = ctx.query;
    const [orders, cancelled] = await Promise.all([
      paidOrders(ctx, gte, lte),
      ctx.db.dineOrder.count({ where: { tenantId: ctx.tenantId, branchId: ctx.branchId, status: "CANCELLED", updatedAt: { gte, lte } } }),
    ]);
    const days: Record<string, { date: string; sales: number; orders: number }> = {};
    for (let d = from; d <= to; d = addDays(d, 1)) days[d] = { date: d, sales: 0, orders: 0 };
    const methods: Record<string, number> = {};
    const items: Record<string, { name: string; qty: number; revenue: number }> = {};
    for (const o of orders) {
      const d = istDate(o.paidAt!);
      if (days[d]) { days[d].sales += o.total; days[d].orders++; }
      addTenders(methods, o);
      for (const i of o.items) {
        items[i.menuItemId] ??= { name: i.name, qty: 0, revenue: 0 };
        items[i.menuItemId].qty += i.qty;
        items[i.menuItemId].revenue += i.unitPrice * i.qty;
      }
    }
    const sum = (k: "subtotal" | "discount" | "taxTotal" | "total") => orders.reduce((a, o) => a + o[k], 0);
    return {
      from, to,
      totals: { orders: orders.length, gross: sum("subtotal"), discount: sum("discount"), tax: sum("taxTotal"), net: sum("total"), avgTicket: orders.length ? Math.round(sum("total") / orders.length) : 0, cancelled },
      daily: Object.values(days),
      paymentSplit: Object.entries(methods).map(([method, amount]) => ({ method, amount })),
      topItems: Object.values(items).sort((a, b) => b.revenue - a.revenue).slice(0, 15),
    };
  },
});

route({
  method: "GET", path: "/dine/analytics", tag: "dine", summary: "Advanced sales analytics",
  auth: { product: "dine", feature: "analytics_advanced", permission: "analytics.view" }, query: rangeQuery,
  handler: async (ctx) => {
    const { from, to, gte, lte } = ctx.query;
    const span = Math.max(1, Math.round((lte.getTime() - gte.getTime()) / 86_400_000));
    const prevFrom = startOfDayIST(addDays(from, -span));
    const [orders, prev, menu, kots] = await Promise.all([
      paidOrders(ctx, gte, lte),
      ctx.db.dineOrder.aggregate({ _sum: { total: true }, _count: true, where: { tenantId: ctx.tenantId, branchId: ctx.branchId, status: "PAID", paidAt: { gte: prevFrom, lt: gte } } }),
      ctx.db.dineMenuItem.findMany({ where: { tenantId: ctx.tenantId }, include: { category: true, recipe: { include: { stockItem: true } } } }),
      ctx.db.dineKitchenOrder.findMany({ where: { tenantId: ctx.tenantId, branchId: ctx.branchId, createdAt: { gte, lte }, readyAt: { not: null } }, select: { createdAt: true, readyAt: true } }),
    ]);
    const heat = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    const category: Record<string, number> = {};
    const types: Record<string, number> = {};
    const sources: Record<string, number> = {};
    const waiters: Record<string, { name: string; orders: number; sales: number }> = {};
    const itemPerf: Record<string, { name: string; category: string; qty: number; revenue: number; foodCost: number }> = {};
    for (const o of orders) {
      const ist = new Date(o.paidAt!.getTime() + 330 * 60_000);
      heat[ist.getUTCDay()][ist.getUTCHours()] += o.total;
      types[o.type] = (types[o.type] ?? 0) + o.total;
      sources[o.source] = (sources[o.source] ?? 0) + 1;
      if (o.waiter) {
        waiters[o.waiter.fullName] ??= { name: o.waiter.fullName, orders: 0, sales: 0 };
        waiters[o.waiter.fullName].orders++;
        waiters[o.waiter.fullName].sales += o.total;
      }
      for (const i of o.items) {
        const m = menu.find((x) => x.id === i.menuItemId);
        const cat = m?.category.name ?? "Other";
        category[cat] = (category[cat] ?? 0) + i.unitPrice * i.qty;
        const unitCost = m ? m.recipe.reduce((a, r) => a + r.quantity * r.stockItem.costPerUnit, 0) : 0;
        itemPerf[i.menuItemId] ??= { name: i.name, category: cat, qty: 0, revenue: 0, foodCost: 0 };
        itemPerf[i.menuItemId].qty += i.qty;
        itemPerf[i.menuItemId].revenue += i.unitPrice * i.qty;
        itemPerf[i.menuItemId].foodCost += Math.round(unitCost * i.qty);
      }
    }
    const total = orders.reduce((a, o) => a + o.total, 0);
    const prepTimes = kots.map((k) => (k.readyAt!.getTime() - k.createdAt.getTime()) / 60_000);
    return {
      from, to,
      summary: {
        sales: total, orders: orders.length, avgTicket: orders.length ? Math.round(total / orders.length) : 0,
        prevSales: prev._sum.total ?? 0, prevOrders: prev._count,
        growthPct: prev._sum.total ? Math.round(((total - prev._sum.total) / prev._sum.total) * 1000) / 10 : null,
        avgPrepMinutes: prepTimes.length ? Math.round((prepTimes.reduce((a, b) => a + b, 0) / prepTimes.length) * 10) / 10 : null,
        avgGuests: orders.length ? Math.round((orders.reduce((a, o) => a + o.guests, 0) / orders.length) * 10) / 10 : 0,
      },
      heatmap: heat,
      categoryMix: Object.entries(category).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
      orderTypes: Object.entries(types).map(([type, amount]) => ({ type, amount })),
      sources: Object.entries(sources).map(([source, count]) => ({ source, count })),
      waiters: Object.values(waiters).sort((a, b) => b.sales - a.sales),
      items: Object.values(itemPerf).map((i) => ({ ...i, margin: i.revenue - i.foodCost })).sort((a, b) => b.revenue - a.revenue),
    };
  },
});

// ---------------------------------------------------------------------------
// Public: QR menu, QR table ordering, order tracking, invoice
// ---------------------------------------------------------------------------

async function tableByToken(qrToken: string) {
  const t = await withPlatform((db) => db.dineTable.findUnique({ where: { qrToken }, select: { id: true, tenantId: true, branchId: true, name: true, isActive: true } }));
  if (!t || !t.isActive) throw notFound("Table");
  return t;
}

route({
  method: "GET", path: "/public/dine/menu/:qrToken", tag: "public", summary: "Public QR menu for a table",
  auth: { public: true }, rateLimit: { limit: 60, windowMs: 60_000 },
  handler: async (ctx) => {
    const t = await tableByToken(ctx.params.qrToken);
    return withTenant(t.tenantId, async (db) => {
      if (!(await tenantEntitled(db, t.tenantId, "dine", "qr_menu"))) throw new HttpError(404, "MENU_UNAVAILABLE", "This menu is not available.");
      const [business, settings, categories, ordering] = await Promise.all([
        db.business.findUniqueOrThrow({ where: { tenantId: t.tenantId } }),
        getProductSettings(db, t.tenantId, "dine"),
        db.dineMenuCategory.findMany({
          where: { tenantId: t.tenantId, isActive: true }, orderBy: { sortOrder: "asc" },
          include: { items: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, description: true, price: true, taxRate: true, isVeg: true, isAvailable: true } } },
        }),
        tenantEntitled(db, t.tenantId, "dine", "qr_ordering"),
      ]);
      return {
        restaurant: { name: settings.restaurantName || business.name, logoUrl: fileUrl(business.logoKey), phone: business.phone },
        table: t.name, orderingEnabled: ordering,
        categories: categories.filter((c) => c.items.length).map((c) => ({ id: c.id, name: c.name, items: c.items })),
      };
    });
  },
});

route({
  method: "POST", path: "/public/dine/menu/:qrToken/order", tag: "public", summary: "Customer places an order from the table QR",
  auth: { public: true }, rateLimit: { limit: 10, windowMs: 60_000 },
  body: z.object({
    items: z.array(itemInput).min(1).max(50),
    customerName: z.string().trim().max(60).optional(),
    customerPhone: z.string().trim().max(20).optional(),
    notes: z.string().max(200).optional(),
  }),
  handler: async (ctx) => {
    // Per table as well as per IP: a shared table QR cannot be used to flood the kitchen.
    await ctx.limit("qr-table", ctx.params.qrToken, 30, 60 * 60_000);
    const t = await tableByToken(ctx.params.qrToken);
    return withTenant(t.tenantId, async (db) => {
      if (!(await tenantEntitled(db, t.tenantId, "dine", "qr_ordering")))
        throw new HttpError(403, "ORDERING_UNAVAILABLE", "Ordering from the table is not available. Please call a waiter.");
      const settings = await getProductSettings(db, t.tenantId, "dine");
      const lines = await priceItems(db, t.tenantId, ctx.body.items);
      const status = settings.qrOrderingAutoAccept ? "NEW" : "PENDING_ACCEPT";
      let order = await db.dineOrder.findFirst({ where: { tableId: t.id, status: "OPEN" }, include: { table: true } });
      if (!order) {
        const orderNo = await nextSeq(db, t.tenantId, "dine-order");
        order = await db.dineOrder.create({
          data: {
            tenantId: t.tenantId, branchId: t.branchId, orderNo, tableId: t.id, type: "DINE_IN", source: "QR",
            customerName: ctx.body.customerName || null, customerPhone: ctx.body.customerPhone || null, notes: ctx.body.notes || null,
            publicToken: token(18),
          },
          include: { table: true },
        });
        await db.dineTable.update({ where: { id: t.id }, data: { status: "OCCUPIED" } });
      }
      await db.dineOrderItem.createMany({ data: lines.map((l) => ({ ...l, tenantId: t.tenantId, orderId: order!.id, status })) });
      if (status === "NEW") await sendKot(db, t.tenantId, order);
      await recalc(db, order.id);
      ctx.status = 201;
      return { orderToken: order.publicToken, orderNo: order.orderNo, awaitingConfirmation: status === "PENDING_ACCEPT" };
    });
  },
});

async function publicOrder(publicToken: string) {
  const o = await withPlatform((db) => db.dineOrder.findUnique({ where: { publicToken }, select: { id: true, tenantId: true } }));
  if (!o) throw notFound("Order");
  return withTenant(o.tenantId, async (db) => {
    const order = await db.dineOrder.findUniqueOrThrow({ where: { id: o.id }, include: { items: { orderBy: { createdAt: "asc" } }, table: { select: { name: true } } } });
    assertPublicLinkFresh(order.paidAt ?? order.createdAt);
    const business = await db.business.findUniqueOrThrow({ where: { tenantId: o.tenantId } });
    const settings = await getProductSettings(db, o.tenantId, "dine");
    return { order, business: { ...business, logoUrl: fileUrl(business.logoKey) }, settings };
  });
}

route({
  method: "GET", path: "/public/dine/orders/:token", tag: "public", summary: "Customer order tracking",
  auth: { public: true }, rateLimit: { limit: 60, windowMs: 60_000 },
  handler: async (ctx) => {
    const { order, business } = await publicOrder(ctx.params.token);
    return {
      restaurant: business.name, orderNo: order.orderNo, status: order.status, table: order.table?.name ?? null,
      items: order.items.map((i) => ({ name: i.name, qty: i.qty, status: i.status, amount: i.unitPrice * i.qty })),
      total: order.total, invoiceReady: order.status === "PAID",
    };
  },
});

route({
  method: "GET", path: "/public/invoice/dine/:token", tag: "public", summary: "Printable restaurant bill / invoice (unpaid bills carry the restaurant's UPI QR)",
  auth: { public: true }, rateLimit: { limit: 60, windowMs: 60_000 },
  handler: async (ctx) => {
    const { order, business, settings } = await publicOrder(ctx.params.token);
    if (order.status === "CANCELLED") throw notFound("Invoice");
    const paid = order.status === "PAID";
    const sellerName = settings.restaurantName || business.name;
    return {
      kind: "dine", isPaid: paid,
      pay: paid ? null : await shopUpi(business, order.total, `Order ${order.orderNo}`, sellerName),
      seller: { name: settings.restaurantName || business.name, address: [business.address, business.city, business.state, business.pincode].filter(Boolean).join(", "), phone: business.phone, gstin: settings.gstin || business.gstin, logoUrl: business.logoUrl },
      invoiceNo: order.invoiceNo, date: order.paidAt ?? order.createdAt, customer: { name: order.customerName, phone: order.customerPhone },
      meta: [order.table ? `Table ${order.table.name}` : order.type.replace("_", " "), `Order #${order.orderNo}`, ...(paid ? [`Paid by ${describePayment(order)}`] : [])],
      lines: order.items.filter((i) => i.status !== "CANCELLED").map((i) => ({ name: i.name, qty: i.qty, rate: i.unitPrice, taxRate: i.taxRate, amount: i.unitPrice * i.qty })),
      subtotal: order.subtotal, discount: order.discount, tax: order.taxTotal, total: order.total, footer: settings.receiptFooter,
    };
  },
});
