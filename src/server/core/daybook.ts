/**
 * Day book: one row per business day with sales, order count and expenses,
 * for any date range, in every product. Also hands out the daily order /
 * bill number (001, 002 ... restarting every business day).
 *
 * Business days come from the shop's opening and closing time
 * (src/lib/business-day.ts): a restaurant that closes at 02:00 books a
 * 01:30 order on the previous date.
 */
import type { ProductCode } from "@/config/catalog";
import { businessDate, businessDayEnd, businessDayStart, type BusinessHours } from "@/lib/business-day";
import { dateOnly, eachDate, fromDateOnly, type ISODate } from "@/lib/dates";
import { addTenders } from "@/shared/tender";
import { nextSeq, type Tx } from "../db";
import { getBusinessHours } from "./settings";

/** Business date and the next daily number for a new order (dine) or bill (bill), per branch. */
export async function nextDailyNo(db: Tx, tenantId: string, product: "dine" | "bill", branchId: string, now = new Date()) {
  const hours = await getBusinessHours(db, tenantId, product);
  const day = businessDate(now, hours);
  const dailyNo = await nextSeq(db, tenantId, `${product}-daily:${branchId}:${day}`);
  return { businessDate: dateOnly(day), dailyNo, day };
}

export interface DayRow {
  date: ISODate;
  /** Orders (dine), bills (bill) or check-ins (stay). */
  count: number;
  /** Money taken in: settled bills incl. GST (dine, bill), payments received (stay). */
  sales: number;
  expenses: number;
  net: number;
}

export interface DayBook {
  product: ProductCode;
  from: ISODate;
  to: ISODate;
  hours: BusinessHours;
  /** What `count` counts, for labels. */
  countLabel: string;
  totals: { count: number; sales: number; expenses: number; net: number; avgTicket: number; cancelled: number; discount: number; tax: number };
  daily: DayRow[];
  byMethod: { method: string; amount: number }[];
  expensesByCategory: { category: string; amount: number }[];
  expenses: { id: string; date: ISODate; category: string; description: string; amount: number; method: string; paidTo: string | null }[];
  topItems: { name: string; qty: number; revenue: number }[];
  /** Per-branch totals (only when the book covers every branch). */
  branches: { id: string; name: string; count: number; sales: number; expenses: number }[];
}

const COUNT_LABEL: Record<ProductCode, string> = { dine: "Orders", bill: "Bills", stay: "Check-ins" };

/**
 * Builds the day book for [from, to] (business dates, inclusive).
 * branchId = null covers every branch (owner's daily report).
 */
export async function buildDayBook(
  db: Tx, tenantId: string, product: ProductCode, range: { from: ISODate; to: ISODate; branchId: string | null },
): Promise<DayBook> {
  const { from, to, branchId } = range;
  const hours = await getBusinessHours(db, tenantId, product);
  const days = Object.fromEntries(eachDate(from, to).map((d) => [d, { date: d, count: 0, sales: 0, expenses: 0, net: 0 } as DayRow]));
  const dates = { gte: dateOnly(from), lte: dateOnly(to) };
  const window = { gte: businessDayStart(from, hours), lte: businessDayEnd(to, hours) };
  const branchWhere = branchId ? { branchId } : {};
  const methods: Record<string, number> = {};
  const items: Record<string, { name: string; qty: number; revenue: number }> = {};
  const perBranch: Record<string, { count: number; sales: number; expenses: number }> = {};
  const bump = (b: string | null, k: "count" | "sales" | "expenses", v: number) => {
    if (!b) return;
    perBranch[b] ??= { count: 0, sales: 0, expenses: 0 };
    perBranch[b][k] += v;
  };
  let cancelled = 0;
  let discount = 0;
  let tax = 0;

  type Expense = { id: string; branchId: string | null; expenseDate: Date; category: string; description: string; amount: number; method: string; paidTo: string | null };
  let expenses: Expense[] = [];
  const expenseQuery = { where: { tenantId, ...branchWhere, expenseDate: dates }, orderBy: [{ expenseDate: "asc" as const }, { createdAt: "asc" as const }] };

  if (product === "dine") {
    const [orders, cancelledCount, exp] = await Promise.all([
      db.dineOrder.findMany({
        where: { tenantId, ...branchWhere, status: "PAID", businessDate: dates },
        include: { items: { where: { status: { not: "CANCELLED" } } } },
      }),
      db.dineOrder.count({ where: { tenantId, ...branchWhere, status: "CANCELLED", businessDate: dates } }),
      db.dineExpense.findMany(expenseQuery),
    ]);
    cancelled = cancelledCount;
    expenses = exp;
    for (const o of orders) {
      const row = days[fromDateOnly(o.businessDate)];
      if (row) { row.count++; row.sales += o.total; }
      bump(o.branchId, "count", 1); bump(o.branchId, "sales", o.total);
      addTenders(methods, o);
      discount += o.discount; tax += o.taxTotal;
      for (const i of o.items) {
        items[i.menuItemId] ??= { name: i.name, qty: 0, revenue: 0 };
        items[i.menuItemId].qty += i.qty;
        items[i.menuItemId].revenue += i.unitPrice * i.qty;
      }
    }
  } else if (product === "bill") {
    const [sales, voided, exp] = await Promise.all([
      db.billSale.findMany({ where: { tenantId, ...branchWhere, status: "COMPLETED", businessDate: dates }, include: { items: true } }),
      db.billSale.count({ where: { tenantId, ...branchWhere, status: "VOID", businessDate: dates } }),
      db.billExpense.findMany(expenseQuery),
    ]);
    cancelled = voided;
    expenses = exp;
    for (const s of sales) {
      const row = days[fromDateOnly(s.businessDate)];
      if (row) { row.count++; row.sales += s.total; }
      bump(s.branchId, "count", 1); bump(s.branchId, "sales", s.total);
      addTenders(methods, s);
      discount += s.discount; tax += s.taxTotal;
      for (const i of s.items) {
        items[i.productId] ??= { name: i.name, qty: 0, revenue: 0 };
        items[i.productId].qty = Math.round((items[i.productId].qty + i.qty) * 1000) / 1000;
        items[i.productId].revenue += Math.round(i.unitPrice * i.qty);
      }
    }
  } else {
    const resWhere = branchId ? { reservation: { branchId } } : {};
    const [payments, checkIns, cancelledCount, exp] = await Promise.all([
      db.stayFolioPayment.findMany({ where: { tenantId, ...resWhere, createdAt: window }, include: { reservation: { select: { branchId: true } } } }),
      db.stayReservation.findMany({ where: { tenantId, ...branchWhere, checkedInAt: window }, select: { checkedInAt: true, branchId: true } }),
      db.stayReservation.count({ where: { tenantId, ...branchWhere, status: "CANCELLED", updatedAt: window } }),
      db.stayExpense.findMany(expenseQuery),
    ]);
    cancelled = cancelledCount;
    expenses = exp;
    for (const p of payments) {
      const row = days[businessDate(p.createdAt, hours)];
      if (row) row.sales += p.amount;
      bump(p.reservation.branchId, "sales", p.amount);
      methods[p.method] = (methods[p.method] ?? 0) + p.amount;
    }
    for (const r of checkIns) {
      const row = days[businessDate(r.checkedInAt!, hours)];
      if (row) row.count++;
      bump(r.branchId, "count", 1);
    }
  }

  const byCategory: Record<string, number> = {};
  for (const e of expenses) {
    const row = days[fromDateOnly(e.expenseDate)];
    if (row) row.expenses += e.amount;
    byCategory[e.category] = (byCategory[e.category] ?? 0) + e.amount;
    bump(e.branchId, "expenses", e.amount);
  }
  const daily = Object.values(days).map((d) => ({ ...d, net: d.sales - d.expenses }));
  const count = daily.reduce((a, d) => a + d.count, 0);
  const sales = daily.reduce((a, d) => a + d.sales, 0);
  const spent = daily.reduce((a, d) => a + d.expenses, 0);

  let branches: DayBook["branches"] = [];
  if (!branchId) {
    const rows = await db.branch.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: [{ isMain: "desc" }, { name: "asc" }] });
    branches = rows.filter((b) => perBranch[b.id]).map((b) => ({ id: b.id, name: b.name, ...perBranch[b.id] }));
  }

  return {
    product, from, to, hours, countLabel: COUNT_LABEL[product],
    totals: {
      count, sales, expenses: spent, net: sales - spent,
      avgTicket: product !== "stay" && count ? Math.round(sales / count) : 0,
      cancelled, discount, tax,
    },
    daily,
    byMethod: Object.entries(methods).map(([method, amount]) => ({ method, amount })).sort((a, b) => b.amount - a.amount),
    expensesByCategory: Object.entries(byCategory).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
    expenses: expenses.slice(0, 500).map((e) => ({
      id: e.id, date: fromDateOnly(e.expenseDate), category: e.category, description: e.description, amount: e.amount, method: e.method, paidTo: e.paidTo,
    })),
    topItems: Object.values(items).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
    branches,
  };
}
