/**
 * Supplier credit: dashboard figures, supplier overview, ledger and the
 * daily / weekly / monthly / custom reports (JSON, PDF, CSV).
 *
 * Period reports are built from the append-only ledger, so for every period
 *   opening balance + increases - decreases = closing balance
 * and nothing is counted twice: each event is one ledger row on one business
 * date (a cancellation or reversal is its own row, on the day it was made).
 */
import { dateOnly, eachDate, fmtDate, fmtDateTime, fromDateOnly, startOfMonth, type ISODate } from "@/lib/dates";
import { changePct, docNo, previousRange, type ReportPeriod } from "@/lib/payables";
import type { Tx } from "../db";
import { billsWithDue, supplierBalances } from "./payables";
import { pdfMoney, PdfWriter, PDF_COLORS } from "./daybook-pdf";

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Supplier overview (dashboard table, supplier list)
// ---------------------------------------------------------------------------

export interface SupplierRow {
  id: string; name: string; businessName: string | null; category: string; phone: string | null; whatsapp: string | null;
  isActive: boolean; paymentTermsDays: number | null; creditLimit: number | null;
  purchases: number; paid: number; otherCredits: number; otherDebits: number; balance: number;
  overdue: number; overdueBills: number; openBills: number; oldestOpenBill: ISODate | null; lastActivity: Date | null;
  overLimit: boolean;
}

export async function supplierOverview(db: Tx, tenantId: string, today: ISODate, opts: { supplierIds?: string[] } = {}): Promise<SupplierRow[]> {
  const idFilter = opts.supplierIds ? { supplierId: { in: opts.supplierIds } } : {};
  const [suppliers, balances, bought, paid, adj, openBills, activity] = await Promise.all([
    db.dineSupplier.findMany({ where: { tenantId, ...(opts.supplierIds ? { id: { in: opts.supplierIds } } : {}) }, orderBy: { name: "asc" } }),
    supplierBalances(db, tenantId, { supplierIds: opts.supplierIds }),
    db.supplierPurchase.groupBy({ by: ["supplierId"], where: { tenantId, status: "ACTIVE", ...idFilter }, _sum: { total: true } }),
    db.supplierPayment.groupBy({ by: ["supplierId"], where: { tenantId, status: "ACTIVE", ...idFilter }, _sum: { amount: true } }),
    db.supplierCreditAdjustment.groupBy({ by: ["supplierId", "direction"], where: { tenantId, status: "ACTIVE", ...idFilter }, _sum: { amount: true } }),
    billsWithDue(db, today, { tenantId, status: "ACTIVE", ...idFilter }, { orderBy: [{ billDate: "asc" }] }),
    db.supplierLedgerEntry.groupBy({ by: ["supplierId"], where: { tenantId, ...idFilter }, _max: { createdAt: true } }),
  ]);
  const by = <T extends { supplierId: string }>(rows: T[]) => new Map(rows.map((r) => [r.supplierId, r]));
  const boughtM = by(bought), paidM = by(paid), actM = by(activity);
  return suppliers.map((s) => {
    const open = openBills.filter((b) => b.supplier.id === s.id && b.due > 0);
    const overdue = open.filter((b) => b.displayStatus === "OVERDUE");
    const balance = balances.get(s.id) ?? 0;
    return {
      id: s.id, name: s.name, businessName: s.businessName, category: s.category, phone: s.phone, whatsapp: s.whatsapp,
      isActive: s.isActive, paymentTermsDays: s.paymentTermsDays, creditLimit: s.creditLimit,
      purchases: boughtM.get(s.id)?._sum.total ?? 0,
      paid: paidM.get(s.id)?._sum.amount ?? 0,
      otherCredits: adj.find((x) => x.supplierId === s.id && x.direction === "DECREASE")?._sum.amount ?? 0,
      otherDebits: adj.find((x) => x.supplierId === s.id && x.direction === "INCREASE")?._sum.amount ?? 0,
      balance,
      overdue: overdue.reduce((a, b) => a + b.due, 0),
      overdueBills: overdue.length,
      openBills: open.length,
      oldestOpenBill: open[0]?.billDate ?? null,
      lastActivity: actM.get(s.id)?._max.createdAt ?? null,
      overLimit: s.creditLimit != null && balance > s.creditLimit,
    };
  });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function payablesSummary(db: Tx, tenantId: string, today: ISODate) {
  const monthFrom = dateOnly(startOfMonth(today));
  const todayD = dateOnly(today);
  const [rows, monthBuys, monthPays, todayBills] = await Promise.all([
    supplierOverview(db, tenantId, today),
    db.supplierPurchase.aggregate({ where: { tenantId, kind: "PURCHASE", status: "ACTIVE", billDate: { gte: monthFrom, lte: todayD } }, _sum: { total: true }, _count: true }),
    db.supplierPayment.aggregate({ where: { tenantId, status: "ACTIVE", paymentDate: { gte: monthFrom, lte: todayD } }, _sum: { amount: true }, _count: true }),
    billsWithDue(db, today, { tenantId, kind: "PURCHASE", status: "ACTIVE", billDate: todayD }),
  ]);
  const owed = rows.filter((r) => r.balance > 0);
  return {
    today,
    totalOutstanding: owed.reduce((a, r) => a + r.balance, 0),
    suppliersOwed: owed.length,
    totalAdvance: rows.filter((r) => r.balance < 0).reduce((a, r) => a - r.balance, 0),
    purchasesThisMonth: monthBuys._sum.total ?? 0,
    purchaseCountThisMonth: monthBuys._count,
    paidThisMonth: monthPays._sum.amount ?? 0,
    paymentCountThisMonth: monthPays._count,
    overdueAmount: rows.reduce((a, r) => a + r.overdue, 0),
    overdueBills: rows.reduce((a, r) => a + r.overdueBills, 0),
    overdueSuppliers: rows.filter((r) => r.overdue > 0).length,
    activeSuppliers: rows.filter((r) => r.isActive).length,
    newCreditToday: todayBills.reduce((a, b) => a + (b.total - b.paidAtPurchase), 0),
    newCreditBillsToday: todayBills.filter((b) => b.total > b.paidAtPurchase).length,
    overLimit: rows.filter((r) => r.overLimit).map((r) => ({ id: r.id, name: r.name, balance: r.balance, creditLimit: r.creditLimit })),
    suppliers: rows,
  };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export async function supplierLedger(db: Tx, tenantId: string, supplierId: string, range: { from?: ISODate; to?: ISODate }) {
  const opening = range.from ? (await supplierBalances(db, tenantId, { supplierIds: [supplierId], before: range.from })).get(supplierId) ?? 0 : 0;
  const entries = await db.supplierLedgerEntry.findMany({
    where: {
      tenantId, supplierId,
      ...(range.from || range.to ? { entryDate: { ...(range.from ? { gte: dateOnly(range.from) } : {}), ...(range.to ? { lte: dateOnly(range.to) } : {}) } } : {}),
    },
    orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  let running = opening;
  const rows = entries.map((e) => {
    running += e.increase - e.decrease;
    return {
      id: e.id, date: fromDateOnly(e.entryDate), type: e.entryType, description: e.description, reference: e.reference,
      increase: e.increase, decrease: e.decrease, balance: running,
      purchaseId: e.purchaseId, paymentId: e.paymentId, adjustmentId: e.adjustmentId, createdAt: e.createdAt,
    };
  });
  const totals = { increase: rows.reduce((a, r) => a + r.increase, 0), decrease: rows.reduce((a, r) => a + r.decrease, 0) };
  return { opening, closing: running, totals, entries: rows };
}

// ---------------------------------------------------------------------------
// Period reports
// ---------------------------------------------------------------------------

interface Flow {
  purchases: number; openingBalances: number; payments: number; paymentReversals: number;
  creditAdjustments: number; debitAdjustments: number; cancellations: number; adjustmentReversals: number;
  increase: number; decrease: number;
}

const emptyFlow = (): Flow => ({ purchases: 0, openingBalances: 0, payments: 0, paymentReversals: 0, creditAdjustments: 0, debitAdjustments: 0, cancellations: 0, adjustmentReversals: 0, increase: 0, decrease: 0 });

function addEntry(f: Flow, e: { entryType: string; increase: number; decrease: number }) {
  f.increase += e.increase;
  f.decrease += e.decrease;
  switch (e.entryType) {
    case "PURCHASE": f.purchases += e.increase; break;
    case "OPENING_BALANCE": f.openingBalances += e.increase; break;
    case "PAYMENT": f.payments += e.decrease; break;
    case "PAYMENT_REVERSED": f.paymentReversals += e.increase; break;
    case "ADJUSTMENT_DECREASE": f.creditAdjustments += e.decrease; break;
    case "ADJUSTMENT_INCREASE": f.debitAdjustments += e.increase; break;
    case "PURCHASE_CANCELLED": f.cancellations += e.decrease; break;
    case "ADJUSTMENT_REVERSED": f.adjustmentReversals += e.increase - e.decrease; break;
  }
}

export interface PayablesReport {
  period: ReportPeriod; from: ISODate; to: ISODate; today: ISODate;
  previous: { from: ISODate; to: ISODate; purchases: number; payments: number; newCredit: number; closing: number };
  opening: number; closing: number;
  flow: Flow;
  /** Unpaid part of the period's purchases (total less what was paid with them). */
  newCredit: number;
  /** Payments (net of reversals) plus returns, discounts and other credits. */
  creditSettled: number;
  purchaseCount: number; paymentCount: number;
  change: { purchases: number | null; payments: number | null; closing: number | null };
  daily: { date: ISODate; purchases: number; payments: number; balance: number }[];
  suppliers: { id: string; name: string; category: string; isActive: boolean; opening: number; purchases: number; payments: number; other: number; closing: number; overdue: number }[];
  highest: { id: string; name: string; closing: number } | null;
  overdue: { id: string; number: string; supplier: string; billDate: ISODate; dueDate: ISODate | null; daysOverdue: number; due: number }[];
  overdueTotal: number;
  /** opening + increase - decrease === closing (always true; shown on the report). */
  reconciled: boolean;
}

async function newCreditIn(db: Tx, tenantId: string, from: ISODate, to: ISODate) {
  const bills = await db.supplierPurchase.findMany({
    where: { tenantId, kind: "PURCHASE", billDate: { gte: dateOnly(from), lte: dateOnly(to) } },
    select: { total: true, paidAtPurchase: { select: { amount: true } } },
  });
  return { count: bills.length, amount: bills.reduce((a, b) => a + b.total - b.paidAtPurchase.reduce((s, p) => s + p.amount, 0), 0) };
}

export async function buildPayablesReport(db: Tx, tenantId: string, q: { period: ReportPeriod; from: ISODate; to: ISODate; today: ISODate }): Promise<PayablesReport> {
  const prev = previousRange(q.period, q.from, q.to);
  const [entries, openingMap, prevOpeningMap, suppliers, newCredit, prevNewCredit, payCount, overdueBills] = await Promise.all([
    db.supplierLedgerEntry.findMany({
      where: { tenantId, entryDate: { gte: dateOnly(prev.from), lte: dateOnly(q.to) } },
      select: { supplierId: true, entryDate: true, entryType: true, increase: true, decrease: true },
    }),
    supplierBalances(db, tenantId, { before: q.from }),
    supplierBalances(db, tenantId, { before: prev.from }),
    db.dineSupplier.findMany({ where: { tenantId }, select: { id: true, name: true, category: true, isActive: true } }),
    newCreditIn(db, tenantId, q.from, q.to),
    newCreditIn(db, tenantId, prev.from, prev.to),
    db.supplierPayment.count({ where: { tenantId, paymentDate: { gte: dateOnly(q.from), lte: dateOnly(q.to) } } }),
    billsWithDue(db, q.today, { tenantId, status: "ACTIVE", dueDate: { lt: dateOnly(q.today) } }, { orderBy: [{ dueDate: "asc" }] }),
  ]);

  const flow = emptyFlow();
  const prevFlow = emptyFlow();
  const perSupplier = new Map<string, Flow>();
  const perDay = new Map<ISODate, { purchases: number; payments: number; net: number }>();
  for (const e of entries) {
    const d = fromDateOnly(e.entryDate);
    if (d < q.from) { addEntry(prevFlow, e); continue; }
    addEntry(flow, e);
    if (!perSupplier.has(e.supplierId)) perSupplier.set(e.supplierId, emptyFlow());
    addEntry(perSupplier.get(e.supplierId)!, e);
    const day = perDay.get(d) ?? { purchases: 0, payments: 0, net: 0 };
    if (e.entryType === "PURCHASE") day.purchases += e.increase;
    if (e.entryType === "PAYMENT") day.payments += e.decrease;
    if (e.entryType === "PAYMENT_REVERSED") day.payments -= e.increase;
    day.net += e.increase - e.decrease;
    perDay.set(d, day);
  }

  const sumMap = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const opening = sumMap(openingMap);
  const closing = opening + flow.increase - flow.decrease;
  const prevOpening = sumMap(prevOpeningMap);
  const prevClosing = prevOpening + prevFlow.increase - prevFlow.decrease;
  const netPayments = flow.payments - flow.paymentReversals;
  const prevPayments = prevFlow.payments - prevFlow.paymentReversals;

  let running = opening;
  const daily = eachDate(q.from, q.to).map((date) => {
    const d = perDay.get(date) ?? { purchases: 0, payments: 0, net: 0 };
    running += d.net;
    return { date, purchases: d.purchases, payments: d.payments, balance: running };
  });

  const overdueBySupplier = new Map<string, number>();
  const overdue = overdueBills.filter((b) => b.displayStatus === "OVERDUE").map((b) => {
    overdueBySupplier.set(b.supplier.id, (overdueBySupplier.get(b.supplier.id) ?? 0) + b.due);
    return { id: b.id, number: b.number, supplier: b.supplier.name, billDate: b.billDate, dueDate: b.dueDate, daysOverdue: b.daysOverdue, due: b.due };
  });

  const supplierRows = suppliers.map((s) => {
    const f = perSupplier.get(s.id) ?? emptyFlow();
    const open = openingMap.get(s.id) ?? 0;
    const purchases = f.purchases + f.openingBalances;
    const payments = f.payments - f.paymentReversals;
    const close = open + f.increase - f.decrease;
    return { id: s.id, name: s.name, category: s.category, isActive: s.isActive, opening: open, purchases, payments, other: close - open - purchases + payments, closing: close, overdue: overdueBySupplier.get(s.id) ?? 0 };
  }).filter((r) => r.opening !== 0 || r.closing !== 0 || r.purchases !== 0 || r.payments !== 0 || r.other !== 0)
    .sort((a, b) => b.closing - a.closing || a.name.localeCompare(b.name));
  const top = supplierRows.find((r) => r.closing > 0);

  return {
    period: q.period, from: q.from, to: q.to, today: q.today,
    previous: { ...prev, purchases: prevFlow.purchases, payments: prevPayments, newCredit: prevNewCredit.amount, closing: prevClosing },
    opening, closing, flow,
    newCredit: newCredit.amount,
    creditSettled: netPayments + flow.creditAdjustments,
    purchaseCount: newCredit.count,
    paymentCount: payCount,
    change: { purchases: changePct(flow.purchases, prevFlow.purchases), payments: changePct(netPayments, prevPayments), closing: changePct(closing, prevClosing) },
    daily,
    suppliers: supplierRows,
    highest: top ? { id: top.id, name: top.name, closing: top.closing } : null,
    overdue,
    overdueTotal: overdue.reduce((a, b) => a + b.due, 0),
    reconciled: opening + flow.increase - flow.decrease === closing && supplierRows.reduce((a, r) => a + r.closing, 0) === closing,
  };
}

export function reportTitle(r: Pick<PayablesReport, "period" | "from" | "to">) {
  const span = r.from === r.to ? fmtDate(r.from) : `${fmtDate(r.from)} to ${fmtDate(r.to)}`;
  const kind = { day: "Daily", week: "Weekly", month: "Monthly", custom: "Supplier credit" }[r.period];
  return `${kind === "Supplier credit" ? kind : `${kind} supplier credit`} report - ${span}`;
}

// ---------------------------------------------------------------------------
// PDF and CSV
// ---------------------------------------------------------------------------

export async function payablesReportPdf(r: PayablesReport, meta: { businessName: string; generatedAt?: Date }): Promise<Uint8Array> {
  const w = await PdfWriter.create(`SAF Dine Flow - supplier credit - generated ${fmtDateTime(meta.generatedAt ?? new Date())} IST by SAF Flow`);
  w.band(meta.businessName, reportTitle(r), `Amounts owed to suppliers  |  ${r.reconciled ? "Balances reconcile with the ledger" : "CHECK: balances do not reconcile"}`);
  w.kpis([
    ["Owed at start", pdfMoney(r.opening)],
    ["Purchases", pdfMoney(r.flow.purchases)],
    ["Paid to suppliers", pdfMoney(r.flow.payments - r.flow.paymentReversals)],
    ["Owed at end", pdfMoney(r.closing), r.closing < 0 ? PDF_COLORS.BAD : undefined],
  ]);
  const pct = (v: number | null) => (v == null ? "new" : `${v > 0 ? "+" : ""}${v}%`);
  w.text(`New credit (unpaid part of purchases) ${pdfMoney(r.newCredit)}   |   Credit settled ${pdfMoney(r.creditSettled)}   |   Overdue now ${pdfMoney(r.overdueTotal)}`, { size: 9, color: PDF_COLORS.MUTED });
  w.y -= 14;
  w.text(`Previous period (${fmtDate(r.previous.from)} - ${fmtDate(r.previous.to)}): purchases ${pdfMoney(r.previous.purchases)} (${pct(r.change.purchases)}), payments ${pdfMoney(r.previous.payments)} (${pct(r.change.payments)}), owed at end ${pdfMoney(r.previous.closing)}`, { size: 8.5, color: PDF_COLORS.MUTED });
  w.y -= 4;

  w.heading("Movement");
  const lines: [string, number, number][] = [
    ["Owed at start", r.opening, 0],
    ["Credit purchases", r.flow.purchases, 0],
    ["Opening balances added", r.flow.openingBalances, 0],
    ["Other increases (adjustments)", r.flow.debitAdjustments, 0],
    ["Payment reversals", r.flow.paymentReversals, 0],
    ["Payments", 0, r.flow.payments],
    ["Returns, discounts and credits", 0, r.flow.creditAdjustments],
    ["Cancelled purchases", 0, r.flow.cancellations],
  ];
  if (r.flow.adjustmentReversals) lines.push(["Adjustment reversals (net)", Math.max(0, r.flow.adjustmentReversals), Math.max(0, -r.flow.adjustmentReversals)]);
  w.table(
    [{ label: "", width: 275 }, { label: "Adds to amount owed", width: 120, align: "right" }, { label: "Reduces it", width: 120, align: "right" }],
    lines.filter(([, a, b], i) => i === 0 || a || b).map(([l, a, b]) => [l, a ? pdfMoney(a) : "", b ? pdfMoney(b) : ""]),
    { totalRow: ["Owed at end", pdfMoney(r.closing), ""] },
  );

  w.heading("By supplier");
  if (r.suppliers.length) {
    w.table(
      [{ label: "Supplier", width: 150 }, { label: "At start", width: 72, align: "right" }, { label: "Purchases", width: 75, align: "right" }, { label: "Paid", width: 72, align: "right" }, { label: "Other", width: 70, align: "right" }, { label: "At end", width: 76, align: "right" }],
      r.suppliers.map((s) => [`${s.name}${s.isActive ? "" : " (inactive)"}`, pdfMoney(s.opening), pdfMoney(s.purchases), pdfMoney(s.payments), pdfMoney(s.other), pdfMoney(s.closing)]),
      { totalRow: ["Total", pdfMoney(r.opening), pdfMoney(r.flow.purchases + r.flow.openingBalances), pdfMoney(r.flow.payments - r.flow.paymentReversals), pdfMoney(r.suppliers.reduce((a, s) => a + s.other, 0)), pdfMoney(r.closing)] },
    );
    if (r.highest) { w.y -= 4; w.text(`Highest outstanding: ${r.highest.name} ${pdfMoney(r.highest.closing)}`, { size: 9, bold: true }); w.y -= 12; }
  } else { w.text("No supplier activity.", { size: 9, color: PDF_COLORS.MUTED }); w.y -= 12; }

  w.heading(`Overdue bills (as of ${fmtDate(r.today)})`);
  if (r.overdue.length) {
    w.table(
      [{ label: "Bill", width: 55 }, { label: "Supplier", width: 160 }, { label: "Bill date", width: 75 }, { label: "Due date", width: 75 }, { label: "Days late", width: 55, align: "right" }, { label: "Owed", width: 95, align: "right" }],
      r.overdue.map((b) => [b.number, b.supplier, fmtDate(b.billDate), fmtDate(b.dueDate), String(b.daysOverdue), pdfMoney(b.due)]),
      { totalRow: ["", "Total", "", "", "", pdfMoney(r.overdueTotal)] },
    );
  } else { w.text("Nothing is overdue.", { size: 9, color: PDF_COLORS.MUTED }); w.y -= 12; }

  if (r.daily.length > 1) {
    w.heading("Day by day");
    w.table(
      [{ label: "Date", width: 160 }, { label: "Purchases", width: 115, align: "right" }, { label: "Payments", width: 115, align: "right" }, { label: "Owed at end of day", width: 125, align: "right" }],
      r.daily.map((d) => [fmtDate(d.date), pdfMoney(d.purchases), pdfMoney(d.payments), pdfMoney(d.balance)]),
    );
  }
  return w.doc.save();
}

/** CSV (opens in Excel): amounts in rupees with two decimals, no currency symbol. */
export function payablesReportCsv(r: PayablesReport, businessName: string): string {
  const rs = (p: number) => (p / 100).toFixed(2);
  const cell = (v: string | number) => {
    const s = String(v);
    // Leading = + - @ would run as a formula in a spreadsheet.
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const row = (...v: (string | number)[]) => v.map(cell).join(",");
  const out = [
    row(businessName), row(reportTitle(r)), "",
    row("Summary", "Amount (Rs)"),
    row("Owed at start", rs(r.opening)),
    row("Credit purchases", rs(r.flow.purchases)),
    row("Opening balances added", rs(r.flow.openingBalances)),
    row("Other increases", rs(r.flow.debitAdjustments)),
    row("Payment reversals", rs(r.flow.paymentReversals)),
    row("Payments", rs(-r.flow.payments)),
    row("Returns, discounts and credits", rs(-r.flow.creditAdjustments)),
    row("Cancelled purchases", rs(-r.flow.cancellations)),
    row("Adjustment reversals (net)", rs(r.flow.adjustmentReversals)),
    row("Owed at end", rs(r.closing)),
    row("New credit (unpaid part of purchases)", rs(r.newCredit)),
    row("Credit settled", rs(r.creditSettled)),
    row("Overdue now", rs(r.overdueTotal)),
    row(`Previous period ${r.previous.from} to ${r.previous.to}: purchases`, rs(r.previous.purchases)),
    row("Previous period: payments", rs(r.previous.payments)),
    row("Previous period: owed at end", rs(r.previous.closing)),
    "",
    row("Supplier", "Category", "Active", "At start", "Purchases", "Paid", "Other", "At end", "Overdue"),
    ...r.suppliers.map((s) => row(s.name, s.category, s.isActive ? "yes" : "no", rs(s.opening), rs(s.purchases), rs(s.payments), rs(s.other), rs(s.closing), rs(s.overdue))),
    "",
    row("Overdue bill", "Supplier", "Bill date", "Due date", "Days late", "Owed"),
    ...r.overdue.map((b) => row(b.number, b.supplier, b.billDate, b.dueDate ?? "", b.daysOverdue, rs(b.due))),
    "",
    row("Date", "Purchases", "Payments", "Owed at end of day"),
    ...r.daily.map((d) => row(d.date, rs(d.purchases), rs(d.payments), rs(d.balance))),
  ];
  return `﻿${out.join("\r\n")}\r\n`;
}

/** Ledger CSV for one supplier. */
export function ledgerCsv(supplierName: string, l: Awaited<ReturnType<typeof supplierLedger>>): string {
  const rs = (p: number) => (p / 100).toFixed(2);
  const cell = (v: string | number) => {
    const s = String(v);
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const row = (...v: (string | number)[]) => v.map(cell).join(",");
  return `﻿${[
    row(`Supplier ledger: ${supplierName}`), "",
    row("Date", "Transaction", "Reference", "Added to amount owed", "Paid / reduced", "Balance"),
    row("", "Balance brought forward", "", "", "", rs(l.opening)),
    ...l.entries.map((e) => row(e.date, e.description, e.reference ?? "", e.increase ? rs(e.increase) : "", e.decrease ? rs(e.decrease) : "", rs(e.balance))),
    row("", "Totals", "", rs(l.totals.increase), rs(l.totals.decrease), rs(l.closing)),
  ].join("\r\n")}\r\n`;
}

/** Days between an ISO date and today. */
export const ageDays = (from: ISODate, today: ISODate) => Math.round((Date.parse(today) - Date.parse(from)) / DAY);
export { docNo };
