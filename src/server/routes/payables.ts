/**
 * Supplier credit & payables API (SAF Dine Flow). See docs/SUPPLIER-CREDIT.md.
 *
 * Every route needs the plan feature dine.supplier_credit and one of
 *   payables.view   - balances, bills, payments, ledgers, reports, alerts
 *   payables.manage - suppliers, credit purchases, payments, attachments
 *   payables.adjust - cancellations, reversals, adjustments, settings
 * Requests run in the tenant's RLS-scoped transaction (router.ts).
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { currentBusinessDate } from "@/lib/business-day";
import { dateOnly, daysBetween, fromDateOnly, isISODate, type ISODate } from "@/lib/dates";
import {
  ADJUSTMENT_KINDS, billStatus, docNo, MAX_AMOUNT_PAISE, periodRange, PURCHASE_UNITS, SUPPLIER_CATEGORIES, SUPPLIER_PAYMENT_METHODS,
  type ReportPeriod,
} from "@/lib/payables";
import { route, type Ctx } from "../http/router";
import { badRequest, HttpError, notFound } from "../http/errors";
import { getBusinessHours, getProductSettings } from "../core/settings";
import { fileUrl, saveImage } from "../core/storage";
import {
  billsWithDue, cancelPurchase, createSupplier, recordAdjustment, recordPayment, recordPurchase, reverseAdjustment, reversePayment,
  updatePurchaseDetails, updateSupplier, type Actor,
} from "../core/payables";
import { buildPayablesReport, ledgerCsv, payablesReportCsv, payablesReportPdf, payablesSummary, reportTitle, supplierLedger, supplierOverview } from "../core/payables-report";
import { getCreditSettings, onPaymentRecorded, onPurchaseRecorded, PAYABLES_FEATURE, saveCreditSettings } from "../core/payables-alerts";
import { payablesWhatsAppReady } from "../core/whatsapp";

const VIEW = { product: "dine", feature: PAYABLES_FEATURE, permission: "payables.view" } as const;
const MANAGE = { product: "dine", feature: PAYABLES_FEATURE, permission: "payables.manage" } as const;
const ADJUST = { product: "dine", feature: PAYABLES_FEATURE, permission: "payables.adjust" } as const;
const WRITE_LIMIT = { limit: 60, windowMs: 60_000, by: "user" } as const;
const TAG = "supplier-credit";
const MAX_RANGE_DAYS = 366;

const isoDate = z.string().refine(isISODate, "Use YYYY-MM-DD");
const money = z.number().int().min(0).max(MAX_AMOUNT_PAISE);
const positiveMoney = z.number().int().min(1, "Enter an amount above zero").max(MAX_AMOUNT_PAISE);
const text = (max: number) => z.string().trim().max(max).optional().nullable();
const phone = z.union([z.literal(""), z.string().trim().regex(/^[+\d][\d\s-]{6,18}$/, "Enter a valid phone number")]).optional().nullable();
const reason = z.string().trim().min(3, "Please give a reason").max(300);
const clientRef = z.uuid().optional().nullable();
const page = { page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(5).max(100).default(25) };

/** "" -> null for optional text fields. */
function clean<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = typeof v === "string" && v.trim() === "" ? null : v;
  return out as T;
}

async function actorOf(ctx: Ctx): Promise<Actor> {
  const hours = await getBusinessHours(ctx.db, ctx.tenantId, "dine");
  return { tenantId: ctx.tenantId, userId: ctx.user.id, branchId: ctx.branchId || null, today: currentBusinessDate(hours) };
}

function checkRange(from?: ISODate, to?: ISODate) {
  if (from && to && from > to) throw new HttpError(400, "BAD_RANGE", "'from' must be on or before 'to'.");
  if (from && to && daysBetween(from, to) >= MAX_RANGE_DAYS) throw badRequest(`Pick at most ${MAX_RANGE_DAYS} days.`);
}

function paginate<T>(rows: T[], p: { page: number; pageSize: number }) {
  return { items: rows.slice((p.page - 1) * p.pageSize, p.page * p.pageSize), total: rows.length, page: p.page, pageSize: p.pageSize };
}

const attachment = (key: string | null) => (key ? fileUrl(key) : null);

// ---------------------------------------------------------------------------
// Dashboard and suppliers
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/dine/payables/summary", tag: TAG, auth: VIEW,
  summary: "Supplier credit dashboard: totals, overdue, this month's purchases and payments, and every supplier's balance",
  handler: async (ctx) => {
    const a = await actorOf(ctx);
    const [summary, settings] = await Promise.all([payablesSummary(ctx.db, ctx.tenantId, a.today), getCreditSettings(ctx.db, ctx.tenantId)]);
    return { ...summary, totalCreditLimit: settings.totalCreditLimit, linkStockPurchases: settings.linkStockPurchases, usesStockPurchases: ctx.has("purchases") };
  },
});

const supplierFields = {
  name: z.string().trim().min(2, "Enter the supplier's name").max(100),
  businessName: text(120),
  contactPerson: text(80),
  phone,
  whatsapp: phone,
  email: z.union([z.literal(""), z.email().max(120)]).optional().nullable(),
  address: text(300),
  gstin: text(20),
  category: z.enum(SUPPLIER_CATEGORIES).default("OTHER"),
  paymentTermsDays: z.number().int().min(0).max(365).optional().nullable(),
  creditLimit: money.optional().nullable(),
  notes: text(500),
};

route({
  method: "GET", path: "/dine/payables/suppliers", tag: TAG, auth: VIEW,
  summary: "Suppliers with balances: search, filter, sort and pages",
  query: z.object({
    q: z.string().trim().max(100).optional(),
    status: z.enum(["all", "active", "inactive", "owed", "overdue", "advance"]).default("active"),
    category: z.enum(SUPPLIER_CATEGORIES).optional(),
    sort: z.enum(["name", "balance", "overdue", "purchases", "activity"]).default("name"),
    dir: z.enum(["asc", "desc"]).optional(),
    ...page,
  }),
  handler: async (ctx) => {
    const a = await actorOf(ctx);
    const q = ctx.query;
    const needle = q.q?.toLowerCase();
    let rows = (await supplierOverview(ctx.db, ctx.tenantId, a.today)).filter((r) =>
      (q.status === "all" || (q.status === "active" && r.isActive) || (q.status === "inactive" && !r.isActive) ||
        (q.status === "owed" && r.balance > 0) || (q.status === "overdue" && r.overdue > 0) || (q.status === "advance" && r.balance < 0)) &&
      (!q.category || r.category === q.category) &&
      (!needle || [r.name, r.businessName, r.phone, r.whatsapp].some((v) => v?.toLowerCase().includes(needle))));
    const dir = (q.dir ?? (q.sort === "name" ? "asc" : "desc")) === "asc" ? 1 : -1;
    const key: Record<string, (r: (typeof rows)[number]) => number | string> = {
      name: (r) => r.name.toLowerCase(), balance: (r) => r.balance, overdue: (r) => r.overdue, purchases: (r) => r.purchases,
      activity: (r) => r.lastActivity?.getTime() ?? 0,
    };
    rows = [...rows].sort((x, y) => {
      const kx = key[q.sort](x), ky = key[q.sort](y);
      return (kx < ky ? -1 : kx > ky ? 1 : x.name.localeCompare(y.name)) * dir;
    });
    return {
      ...paginate(rows, q),
      totals: { balance: rows.reduce((s, r) => s + r.balance, 0), overdue: rows.reduce((s, r) => s + r.overdue, 0) },
    };
  },
});

route({
  method: "POST", path: "/dine/payables/suppliers", tag: TAG, auth: MANAGE, rateLimit: WRITE_LIMIT, audit: false,
  summary: "Add a supplier (optionally with the balance already owed to them)",
  body: z.object({ ...supplierFields, openingBalance: money.optional(), openingBalanceDate: isoDate.optional() }),
  handler: async (ctx) => {
    const a = await actorOf(ctx);
    const s = await createSupplier(ctx.db, a, clean(ctx.body));
    await ctx.audit("payables.supplier.create", { type: "supplier", id: s.id }, { name: s.name, openingBalance: ctx.body.openingBalance ?? 0 });
    ctx.status = 201;
    return s;
  },
});

route({
  method: "GET", path: "/dine/payables/suppliers/:id", tag: TAG, auth: VIEW,
  summary: "Supplier account: profile, balance, open bills and recent payments",
  handler: async (ctx) => {
    const a = await actorOf(ctx);
    const supplier = await ctx.db.dineSupplier.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId } });
    if (!supplier) throw notFound("Supplier");
    const [[row], bills, payments] = await Promise.all([
      supplierOverview(ctx.db, ctx.tenantId, a.today, { supplierIds: [supplier.id] }),
      billsWithDue(ctx.db, a.today, { tenantId: ctx.tenantId, supplierId: supplier.id, status: "ACTIVE" }, { orderBy: [{ billDate: "asc" }, { billNo: "asc" }] }),
      ctx.db.supplierPayment.findMany({ where: { tenantId: ctx.tenantId, supplierId: supplier.id }, orderBy: [{ paymentDate: "desc" }, { paymentNo: "desc" }], take: 10 }),
    ]);
    return {
      supplier, account: row,
      openBills: bills.filter((b) => b.due > 0),
      recentPayments: payments.map((p) => ({ ...p, number: docNo("payment", p.paymentNo), paymentDate: fromDateOnly(p.paymentDate), receiptKey: undefined, hasReceipt: !!p.receiptKey })),
    };
  },
});

route({
  method: "PATCH", path: "/dine/payables/suppliers/:id", tag: TAG, auth: MANAGE, rateLimit: WRITE_LIMIT, audit: false,
  summary: "Edit a supplier's profile, or deactivate / reactivate it (the balance is never edited here)",
  body: z.object({ ...supplierFields, isActive: z.boolean() }).partial(),
  handler: async (ctx) => {
    const a = await actorOf(ctx);
    const s = await updateSupplier(ctx.db, a, ctx.params.id, clean(ctx.body));
    await ctx.audit(ctx.body.isActive === false ? "payables.supplier.deactivate" : "payables.supplier.update", { type: "supplier", id: s.id }, { fields: Object.keys(ctx.body) });
    return s;
  },
});

route({
  method: "GET", path: "/dine/payables/suppliers/:id/ledger", tag: TAG, auth: VIEW,
  summary: "Supplier ledger with running balance (format=csv to download)",
  query: z.object({ from: isoDate.optional(), to: isoDate.optional(), format: z.enum(["json", "csv"]).default("json") }),
  handler: async (ctx) => {
    checkRange(ctx.query.from, ctx.query.to);
    const supplier = await ctx.db.dineSupplier.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId }, select: { id: true, name: true } });
    if (!supplier) throw notFound("Supplier");
    const l = await supplierLedger(ctx.db, ctx.tenantId, supplier.id, ctx.query);
    if (ctx.query.format === "csv") {
      return new Response(ledgerCsv(supplier.name, l), {
        headers: {
          "content-type": "text/csv; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff",
          "content-disposition": `attachment; filename="supplier-ledger-${supplier.name.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.csv"`,
        },
      });
    }
    return { supplier, from: ctx.query.from ?? null, to: ctx.query.to ?? null, ...l };
  },
});

// ---------------------------------------------------------------------------
// Purchases (bills)
// ---------------------------------------------------------------------------

const BILL_STATUSES = ["OPEN", "PAID", "PARTIALLY_PAID", "UNPAID", "OVERDUE", "CANCELLED"] as const;

route({
  method: "GET", path: "/dine/payables/purchases", tag: TAG, auth: VIEW,
  summary: "Credit purchases with what is still owed: filter by supplier, status, dates, search",
  query: z.object({
    supplierId: z.uuid().optional(),
    status: z.enum(BILL_STATUSES).optional(),
    from: isoDate.optional(), to: isoDate.optional(),
    q: z.string().trim().max(100).optional(),
    ...page,
  }),
  handler: async (ctx) => {
    const a = await actorOf(ctx);
    const q = ctx.query;
    checkRange(q.from, q.to);
    const where: Prisma.SupplierPurchaseWhereInput = {
      tenantId: ctx.tenantId,
      ...(q.supplierId ? { supplierId: q.supplierId } : {}),
      ...(q.status === "CANCELLED" ? { status: "CANCELLED" } : q.status ? { status: "ACTIVE" } : {}),
      ...(q.from || q.to ? { billDate: { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: dateOnly(q.to) } : {}) } } : {}),
      ...(q.q ? {
        OR: [
          { invoiceNo: { contains: q.q, mode: "insensitive" } },
          { supplier: { name: { contains: q.q, mode: "insensitive" } } },
          { items: { some: { productName: { contains: q.q, mode: "insensitive" } } } },
          ...(/^(sp-?)?\d{1,9}$/i.test(q.q) ? [{ billNo: Number(q.q.replace(/\D/g, "")) }] : []),
        ],
      } : {}),
    };
    // Paid / partly paid / overdue depend on allocations: filter after computing what is owed.
    const derived = q.status && q.status !== "CANCELLED";
    if (!derived) {
      const [total, items] = await Promise.all([
        ctx.db.supplierPurchase.count({ where }),
        billsWithDue(ctx.db, a.today, where, { skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      ]);
      return { items, total, page: q.page, pageSize: q.pageSize };
    }
    const all = (await billsWithDue(ctx.db, a.today, where, { take: 5000 })).filter((b) => (q.status === "OPEN" ? b.due > 0 : b.displayStatus === q.status));
    return paginate(all, q);
  },
});

const lineSchema = z.object({
  productName: z.string().trim().min(1, "Enter the product").max(100),
  category: z.enum(SUPPLIER_CATEGORIES).optional(),
  quantity: z.union([z.number().positive(), z.string().trim().min(1)]),
  unit: z.enum(PURCHASE_UNITS),
  rate: money,
  stockItemId: z.uuid().optional().nullable(),
});

route({
  method: "POST", path: "/dine/payables/purchases", tag: TAG, auth: MANAGE, rateLimit: WRITE_LIMIT, audit: false,
  summary: "Record a purchase: fully paid, partly paid or on credit. Total = quantity x rate per line. Repeating the same clientRef returns the first purchase.",
  body: z.object({
    supplierId: z.uuid(),
    billDate: isoDate.optional(),
    dueDate: isoDate.optional().nullable(),
    invoiceNo: text(60),
    notes: text(500),
    items: z.array(lineSchema).min(1, "Add at least one item").max(50),
    amountPaid: money.optional(),
    paymentMethod: z.enum(SUPPLIER_PAYMENT_METHODS).optional(),
    paymentReference: text(100),
    clientRef,
  }),
  handler: async (ctx) => {
    const a = await actorOf(ctx);
    if (ctx.body.items.some((i) => i.stockItemId)) {
      const ids = ctx.body.items.flatMap((i) => (i.stockItemId ? [i.stockItemId] : []));
      if ((await ctx.db.dineStockItem.count({ where: { tenantId: ctx.tenantId, id: { in: ids } } })) !== new Set(ids).size) throw badRequest("A selected stock item does not exist.");
    }
    const r = await recordPurchase(ctx.db, a, clean(ctx.body));
    const [bill] = await billsWithDue(ctx.db, a.today, { id: r.id, tenantId: ctx.tenantId });
    if (!r.duplicate) {
      await onPurchaseRecorded(ctx.db, ctx.tenantId, a.today, bill);
      await ctx.audit("payables.purchase.create", { type: "supplier_purchase", id: r.id }, { supplierId: bill.supplier.id, number: bill.number, total: bill.total, paid: bill.paidAtPurchase });
    }
    ctx.status = r.duplicate ? 200 : 201;
    return { ...bill, duplicate: r.duplicate };
  },
});

route({
  method: "GET", path: "/dine/payables/purchases/:id", tag: TAG, auth: VIEW,
  summary: "One purchase with its lines, how it was settled, and the bill photo",
  handler: async (ctx) => {
    const a = await actorOf(ctx);
    const [bill] = await billsWithDue(ctx.db, a.today, { id: ctx.params.id, tenantId: ctx.tenantId });
    if (!bill) throw notFound("Purchase");
    const [allocations, raw, adjustments] = await Promise.all([
      ctx.db.supplierPaymentAllocation.findMany({
        where: { purchaseId: bill.id, tenantId: ctx.tenantId }, orderBy: { createdAt: "asc" },
        include: { payment: { select: { paymentNo: true, paymentDate: true, method: true, status: true } }, adjustment: { select: { adjustmentNo: true, kind: true, adjustmentDate: true, status: true } } },
      }),
      ctx.db.supplierPurchase.findUniqueOrThrow({ where: { id: bill.id }, select: { attachmentKey: true } }),
      ctx.db.supplierCreditAdjustment.findMany({ where: { tenantId: ctx.tenantId, purchaseId: bill.id }, orderBy: { createdAt: "asc" } }),
    ]);
    return {
      ...bill,
      attachmentUrl: attachment(raw.attachmentKey),
      allocations: allocations.map((x) => ({
        id: x.id, amount: x.amount, createdAt: x.createdAt, voidedAt: x.voidedAt, voidReason: x.voidReason,
        source: x.payment
          ? { kind: "PAYMENT", number: docNo("payment", x.payment.paymentNo), date: fromDateOnly(x.payment.paymentDate), method: x.payment.method, status: x.payment.status }
          : { kind: x.adjustment!.kind, number: docNo("adjustment", x.adjustment!.adjustmentNo), date: fromDateOnly(x.adjustment!.adjustmentDate), status: x.adjustment!.status },
      })),
      adjustments: adjustments.map((x) => ({ ...x, number: docNo("adjustment", x.adjustmentNo), adjustmentDate: fromDateOnly(x.adjustmentDate) })),
    };
  },
});

route({
  method: "PATCH", path: "/dine/payables/purchases/:id", tag: TAG, auth: MANAGE, rateLimit: WRITE_LIMIT, audit: false,
  summary: "Edit a purchase's invoice number, due date or notes (amounts are corrected by cancelling or adjusting)",
  body: z.object({ invoiceNo: text(60), dueDate: isoDate.optional().nullable(), notes: text(500) }),
  handler: async (ctx) => {
    const a = await actorOf(ctx);
    await updatePurchaseDetails(ctx.db, a, ctx.params.id, clean(ctx.body));
    await ctx.audit("payables.purchase.update", { type: "supplier_purchase", id: ctx.params.id }, { fields: Object.keys(ctx.body) });
    const [bill] = await billsWithDue(ctx.db, a.today, { id: ctx.params.id, tenantId: ctx.tenantId });
    return bill;
  },
});

route({
  method: "POST", path: "/dine/payables/purchases/:id/cancel", tag: TAG, auth: ADJUST, rateLimit: WRITE_LIMIT, audit: false,
  summary: "Cancel a purchase entered by mistake (kept in the ledger as a reversal). Optionally reverse the payment made with it.",
  body: z.object({ reason, reversePayments: z.boolean().default(false) }),
  handler: async (ctx) => {
    const a = await actorOf(ctx);
    await cancelPurchase(ctx.db, a, ctx.params.id, ctx.body.reason, { reversePayments: ctx.body.reversePayments });
    await ctx.audit("payables.purchase.cancel", { type: "supplier_purchase", id: ctx.params.id }, { reason: ctx.body.reason, reversePayments: ctx.body.reversePayments });
    const [bill] = await billsWithDue(ctx.db, a.today, { id: ctx.params.id, tenantId: ctx.tenantId });
    return bill;
  },
});

async function storeAttachment(ctx: Ctx, kind: "purchase" | "payment") {
  const file = ctx.form?.get("file");
  const key = await saveImage(ctx.tenantId, "payables", file instanceof File ? file : null);
  if (kind === "purchase") {
    const p = await ctx.db.supplierPurchase.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId }, select: { id: true } });
    if (!p) throw notFound("Purchase");
    await ctx.db.supplierPurchase.update({ where: { id: p.id }, data: { attachmentKey: key } });
  } else {
    const p = await ctx.db.supplierPayment.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId }, select: { id: true } });
    if (!p) throw notFound("Payment");
    await ctx.db.supplierPayment.update({ where: { id: p.id }, data: { receiptKey: key } });
  }
  await ctx.audit(`payables.${kind}.attachment`, { type: `supplier_${kind}`, id: ctx.params.id });
  return { url: attachment(key) };
}

route({
  method: "POST", path: "/dine/payables/purchases/:id/attachment", tag: TAG, auth: MANAGE, multipart: true, audit: false,
  rateLimit: { limit: 20, windowMs: 60_000, by: "user" },
  summary: "Attach a photo of the supplier's bill (PNG/JPEG, max 2 MB)",
  handler: (ctx) => storeAttachment(ctx, "purchase"),
});

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/dine/payables/payments", tag: TAG, auth: VIEW,
  summary: "Payments to suppliers: filter by supplier, dates and status",
  query: z.object({
    supplierId: z.uuid().optional(), from: isoDate.optional(), to: isoDate.optional(),
    status: z.enum(["ACTIVE", "REVERSED"]).optional(), method: z.enum(SUPPLIER_PAYMENT_METHODS).optional(),
    q: z.string().trim().max(100).optional(), ...page,
  }),
  handler: async (ctx) => {
    const q = ctx.query;
    checkRange(q.from, q.to);
    const where: Prisma.SupplierPaymentWhereInput = {
      tenantId: ctx.tenantId,
      ...(q.supplierId ? { supplierId: q.supplierId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.method ? { method: q.method } : {}),
      ...(q.from || q.to ? { paymentDate: { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: dateOnly(q.to) } : {}) } } : {}),
      ...(q.q ? {
        OR: [
          { reference: { contains: q.q, mode: "insensitive" } },
          { supplier: { name: { contains: q.q, mode: "insensitive" } } },
          ...(/^(pay-?)?\d{1,9}$/i.test(q.q) ? [{ paymentNo: Number(q.q.replace(/\D/g, "")) }] : []),
        ],
      } : {}),
    };
    const [total, rows, sums] = await Promise.all([
      ctx.db.supplierPayment.count({ where }),
      ctx.db.supplierPayment.findMany({
        where, orderBy: [{ paymentDate: "desc" }, { paymentNo: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: {
          supplier: { select: { id: true, name: true } },
          allocations: { include: { purchase: { select: { billNo: true } } }, orderBy: { createdAt: "asc" } },
        },
      }),
      ctx.db.supplierPayment.aggregate({ where: { ...where, status: "ACTIVE" }, _sum: { amount: true } }),
    ]);
    return {
      total, page: q.page, pageSize: q.pageSize, totalPaid: sums._sum.amount ?? 0,
      items: rows.map((p) => {
        const live = p.allocations.filter((x) => !x.voidedAt);
        const allocated = live.reduce((s, x) => s + x.amount, 0);
        return {
          id: p.id, number: docNo("payment", p.paymentNo), supplier: p.supplier, paymentDate: fromDateOnly(p.paymentDate), amount: p.amount,
          method: p.method, reference: p.reference, notes: p.notes, status: p.status, isAdvance: p.isAdvance,
          paidWithPurchase: !!p.sourcePurchaseId, hasReceipt: !!p.receiptKey, receiptUrl: attachment(p.receiptKey),
          allocated: p.status === "ACTIVE" ? allocated : 0, unallocated: p.status === "ACTIVE" ? p.amount - allocated : 0,
          bills: live.map((x) => ({ number: docNo("purchase", x.purchase.billNo), amount: x.amount })),
          reversedAt: p.reversedAt, reverseReason: p.reverseReason, createdAt: p.createdAt,
        };
      }),
    };
  },
});

route({
  method: "POST", path: "/dine/payables/payments", tag: TAG, auth: MANAGE, rateLimit: WRITE_LIMIT, audit: false,
  summary: "Pay a supplier. Settles the bills named first, then the oldest open bills. More than the balance only with allowAdvance. Repeating the same clientRef returns the first payment.",
  body: z.object({
    supplierId: z.uuid(),
    paymentDate: isoDate.optional(),
    amount: positiveMoney,
    method: z.enum(SUPPLIER_PAYMENT_METHODS),
    reference: text(100),
    notes: text(500),
    allocations: z.array(z.object({ purchaseId: z.uuid(), amount: positiveMoney })).max(100).optional(),
    allowAdvance: z.boolean().optional(),
    clientRef,
  }),
  handler: async (ctx) => {
    const a = await actorOf(ctx);
    const r = await recordPayment(ctx.db, a, clean(ctx.body));
    const pay = await ctx.db.supplierPayment.findUniqueOrThrow({ where: { id: r.id } });
    if (!r.duplicate) {
      await onPaymentRecorded(ctx.db, ctx.tenantId, pay);
      await ctx.audit("payables.payment.create", { type: "supplier_payment", id: pay.id }, { supplierId: pay.supplierId, number: docNo("payment", pay.paymentNo), amount: pay.amount, method: pay.method, advance: pay.isAdvance });
    }
    ctx.status = r.duplicate ? 200 : 201;
    return { ...pay, number: docNo("payment", pay.paymentNo), paymentDate: fromDateOnly(pay.paymentDate), receiptKey: undefined, duplicate: r.duplicate };
  },
});

route({
  method: "POST", path: "/dine/payables/payments/:id/reverse", tag: TAG, auth: ADJUST, rateLimit: WRITE_LIMIT, audit: false,
  summary: "Reverse a payment entered by mistake: the bills it settled are owed again (kept in the ledger)",
  body: z.object({ reason }),
  handler: async (ctx) => {
    const a = await actorOf(ctx);
    await reversePayment(ctx.db, a, ctx.params.id, ctx.body.reason);
    await ctx.audit("payables.payment.reverse", { type: "supplier_payment", id: ctx.params.id }, { reason: ctx.body.reason });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/dine/payables/payments/:id/attachment", tag: TAG, auth: MANAGE, multipart: true, audit: false,
  rateLimit: { limit: 20, windowMs: 60_000, by: "user" },
  summary: "Attach a payment receipt or screenshot (PNG/JPEG, max 2 MB)",
  handler: (ctx) => storeAttachment(ctx, "payment"),
});

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/dine/payables/adjustments", tag: TAG, auth: VIEW,
  summary: "Returns, discounts, corrections and write-offs",
  query: z.object({ supplierId: z.uuid().optional(), ...page }),
  handler: async (ctx) => {
    const where = { tenantId: ctx.tenantId, ...(ctx.query.supplierId ? { supplierId: ctx.query.supplierId } : {}) };
    const [total, rows] = await Promise.all([
      ctx.db.supplierCreditAdjustment.count({ where }),
      ctx.db.supplierCreditAdjustment.findMany({
        where, orderBy: [{ adjustmentDate: "desc" }, { adjustmentNo: "desc" }], skip: (ctx.query.page - 1) * ctx.query.pageSize, take: ctx.query.pageSize,
        include: { supplier: { select: { id: true, name: true } }, purchase: { select: { billNo: true } } },
      }),
    ]);
    return {
      total, page: ctx.query.page, pageSize: ctx.query.pageSize,
      items: rows.map((x) => ({ ...x, number: docNo("adjustment", x.adjustmentNo), adjustmentDate: fromDateOnly(x.adjustmentDate), bill: x.purchase ? docNo("purchase", x.purchase.billNo) : null, purchase: undefined })),
    };
  },
});

route({
  method: "POST", path: "/dine/payables/adjustments", tag: TAG, auth: ADJUST, rateLimit: WRITE_LIMIT, audit: false,
  summary: "Adjust what is owed: DECREASE for returns, discounts, corrections, write-offs; INCREASE for charges or under-recorded amounts. A reason is required.",
  body: z.object({
    supplierId: z.uuid(),
    direction: z.enum(["INCREASE", "DECREASE"]),
    kind: z.enum(ADJUSTMENT_KINDS),
    amount: positiveMoney,
    adjustmentDate: isoDate.optional(),
    purchaseId: z.uuid().optional().nullable(),
    reason,
    allowAdvance: z.boolean().optional(),
    clientRef,
  }),
  handler: async (ctx) => {
    const a = await actorOf(ctx);
    const r = await recordAdjustment(ctx.db, a, ctx.body);
    const adj = await ctx.db.supplierCreditAdjustment.findUniqueOrThrow({ where: { id: r.id } });
    if (!r.duplicate)
      await ctx.audit("payables.adjustment.create", { type: "supplier_adjustment", id: adj.id }, { supplierId: adj.supplierId, direction: adj.direction, kind: adj.kind, amount: adj.amount, reason: adj.reason });
    ctx.status = r.duplicate ? 200 : 201;
    return { ...adj, number: docNo("adjustment", adj.adjustmentNo), adjustmentDate: fromDateOnly(adj.adjustmentDate), duplicate: r.duplicate };
  },
});

route({
  method: "POST", path: "/dine/payables/adjustments/:id/reverse", tag: TAG, auth: ADJUST, rateLimit: WRITE_LIMIT, audit: false,
  summary: "Reverse an adjustment (kept in the ledger)",
  body: z.object({ reason }),
  handler: async (ctx) => {
    const a = await actorOf(ctx);
    await reverseAdjustment(ctx.db, a, ctx.params.id, ctx.body.reason);
    await ctx.audit("payables.adjustment.reverse", { type: "supplier_adjustment", id: ctx.params.id }, { reason: ctx.body.reason });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const reportQuery = z.object({
  period: z.enum(["day", "week", "month", "custom"]).default("day"),
  /** Any date in the day / week / month to report on (default: today's business day). */
  date: isoDate.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

async function resolveReport(ctx: Ctx<unknown, z.infer<typeof reportQuery>>) {
  const a = await actorOf(ctx);
  const q = ctx.query;
  let from: ISODate, to: ISODate;
  if (q.period === "custom") {
    if (!q.from || !q.to) throw badRequest("Choose the 'from' and 'to' dates for a custom report.");
    checkRange(q.from, q.to);
    ({ from, to } = q as { from: ISODate; to: ISODate });
  } else {
    ({ from, to } = periodRange(q.period, q.date ?? a.today));
  }
  if (from > a.today) throw badRequest("That period has not started yet.");
  return buildPayablesReport(ctx.db, ctx.tenantId, { period: q.period as ReportPeriod, from, to, today: a.today });
}

async function businessName(ctx: Ctx) {
  const [s, b] = await Promise.all([getProductSettings(ctx.db, ctx.tenantId, "dine"), ctx.db.business.findUnique({ where: { tenantId: ctx.tenantId }, select: { name: true } })]);
  return s.restaurantName || b?.name || "Restaurant";
}

route({
  method: "GET", path: "/dine/payables/reports", tag: TAG, auth: VIEW, query: reportQuery,
  summary: "Supplier credit report for a day, week (Mon-Sun), month or custom range, with the previous period for comparison",
  handler: async (ctx) => {
    const r = await resolveReport(ctx);
    return { ...r, title: reportTitle(r) };
  },
});

route({
  method: "GET", path: "/dine/payables/reports/pdf", tag: TAG, auth: VIEW, query: reportQuery,
  rateLimit: { limit: 30, windowMs: 60_000, by: "user" },
  summary: "Supplier credit report as a PDF",
  handler: async (ctx) => {
    const r = await resolveReport(ctx);
    const pdf = await payablesReportPdf(r, { businessName: await businessName(ctx) });
    return new Response(Buffer.from(pdf), {
      headers: {
        "content-type": "application/pdf", "cache-control": "private, no-store", "x-content-type-options": "nosniff",
        "content-disposition": `attachment; filename="supplier-credit-${r.from}${r.from === r.to ? "" : `-to-${r.to}`}.pdf"`,
      },
    });
  },
});

route({
  method: "GET", path: "/dine/payables/reports/csv", tag: TAG, auth: VIEW, query: reportQuery,
  rateLimit: { limit: 30, windowMs: 60_000, by: "user" },
  summary: "Supplier credit report as CSV (opens in Excel)",
  handler: async (ctx) => {
    const r = await resolveReport(ctx);
    return new Response(payablesReportCsv(r, await businessName(ctx)), {
      headers: {
        "content-type": "text/csv; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff",
        "content-disposition": `attachment; filename="supplier-credit-${r.from}${r.from === r.to ? "" : `-to-${r.to}`}.csv"`,
      },
    });
  },
});

// ---------------------------------------------------------------------------
// Alerts and settings
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/dine/payables/alerts", tag: TAG, auth: VIEW,
  summary: "What needs attention now (overdue bills, suppliers over their limit, long-unpaid balances) and the alert history",
  handler: async (ctx) => {
    const a = await actorOf(ctx);
    const [rows, settings, history] = await Promise.all([
      supplierOverview(ctx.db, ctx.tenantId, a.today),
      getCreditSettings(ctx.db, ctx.tenantId),
      ctx.db.supplierNotification.findMany({
        where: { tenantId: ctx.tenantId, kind: { notIn: ["DAILY_CHECK", "OVERDUE_BILL"] } }, orderBy: { createdAt: "desc" }, take: 50,
        select: { id: true, kind: true, title: true, body: true, supplierId: true, recipients: true, channels: true, createdAt: true },
      }),
    ]);
    const overdueBills = (await billsWithDue(ctx.db, a.today, { tenantId: ctx.tenantId, status: "ACTIVE", dueDate: { lt: dateOnly(a.today) } }, { orderBy: [{ dueDate: "asc" }] }))
      .filter((b) => billStatus({ status: b.status, total: b.total, due: b.due, dueDate: b.dueDate }, a.today) === "OVERDUE");
    const total = rows.reduce((s, r) => s + r.balance, 0);
    return {
      today: a.today,
      overdueBills,
      overLimit: rows.filter((r) => r.overLimit),
      totalOverLimit: settings.totalCreditLimit != null && total > settings.totalCreditLimit ? { total, limit: settings.totalCreditLimit } : null,
      aging: settings.agingDays == null ? [] : rows.filter((r) => r.oldestOpenBill && daysBetween(r.oldestOpenBill, a.today) > settings.agingDays!)
        .map((r) => ({ id: r.id, name: r.name, balance: r.balance, oldestOpenBill: r.oldestOpenBill, days: daysBetween(r.oldestOpenBill!, a.today) })),
      agingDays: settings.agingDays,
      history,
    };
  },
});

route({
  method: "GET", path: "/dine/payables/settings", tag: TAG, auth: VIEW,
  summary: "Supplier credit alert settings, and whether WhatsApp alerts can be delivered",
  handler: async (ctx) => ({
    ...(await getCreditSettings(ctx.db, ctx.tenantId)),
    whatsappReady: payablesWhatsAppReady(),
    usesStockPurchases: ctx.has("purchases"),
  }),
});

route({
  method: "PUT", path: "/dine/payables/settings", tag: TAG, auth: ADJUST, rateLimit: WRITE_LIMIT, audit: false,
  summary: "Change supplier credit alerts, limits, summaries and the stock purchase link",
  body: z.object({
    notifyPurchases: z.boolean(), notifyPayments: z.boolean(), notifyOverdue: z.boolean(),
    totalCreditLimit: money.nullable(), agingDays: z.number().int().min(1).max(365).nullable(),
    dailySummary: z.boolean(), weeklySummary: z.boolean(), monthlySummary: z.boolean(),
    whatsappEnabled: z.boolean(), whatsappNumber: phone,
    linkStockPurchases: z.boolean(),
  }).partial(),
  handler: async (ctx) => {
    const saved = await saveCreditSettings(ctx.db, ctx.tenantId, ctx.user.id, clean(ctx.body));
    await ctx.audit("payables.settings.update", { type: "supplier_credit_settings" }, { fields: Object.keys(ctx.body) });
    return { ...saved, whatsappReady: payablesWhatsAppReady(), usesStockPurchases: ctx.has("purchases") };
  },
});
