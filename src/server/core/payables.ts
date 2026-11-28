/**
 * Supplier credit & payables: every operation that changes what a restaurant
 * owes its suppliers. See docs/SUPPLIER-CREDIT.md.
 *
 * Rules every function here follows:
 *  - It runs inside the request's tenant transaction (RLS-scoped) and starts by
 *    locking the supplier row, so two people paying the same supplier at the
 *    same moment are serialised and allocations can never be double counted.
 *  - It writes the matching supplier_ledger_entries row(s). The ledger is the
 *    authoritative balance: sum(increase) - sum(decrease).
 *  - Nothing is deleted or rewritten: bills are cancelled, payments and
 *    adjustments reversed, allocations voided (database triggers enforce it).
 *  - It finishes with reconcile(): free credit settles the oldest open bills.
 */
import type { Prisma } from "@prisma/client";
import { nextSeq, type Tx } from "../db";
import { badRequest, HttpError, notFound } from "../http/errors";
import { dateOnly, fromDateOnly, type ISODate } from "@/lib/dates";
import {
  billStatus, defaultDueDate, docNo, formatQuantity, lineAmount, MAX_AMOUNT_PAISE, parseQuantity, planAllocations,
  type OpenCredit, type PurchaseUnit,
} from "@/lib/payables";

export interface Actor {
  tenantId: string;
  userId: string | null;
  branchId: string | null;
  /** Current business day of the restaurant. */
  today: ISODate;
}

const active = { voidedAt: null } as const;
const sum = (xs: { amount: number }[]) => xs.reduce((a, x) => a + x.amount, 0);

// ---------------------------------------------------------------------------
// Locking, ledger, balances
// ---------------------------------------------------------------------------

/** Locks the supplier row for the rest of the transaction (RLS keeps it to this tenant). */
export async function lockSupplier(db: Tx, tenantId: string, supplierId: string) {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM dine_suppliers WHERE id = ${supplierId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
  if (!rows.length) throw notFound("Supplier");
  return db.dineSupplier.findUniqueOrThrow({ where: { id: supplierId } });
}

type EntryType =
  | "OPENING_BALANCE" | "PURCHASE" | "PAYMENT" | "ADJUSTMENT_INCREASE" | "ADJUSTMENT_DECREASE"
  | "PURCHASE_CANCELLED" | "PAYMENT_REVERSED" | "ADJUSTMENT_REVERSED";

async function ledger(db: Tx, a: Actor, e: {
  supplierId: string; date: ISODate; type: EntryType; increase?: number; decrease?: number;
  purchaseId?: string; paymentId?: string; adjustmentId?: string; reference?: string | null; description: string;
}) {
  await db.supplierLedgerEntry.create({
    data: {
      tenantId: a.tenantId, supplierId: e.supplierId, entryDate: dateOnly(e.date), entryType: e.type,
      increase: e.increase ?? 0, decrease: e.decrease ?? 0,
      purchaseId: e.purchaseId ?? null, paymentId: e.paymentId ?? null, adjustmentId: e.adjustmentId ?? null,
      reference: e.reference ?? null, description: e.description.slice(0, 300), createdById: a.userId,
    },
  });
}

/** Ledger balance per supplier (positive: owed to the supplier; negative: advance). Optionally up to and including a date. */
export async function supplierBalances(db: Tx, tenantId: string, opts: { supplierIds?: string[]; upTo?: ISODate; before?: ISODate } = {}) {
  const entryDate = opts.upTo ? { lte: dateOnly(opts.upTo) } : opts.before ? { lt: dateOnly(opts.before) } : undefined;
  const rows = await db.supplierLedgerEntry.groupBy({
    by: ["supplierId"],
    where: { tenantId, ...(opts.supplierIds ? { supplierId: { in: opts.supplierIds } } : {}), ...(entryDate ? { entryDate } : {}) },
    _sum: { increase: true, decrease: true },
  });
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.supplierId, (r._sum.increase ?? 0) - (r._sum.decrease ?? 0));
  return out;
}

export async function supplierBalance(db: Tx, tenantId: string, supplierId: string): Promise<number> {
  return (await supplierBalances(db, tenantId, { supplierIds: [supplierId] })).get(supplierId) ?? 0;
}

/** Bills with what is still owed on each and their display status. */
export async function billsWithDue(db: Tx, today: ISODate, where: Prisma.SupplierPurchaseWhereInput, opts: { orderBy?: Prisma.SupplierPurchaseOrderByWithRelationInput[]; skip?: number; take?: number } = {}) {
  const rows = await db.supplierPurchase.findMany({
    where,
    orderBy: opts.orderBy ?? [{ billDate: "desc" }, { billNo: "desc" }],
    skip: opts.skip,
    take: opts.take,
    include: {
      supplier: { select: { id: true, name: true, businessName: true, phone: true, category: true } },
      allocations: { where: active, select: { amount: true } },
      paidAtPurchase: { select: { amount: true, status: true } },
      items: { orderBy: { sortOrder: "asc" } },
    },
  });
  return rows.map((p) => presentBill(p, today));
}

type BillRow = Prisma.SupplierPurchaseGetPayload<{
  include: {
    supplier: { select: { id: true; name: true; businessName: true; phone: true; category: true } };
    allocations: { select: { amount: true } };
    paidAtPurchase: { select: { amount: true; status: true } };
    items: true;
  };
}>;

export function presentBill(p: BillRow, today: ISODate) {
  const settled = p.status === "CANCELLED" ? 0 : sum(p.allocations);
  const due = p.status === "CANCELLED" ? 0 : p.total - settled;
  const dueDate = p.dueDate ? fromDateOnly(p.dueDate) : null;
  return {
    id: p.id,
    number: docNo("purchase", p.billNo),
    billNo: p.billNo,
    kind: p.kind,
    status: p.status,
    displayStatus: billStatus({ status: p.status, total: p.total, due, dueDate }, today),
    supplier: p.supplier,
    billDate: fromDateOnly(p.billDate),
    dueDate,
    daysOverdue: dueDate && due > 0 && dueDate < today ? Math.round((Date.parse(today) - Date.parse(dueDate)) / 86_400_000) : 0,
    invoiceNo: p.invoiceNo,
    total: p.total,
    settled,
    due,
    paidAtPurchase: sum(p.paidAtPurchase.filter((x) => x.status === "ACTIVE")),
    notes: p.notes,
    hasAttachment: !!p.attachmentKey,
    dinePurchaseId: p.dinePurchaseId,
    items: p.items.map((i) => ({
      id: i.id, productName: i.productName, category: i.category, quantity: i.quantity.toString(), unit: i.unit, rate: i.rate, amount: i.amount,
    })),
    createdAt: p.createdAt,
    cancelledAt: p.cancelledAt,
    cancelReason: p.cancelReason,
  };
}

export type PresentedBill = ReturnType<typeof presentBill>;

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/**
 * Applies every unallocated payment / credit to the supplier's open bills,
 * oldest first. Afterwards either nothing is owed on any bill, or no credit is
 * left unallocated (that remainder is the supplier advance).
 */
export async function reconcile(db: Tx, a: Actor, supplierId: string) {
  const where = { tenantId: a.tenantId, supplierId };
  const bills = await db.supplierPurchase.findMany({
    where: { ...where, status: "ACTIVE" },
    orderBy: [{ billDate: "asc" }, { billNo: "asc" }],
    select: { id: true, total: true, allocations: { where: active, select: { amount: true } } },
  });
  const open = bills.map((b) => ({ id: b.id, due: b.total - sum(b.allocations) })).filter((b) => b.due > 0);
  if (!open.length) return 0;

  const [payments, credits] = await Promise.all([
    db.supplierPayment.findMany({
      where: { ...where, status: "ACTIVE" },
      orderBy: [{ paymentDate: "asc" }, { paymentNo: "asc" }],
      select: { id: true, amount: true, paymentDate: true, allocations: { where: active, select: { amount: true } } },
    }),
    db.supplierCreditAdjustment.findMany({
      where: { ...where, status: "ACTIVE", direction: "DECREASE" },
      orderBy: [{ adjustmentDate: "asc" }, { adjustmentNo: "asc" }],
      select: { id: true, amount: true, adjustmentDate: true, allocations: { where: active, select: { amount: true } } },
    }),
  ]);
  const free: (OpenCredit & { date: number })[] = [
    ...payments.map((p) => ({ id: p.id, source: "payment" as const, unallocated: p.amount - sum(p.allocations), date: p.paymentDate.getTime() })),
    ...credits.map((c) => ({ id: c.id, source: "adjustment" as const, unallocated: c.amount - sum(c.allocations), date: c.adjustmentDate.getTime() })),
  ].filter((c) => c.unallocated > 0).sort((x, y) => x.date - y.date);

  const plan = planAllocations(open, free);
  if (plan.length) {
    await db.supplierPaymentAllocation.createMany({
      data: plan.map((p) => ({
        tenantId: a.tenantId, supplierId, purchaseId: p.purchaseId, amount: p.amount, createdById: a.userId,
        paymentId: p.source === "payment" ? p.sourceId : null,
        adjustmentId: p.source === "adjustment" ? p.sourceId : null,
      })),
    });
  }
  return plan.length;
}

/** Bills of one supplier that can take an allocation now, with what is owed on each. */
async function openBillDues(db: Tx, a: Actor, supplierId: string, ids: string[]) {
  const bills = await db.supplierPurchase.findMany({
    where: { tenantId: a.tenantId, supplierId, id: { in: ids } },
    select: { id: true, status: true, billNo: true, total: true, allocations: { where: active, select: { amount: true } } },
  });
  return new Map(bills.map((b) => [b.id, { ...b, due: b.status === "ACTIVE" ? b.total - sum(b.allocations) : 0 }]));
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export interface SupplierInput {
  name: string;
  businessName?: string | null;
  contactPerson?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  address?: string | null;
  gstin?: string | null;
  category: string;
  paymentTermsDays?: number | null;
  creditLimit?: number | null;
  notes?: string | null;
}

async function assertUniqueName(db: Tx, tenantId: string, name: string, exceptId?: string) {
  const same = await db.dineSupplier.findFirst({
    where: { tenantId, isActive: true, name: { equals: name.trim(), mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (same) throw new HttpError(409, "DUPLICATE", `A supplier named "${name.trim()}" already exists.`);
}

export async function createSupplier(db: Tx, a: Actor, input: SupplierInput & { openingBalance?: number; openingBalanceDate?: ISODate }) {
  await assertUniqueName(db, a.tenantId, input.name);
  const { openingBalance, openingBalanceDate, ...profile } = input;
  const supplier = await db.dineSupplier.create({ data: { ...profile, name: profile.name.trim(), tenantId: a.tenantId, createdById: a.userId } });
  if (openingBalance && openingBalance > 0) {
    const date = openingBalanceDate ?? a.today;
    if (date > a.today) throw badRequest("The opening balance date cannot be in the future.");
    const billNo = await nextSeq(db, a.tenantId, "supplier-bill");
    const bill = await db.supplierPurchase.create({
      data: {
        tenantId: a.tenantId, branchId: a.branchId, supplierId: supplier.id, billNo, kind: "OPENING_BALANCE",
        billDate: dateOnly(date), total: openingBalance, notes: "Balance owed before using SAF Flow", createdById: a.userId,
      },
    });
    await ledger(db, a, {
      supplierId: supplier.id, date, type: "OPENING_BALANCE", increase: openingBalance, purchaseId: bill.id,
      reference: docNo("purchase", billNo), description: "Opening balance",
    });
  }
  return supplier;
}

export async function updateSupplier(db: Tx, a: Actor, id: string, patch: Partial<SupplierInput> & { isActive?: boolean }) {
  const s = await lockSupplier(db, a.tenantId, id);
  if (patch.name && patch.name.trim().toLowerCase() !== s.name.toLowerCase()) await assertUniqueName(db, a.tenantId, patch.name, id);
  if (patch.isActive === true && !s.isActive) await assertUniqueName(db, a.tenantId, patch.name ?? s.name, id);
  return db.dineSupplier.update({ where: { id }, data: { ...patch, ...(patch.name ? { name: patch.name.trim() } : {}) } });
}

// ---------------------------------------------------------------------------
// Purchases (bills)
// ---------------------------------------------------------------------------

export interface PurchaseLineInput {
  productName: string;
  category?: string;
  quantity: string | number;
  unit: PurchaseUnit;
  /** Paise per unit. */
  rate: number;
  stockItemId?: string | null;
}

export interface PurchaseInput {
  supplierId: string;
  billDate?: ISODate;
  dueDate?: ISODate | null;
  invoiceNo?: string | null;
  notes?: string | null;
  items: PurchaseLineInput[];
  /** Paid now, together with the purchase (paise). */
  amountPaid?: number;
  paymentMethod?: string;
  paymentReference?: string | null;
  clientRef?: string | null;
}

/** Line amounts and the bill total, exactly (quantity x rate, rounded once per line). */
export function priceLines(items: PurchaseLineInput[]) {
  const lines = items.map((it, i) => {
    const milli = parseQuantity(it.quantity);
    if (milli == null) throw badRequest(`Line ${i + 1}: enter a quantity above 0 with at most 3 decimals.`);
    const amount = lineAmount(milli, it.rate);
    if (amount > MAX_AMOUNT_PAISE) throw badRequest(`Line ${i + 1}: the amount is too large.`);
    return { ...it, milli, quantity: formatQuantity(milli), amount };
  });
  const total = lines.reduce((s, l) => s + l.amount, 0);
  if (total <= 0) throw badRequest("The purchase total must be more than zero.");
  if (total > MAX_AMOUNT_PAISE) throw badRequest("The purchase total is too large for one bill.");
  return { lines, total };
}

export async function recordPurchase(db: Tx, a: Actor, input: PurchaseInput, opts: { allowInactive?: boolean; dinePurchaseId?: string } = {}) {
  const supplier = await lockSupplier(db, a.tenantId, input.supplierId);
  if (input.clientRef) {
    const dup = await db.supplierPurchase.findFirst({ where: { tenantId: a.tenantId, clientRef: input.clientRef }, select: { id: true, supplierId: true } });
    if (dup) {
      if (dup.supplierId !== supplier.id) throw new HttpError(409, "DUPLICATE_REQUEST", "This form was already submitted for another supplier.");
      return { id: dup.id, duplicate: true };
    }
  }
  if (!supplier.isActive && !opts.allowInactive)
    throw new HttpError(409, "SUPPLIER_INACTIVE", `${supplier.name} is inactive. Reactivate the supplier to record new purchases.`);

  const billDate = input.billDate ?? a.today;
  if (billDate > a.today) throw badRequest("The purchase date cannot be in the future.");
  const dueDate = input.dueDate ?? defaultDueDate(billDate, supplier.paymentTermsDays);
  if (dueDate && dueDate < billDate) throw badRequest("The due date cannot be before the purchase date.");
  const { lines, total } = priceLines(input.items);
  const paid = input.amountPaid ?? 0;
  if (paid > total) throw badRequest("The amount paid now cannot be more than the purchase total. Record an advance as a separate payment.");

  const billNo = await nextSeq(db, a.tenantId, "supplier-bill");
  const bill = await db.supplierPurchase.create({
    data: {
      tenantId: a.tenantId, branchId: a.branchId, supplierId: supplier.id, billNo, kind: "PURCHASE",
      billDate: dateOnly(billDate), dueDate: dueDate ? dateOnly(dueDate) : null, invoiceNo: input.invoiceNo || null,
      total, notes: input.notes || null, clientRef: input.clientRef || null, createdById: a.userId,
      dinePurchaseId: opts.dinePurchaseId ?? null,
      items: {
        createMany: {
          data: lines.map((l, i) => ({
            tenantId: a.tenantId, sortOrder: i, productName: l.productName.trim(), category: l.category ?? supplier.category,
            quantity: l.quantity, unit: l.unit, rate: l.rate, amount: l.amount, stockItemId: l.stockItemId ?? null,
          })),
        },
      },
    },
  });
  const first = lines[0];
  const what = `${first.productName.trim()} ${first.quantity} ${first.unit}${lines.length > 1 ? ` + ${lines.length - 1} more` : ""}`;
  await ledger(db, a, {
    supplierId: supplier.id, date: billDate, type: "PURCHASE", increase: total, purchaseId: bill.id,
    reference: input.invoiceNo || docNo("purchase", billNo), description: `Purchase ${docNo("purchase", billNo)}: ${what}`,
  });

  if (paid > 0) {
    await createPayment(db, a, supplier.id, {
      date: billDate, amount: paid, method: input.paymentMethod ?? "CASH", reference: input.paymentReference ?? null,
      notes: `Paid with ${docNo("purchase", billNo)}`, sourcePurchaseId: bill.id, isAdvance: false, clientRef: null,
    }, [{ purchaseId: bill.id, amount: paid }]);
  }
  await reconcile(db, a, supplier.id);
  return { id: bill.id, duplicate: false };
}

/** Non-financial details only: amounts, supplier and dates that drive the ledger never change. */
export async function updatePurchaseDetails(db: Tx, a: Actor, id: string, patch: { invoiceNo?: string | null; dueDate?: ISODate | null; notes?: string | null }) {
  const p = await db.supplierPurchase.findFirst({ where: { id, tenantId: a.tenantId } });
  if (!p) throw notFound("Purchase");
  await lockSupplier(db, a.tenantId, p.supplierId);
  if (p.status !== "ACTIVE") throw new HttpError(409, "ALREADY_CANCELLED", "A cancelled purchase cannot be edited.");
  if (patch.dueDate && patch.dueDate < fromDateOnly(p.billDate)) throw badRequest("The due date cannot be before the purchase date.");
  return db.supplierPurchase.update({
    where: { id },
    data: {
      ...(patch.invoiceNo !== undefined ? { invoiceNo: patch.invoiceNo || null } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes || null } : {}),
      ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate ? dateOnly(patch.dueDate) : null } : {}),
    },
  });
}

export async function cancelPurchase(db: Tx, a: Actor, id: string, reason: string, opts: { reversePayments?: boolean } = {}) {
  const found = await db.supplierPurchase.findFirst({ where: { id, tenantId: a.tenantId }, select: { supplierId: true } });
  if (!found) throw notFound("Purchase");
  await lockSupplier(db, a.tenantId, found.supplierId);
  const p = await db.supplierPurchase.findUniqueOrThrow({ where: { id } });
  if (p.status === "CANCELLED") throw new HttpError(409, "ALREADY_CANCELLED", "This purchase is already cancelled.");
  const label = p.kind === "OPENING_BALANCE" ? "opening balance" : docNo("purchase", p.billNo);

  await db.supplierPurchase.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: a.userId, cancelReason: reason } });
  await db.supplierPaymentAllocation.updateMany({ where: { purchaseId: id, voidedAt: null }, data: { voidedAt: new Date(), voidReason: `${label} cancelled` } });
  await ledger(db, a, {
    supplierId: p.supplierId, date: a.today, type: "PURCHASE_CANCELLED", decrease: p.total, purchaseId: id,
    reference: p.invoiceNo || docNo("purchase", p.billNo), description: `Cancelled ${label}: ${reason}`,
  });
  if (opts.reversePayments) {
    const paidWith = await db.supplierPayment.findMany({ where: { tenantId: a.tenantId, sourcePurchaseId: id, status: "ACTIVE" }, select: { id: true } });
    for (const pay of paidWith) await reversePaymentLocked(db, a, pay.id, `Purchase ${label} cancelled: ${reason}`);
  }
  await reconcile(db, a, p.supplierId);
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export interface PaymentInput {
  supplierId: string;
  paymentDate?: ISODate;
  amount: number;
  method: string;
  reference?: string | null;
  notes?: string | null;
  /** Bills to settle first, with amounts; the rest goes to the oldest open bills. */
  allocations?: { purchaseId: string; amount: number }[];
  /** Confirms paying more than the balance (the rest is an advance). */
  allowAdvance?: boolean;
  clientRef?: string | null;
}

async function createPayment(
  db: Tx, a: Actor, supplierId: string,
  p: { date: ISODate; amount: number; method: string; reference: string | null; notes: string | null; sourcePurchaseId: string | null; isAdvance: boolean; clientRef: string | null },
  allocations: { purchaseId: string; amount: number }[],
) {
  const paymentNo = await nextSeq(db, a.tenantId, "supplier-payment");
  const pay = await db.supplierPayment.create({
    data: {
      tenantId: a.tenantId, branchId: a.branchId, supplierId, paymentNo, paymentDate: dateOnly(p.date), amount: p.amount,
      method: p.method, reference: p.reference || null, notes: p.notes || null, sourcePurchaseId: p.sourcePurchaseId,
      isAdvance: p.isAdvance, clientRef: p.clientRef, createdById: a.userId,
    },
  });
  await ledger(db, a, {
    supplierId, date: p.date, type: "PAYMENT", decrease: p.amount, paymentId: pay.id,
    reference: p.reference || docNo("payment", paymentNo),
    description: `Payment ${docNo("payment", paymentNo)} (${p.method === "BANK_TRANSFER" ? "bank transfer" : p.method.toLowerCase()})${p.isAdvance ? ", includes advance" : ""}`,
  });
  if (allocations.length) {
    await db.supplierPaymentAllocation.createMany({
      data: allocations.map((x) => ({ tenantId: a.tenantId, supplierId, purchaseId: x.purchaseId, paymentId: pay.id, amount: x.amount, createdById: a.userId })),
    });
  }
  return pay;
}

export async function recordPayment(db: Tx, a: Actor, input: PaymentInput) {
  const supplier = await lockSupplier(db, a.tenantId, input.supplierId);
  if (input.clientRef) {
    const dup = await db.supplierPayment.findFirst({ where: { tenantId: a.tenantId, clientRef: input.clientRef }, select: { id: true, supplierId: true } });
    if (dup) {
      if (dup.supplierId !== supplier.id) throw new HttpError(409, "DUPLICATE_REQUEST", "This form was already submitted for another supplier.");
      return { id: dup.id, duplicate: true };
    }
  }
  const date = input.paymentDate ?? a.today;
  if (date > a.today) throw badRequest("The payment date cannot be in the future.");
  const balance = await supplierBalance(db, a.tenantId, supplier.id);
  const owed = Math.max(0, balance);
  const isAdvance = input.amount > owed;
  if (isAdvance && !input.allowAdvance)
    throw new HttpError(409, "EXCEEDS_BALANCE", owed === 0
      ? `Nothing is owed to ${supplier.name}. To pay in advance, confirm it as an advance payment.`
      : `This is more than the ${formatRs(owed)} owed to ${supplier.name}. To pay the difference in advance, confirm it as an advance payment.`);

  const explicit = input.allocations ?? [];
  if (explicit.length) {
    if (new Set(explicit.map((x) => x.purchaseId)).size !== explicit.length) throw badRequest("Each bill can be listed once.");
    if (explicit.reduce((s, x) => s + x.amount, 0) > input.amount) throw badRequest("The amounts set against bills add up to more than the payment.");
    const dues = await openBillDues(db, a, supplier.id, explicit.map((x) => x.purchaseId));
    for (const x of explicit) {
      const b = dues.get(x.purchaseId);
      if (!b) throw badRequest("A selected bill does not belong to this supplier.");
      if (b.status !== "ACTIVE") throw badRequest(`${docNo("purchase", b.billNo)} is cancelled.`);
      if (x.amount > b.due) throw badRequest(`Only ${formatRs(b.due)} is owed on ${docNo("purchase", b.billNo)}.`);
    }
  }
  const pay = await createPayment(db, a, supplier.id, {
    date, amount: input.amount, method: input.method, reference: input.reference ?? null, notes: input.notes ?? null,
    sourcePurchaseId: null, isAdvance, clientRef: input.clientRef || null,
  }, explicit);
  await reconcile(db, a, supplier.id);
  return { id: pay.id, duplicate: false };
}

async function reversePaymentLocked(db: Tx, a: Actor, id: string, reason: string) {
  const pay = await db.supplierPayment.findUniqueOrThrow({ where: { id } });
  if (pay.status === "REVERSED") throw new HttpError(409, "ALREADY_REVERSED", "This payment is already reversed.");
  await db.supplierPayment.update({ where: { id }, data: { status: "REVERSED", reversedAt: new Date(), reversedById: a.userId, reverseReason: reason } });
  await db.supplierPaymentAllocation.updateMany({ where: { paymentId: id, voidedAt: null }, data: { voidedAt: new Date(), voidReason: `${docNo("payment", pay.paymentNo)} reversed` } });
  await ledger(db, a, {
    supplierId: pay.supplierId, date: a.today, type: "PAYMENT_REVERSED", increase: pay.amount, paymentId: id,
    reference: pay.reference || docNo("payment", pay.paymentNo), description: `Reversed ${docNo("payment", pay.paymentNo)}: ${reason}`,
  });
}

export async function reversePayment(db: Tx, a: Actor, id: string, reason: string) {
  const found = await db.supplierPayment.findFirst({ where: { id, tenantId: a.tenantId }, select: { supplierId: true } });
  if (!found) throw notFound("Payment");
  await lockSupplier(db, a.tenantId, found.supplierId);
  await reversePaymentLocked(db, a, id, reason);
  await reconcile(db, a, found.supplierId);
}

// ---------------------------------------------------------------------------
// Adjustments (returns, discounts, corrections, write-offs)
// ---------------------------------------------------------------------------

export interface AdjustmentInput {
  supplierId: string;
  direction: "INCREASE" | "DECREASE";
  kind: string;
  amount: number;
  adjustmentDate?: ISODate;
  purchaseId?: string | null;
  reason: string;
  allowAdvance?: boolean;
  clientRef?: string | null;
}

export async function recordAdjustment(db: Tx, a: Actor, input: AdjustmentInput) {
  const supplier = await lockSupplier(db, a.tenantId, input.supplierId);
  if (input.clientRef) {
    const dup = await db.supplierCreditAdjustment.findFirst({ where: { tenantId: a.tenantId, clientRef: input.clientRef }, select: { id: true, supplierId: true } });
    if (dup) {
      if (dup.supplierId !== supplier.id) throw new HttpError(409, "DUPLICATE_REQUEST", "This form was already submitted for another supplier.");
      return { id: dup.id, duplicate: true };
    }
  }
  const date = input.adjustmentDate ?? a.today;
  if (date > a.today) throw badRequest("The adjustment date cannot be in the future.");

  let target: { id: string; billNo: number; due: number } | null = null;
  if (input.purchaseId) {
    const b = (await openBillDues(db, a, supplier.id, [input.purchaseId])).get(input.purchaseId);
    if (!b) throw badRequest("The selected bill does not belong to this supplier.");
    if (b.status !== "ACTIVE") throw badRequest(`${docNo("purchase", b.billNo)} is cancelled.`);
    target = b;
  }
  if (input.direction === "DECREASE") {
    const owed = Math.max(0, await supplierBalance(db, a.tenantId, supplier.id));
    if (input.amount > owed && !input.allowAdvance)
      throw new HttpError(409, "EXCEEDS_BALANCE", `This is more than the ${formatRs(owed)} owed to ${supplier.name}. Confirm it to keep the difference as credit with the supplier.`);
  }

  const adjustmentNo = await nextSeq(db, a.tenantId, "supplier-adjustment");
  const adj = await db.supplierCreditAdjustment.create({
    data: {
      tenantId: a.tenantId, supplierId: supplier.id, adjustmentNo, direction: input.direction, kind: input.kind,
      adjustmentDate: dateOnly(date), amount: input.amount, purchaseId: target?.id ?? null, reason: input.reason,
      clientRef: input.clientRef || null, createdById: a.userId,
    },
  });
  const kindLabel = input.kind.toLowerCase().replace("_", "-");
  await ledger(db, a, {
    supplierId: supplier.id, date, type: input.direction === "INCREASE" ? "ADJUSTMENT_INCREASE" : "ADJUSTMENT_DECREASE",
    ...(input.direction === "INCREASE" ? { increase: input.amount } : { decrease: input.amount }),
    adjustmentId: adj.id, purchaseId: target?.id,
    reference: target ? docNo("purchase", target.billNo) : docNo("adjustment", adjustmentNo),
    description: `${docNo("adjustment", adjustmentNo)} ${kindLabel}${target ? ` on ${docNo("purchase", target.billNo)}` : ""}: ${input.reason}`,
  });
  // A return or discount on a bill settles that bill first.
  if (input.direction === "DECREASE" && target && target.due > 0) {
    await db.supplierPaymentAllocation.create({
      data: { tenantId: a.tenantId, supplierId: supplier.id, purchaseId: target.id, adjustmentId: adj.id, amount: Math.min(target.due, input.amount), createdById: a.userId },
    });
  }
  await reconcile(db, a, supplier.id);
  return { id: adj.id, duplicate: false };
}

export async function reverseAdjustment(db: Tx, a: Actor, id: string, reason: string) {
  const found = await db.supplierCreditAdjustment.findFirst({ where: { id, tenantId: a.tenantId }, select: { supplierId: true } });
  if (!found) throw notFound("Adjustment");
  await lockSupplier(db, a.tenantId, found.supplierId);
  const adj = await db.supplierCreditAdjustment.findUniqueOrThrow({ where: { id } });
  if (adj.status === "REVERSED") throw new HttpError(409, "ALREADY_REVERSED", "This adjustment is already reversed.");
  await db.supplierCreditAdjustment.update({ where: { id }, data: { status: "REVERSED", reversedAt: new Date(), reversedById: a.userId, reverseReason: reason } });
  await db.supplierPaymentAllocation.updateMany({ where: { adjustmentId: id, voidedAt: null }, data: { voidedAt: new Date(), voidReason: `${docNo("adjustment", adj.adjustmentNo)} reversed` } });
  await ledger(db, a, {
    supplierId: adj.supplierId, date: a.today, type: "ADJUSTMENT_REVERSED",
    ...(adj.direction === "INCREASE" ? { decrease: adj.amount } : { increase: adj.amount }),
    adjustmentId: id, reference: docNo("adjustment", adj.adjustmentNo), description: `Reversed ${docNo("adjustment", adj.adjustmentNo)}: ${reason}`,
  });
  await reconcile(db, a, adj.supplierId);
}

// ---------------------------------------------------------------------------
// Stock purchase orders (inventory integration)
// ---------------------------------------------------------------------------

const UNIT_ALIASES: Record<string, PurchaseUnit> = {
  kg: "KG", kgs: "KG", kilo: "KG", g: "GRAM", gm: "GRAM", gms: "GRAM", gram: "GRAM", grams: "GRAM",
  l: "LITRE", lt: "LITRE", ltr: "LITRE", litre: "LITRE", liter: "LITRE", ml: "OTHER",
  pc: "PIECE", pcs: "PIECE", piece: "PIECE", pieces: "PIECE", nos: "PIECE", box: "BOX", boxes: "BOX", pkt: "PACKET", packet: "PACKET", packets: "PACKET",
};

/**
 * A received stock purchase order becomes an unpaid supplier bill, once
 * (supplier_purchases.dine_purchase_id is unique). Returns null when the order
 * already has a bill or has no value.
 */
export async function billFromStockPurchase(db: Tx, a: Actor, dinePurchaseId: string) {
  const po = await db.dinePurchase.findFirst({
    where: { id: dinePurchaseId, tenantId: a.tenantId },
    include: { items: { include: { stockItem: { select: { name: true, unit: true } } } }, payableBill: { select: { id: true } } },
  });
  if (!po || po.payableBill) return null;
  const items: PurchaseLineInput[] = po.items
    .filter((i) => i.quantity > 0)
    .map((i) => ({
      productName: i.stockItem.name, quantity: (Math.round(i.quantity * 1000) / 1000).toFixed(3),
      unit: UNIT_ALIASES[i.stockItem.unit.trim().toLowerCase()] ?? "OTHER", rate: i.unitCost, stockItemId: i.stockItemId,
    }));
  if (!items.length || items.every((i) => i.rate === 0)) return null;
  return recordPurchase(db, a, {
    supplierId: po.supplierId, items, invoiceNo: po.invoiceRef ?? `PO #${po.purchaseNo}`,
    notes: `From stock purchase order PO #${po.purchaseNo}`,
  }, { allowInactive: true, dinePurchaseId: po.id });
}

function formatRs(paise: number) {
  return `Rs ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
