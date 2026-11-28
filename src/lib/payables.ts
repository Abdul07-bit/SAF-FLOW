/**
 * Supplier credit (payables) arithmetic, shared by the server and the browser.
 * Money is integer paise; quantities are handled as integer thousandths so a
 * line amount is computed exactly (BigInt) and rounded half up once.
 * See docs/SUPPLIER-CREDIT.md.
 */
import { addDays, addMonths, daysBetween, startOfMonth, endOfMonth, type ISODate } from "./dates";

export const SUPPLIER_CATEGORIES = ["CHICKEN", "MEAT", "VEGETABLES", "GROCERIES", "DAIRY", "BEVERAGES", "OTHER"] as const;
export const PURCHASE_UNITS = ["KG", "GRAM", "LITRE", "PIECE", "BOX", "PACKET", "OTHER"] as const;
export const SUPPLIER_PAYMENT_METHODS = ["CASH", "UPI", "BANK_TRANSFER", "OTHER"] as const;
export const ADJUSTMENT_KINDS = ["RETURN", "DISCOUNT", "CORRECTION", "WRITE_OFF", "OTHER"] as const;

export type SupplierCategory = (typeof SUPPLIER_CATEGORIES)[number];
export type PurchaseUnit = (typeof PURCHASE_UNITS)[number];

/** Largest single amount (one line, bill, payment or adjustment): Rs 1 crore. */
export const MAX_AMOUNT_PAISE = 1_000_000_000;
/** Largest quantity on one line. */
export const MAX_QUANTITY = 1_000_000;

const QTY_RE = /^\d{1,7}(\.\d{1,3})?$/;

/** "20", "2.5", 0.125 -> thousandths (20000, 2500, 125). null when not a valid positive quantity. */
export function parseQuantity(v: string | number): number | null {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v.trim();
  if (!QTY_RE.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const milli = Number(whole) * 1000 + Number(frac.padEnd(3, "0"));
  return milli > 0 && milli <= MAX_QUANTITY * 1000 ? milli : null;
}

/** Thousandths -> "20", "2.5", "0.125" (no trailing zeros). */
export function formatQuantity(milli: number): string {
  const whole = Math.floor(milli / 1000);
  const frac = String(milli % 1000).padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** round(quantity x rate), half up. quantity in thousandths, rate in paise per unit. */
export function lineAmount(qtyMilli: number, ratePaise: number): number {
  if (!Number.isInteger(qtyMilli) || !Number.isInteger(ratePaise) || qtyMilli < 0 || ratePaise < 0) throw new RangeError("lineAmount: non-negative integers only");
  return Number((BigInt(qtyMilli) * BigInt(ratePaise) + 500n) / 1000n);
}

export type BillStatus = "PAID" | "PARTIALLY_PAID" | "UNPAID" | "OVERDUE" | "CANCELLED";

/** Status shown for a bill. `due` is what is still owed on it. */
export function billStatus(b: { status: string; total: number; due: number; dueDate: ISODate | null }, today: ISODate): BillStatus {
  if (b.status === "CANCELLED") return "CANCELLED";
  if (b.due <= 0) return "PAID";
  if (b.dueDate && b.dueDate < today) return "OVERDUE";
  return b.due < b.total ? "PARTIALLY_PAID" : "UNPAID";
}

/** Due date when none is entered: bill date + the supplier's credit days. */
export function defaultDueDate(billDate: ISODate, termsDays: number | null | undefined): ISODate | null {
  return termsDays == null ? null : addDays(billDate, termsDays);
}

export interface OpenBill { id: string; due: number }
export interface OpenCredit { id: string; source: "payment" | "adjustment"; unallocated: number }
export interface PlannedAllocation { purchaseId: string; source: "payment" | "adjustment"; sourceId: string; amount: number }

/**
 * First in, first out: the oldest unallocated credit settles the oldest open
 * bill. Both lists must already be in date order. Afterwards either every bill
 * is settled or every credit is used up.
 */
export function planAllocations(bills: OpenBill[], credits: OpenCredit[]): PlannedAllocation[] {
  const out: PlannedAllocation[] = [];
  const due = bills.map((b) => ({ ...b }));
  const left = credits.map((c) => ({ ...c }));
  let i = 0;
  let j = 0;
  while (i < due.length && j < left.length) {
    if (due[i].due <= 0) { i++; continue; }
    if (left[j].unallocated <= 0) { j++; continue; }
    const amount = Math.min(due[i].due, left[j].unallocated);
    out.push({ purchaseId: due[i].id, source: left[j].source, sourceId: left[j].id, amount });
    due[i].due -= amount;
    left[j].unallocated -= amount;
  }
  return out;
}

export type ReportPeriod = "day" | "week" | "month" | "custom";

/** Monday of the week containing `d` (weeks run Monday to Sunday). */
export function weekStart(d: ISODate): ISODate {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(d, dow === 0 ? -6 : 1 - dow);
}

export function periodRange(period: Exclude<ReportPeriod, "custom">, date: ISODate): { from: ISODate; to: ISODate } {
  if (period === "day") return { from: date, to: date };
  if (period === "week") { const from = weekStart(date); return { from, to: addDays(from, 6) }; }
  return { from: startOfMonth(date), to: endOfMonth(date) };
}

/** The period just before [from, to]: the previous day / week / month, or as many days before a custom range. */
export function previousRange(period: ReportPeriod, from: ISODate, to: ISODate): { from: ISODate; to: ISODate } {
  if (period === "month") { const p = addMonths(from, -1); return { from: startOfMonth(p), to: endOfMonth(p) }; }
  const len = daysBetween(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

/** Change against the previous period, in percent (null when there is nothing to compare with). */
export function changePct(now: number, before: number): number | null {
  if (before === 0) return now === 0 ? 0 : null;
  return Math.round(((now - before) / Math.abs(before)) * 1000) / 10;
}

export const DOC_PREFIX = { purchase: "SP", payment: "PAY", adjustment: "ADJ" } as const;
export const docNo = (kind: keyof typeof DOC_PREFIX, n: number) => `${DOC_PREFIX[kind]}-${n}`;
