/**
 * Business dates are Indian Standard Time (UTC+05:30, no DST).
 * - A "date" is a YYYY-MM-DD string in IST.
 * - Columns typed @db.Date are stored as UTC midnight of that calendar date.
 */

export const IST_OFFSET_MIN = 330;
const DAY_MS = 86_400_000;

export type ISODate = string; // YYYY-MM-DD

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** IST calendar date of an instant. */
export function istDate(at: Date = new Date()): ISODate {
  const t = new Date(at.getTime() + IST_OFFSET_MIN * 60_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function todayIST(): ISODate {
  return istDate(new Date());
}

export function isISODate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

/** Value for a @db.Date column. */
export function dateOnly(d: ISODate): Date {
  return new Date(`${d}T00:00:00.000Z`);
}

/** @db.Date column value -> ISODate */
export function fromDateOnly(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

/** Instant at which an IST day starts. */
export function startOfDayIST(d: ISODate): Date {
  return new Date(Date.parse(`${d}T00:00:00.000Z`) - IST_OFFSET_MIN * 60_000);
}

/** Last millisecond of an IST day. */
export function endOfDayIST(d: ISODate): Date {
  return new Date(startOfDayIST(d).getTime() + DAY_MS - 1);
}

export function addDays(d: ISODate, n: number): ISODate {
  const t = new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS);
  return t.toISOString().slice(0, 10);
}

/** Adds calendar months, clamping to the last day of the target month. */
export function addMonths(d: ISODate, n: number): ISODate {
  const [y, m, day] = d.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

export function startOfMonth(d: ISODate): ISODate {
  return `${d.slice(0, 7)}-01`;
}

export function endOfMonth(d: ISODate): ISODate {
  return addDays(addMonths(startOfMonth(d), 1), -1);
}

/** Indian financial year label (April-March), e.g. "2026-27". */
export function financialYear(d: ISODate): { label: string; start: ISODate; end: ISODate } {
  const [y, m] = d.split("-").map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return {
    label: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-03-31`,
  };
}

/** Minutes since midnight IST for an instant. */
export function istMinutes(at: Date): number {
  const t = new Date(at.getTime() + IST_OFFSET_MIN * 60_000);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

export function eachDate(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const dtf = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
const dtfTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
});
const tf = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return "-";
  const d = typeof v === "string" ? new Date(v.length === 10 ? `${v}T06:30:00Z` : v) : v;
  return dtf.format(d);
}

export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return "-";
  return dtfTime.format(typeof v === "string" ? new Date(v) : v);
}

export function fmtTime(v: string | Date | null | undefined): string {
  if (!v) return "-";
  return tf.format(typeof v === "string" ? new Date(v) : v);
}
