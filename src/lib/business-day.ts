/**
 * Business day: the trading day a sale, order or expense belongs to.
 *
 * A shop sets its opening and closing time. When the closing time is after
 * midnight (it is earlier than the opening time, e.g. open 10:00, close 02:00),
 * everything up to the closing time still belongs to the previous date:
 * an order at 01:30 on 18 Nov is part of the 17 Nov business day.
 * When the shop closes before midnight, the day rolls over at midnight.
 *
 * All times are IST. Pure functions: used by the server and the browser.
 */
import { addDays, hhmmToMinutes, istDate, startOfDayIST, type ISODate } from "./dates";

export interface BusinessHours {
  /** HH:MM, IST */
  openingTime: string;
  /** HH:MM, IST. Earlier than openingTime means the shop closes after midnight. */
  closingTime: string;
}

export const DEFAULT_HOURS: BusinessHours = { openingTime: "09:00", closingTime: "23:00" };

const MIN = 60_000;
const DAY_MS = 86_400_000;

/** True when the shop closes after midnight (closing time is not later than opening time). */
export function closesAfterMidnight(h: BusinessHours): boolean {
  return hhmmToMinutes(h.closingTime) <= hhmmToMinutes(h.openingTime);
}

/** Minutes after midnight at which one business day ends and the next begins. */
export function rolloverMinutes(h: BusinessHours): number {
  return closesAfterMidnight(h) ? hhmmToMinutes(h.closingTime) : 0;
}

/** Business date of an instant. */
export function businessDate(at: Date, h: BusinessHours): ISODate {
  return istDate(new Date(at.getTime() - rolloverMinutes(h) * MIN));
}

export function currentBusinessDate(h: BusinessHours, now = new Date()): ISODate {
  return businessDate(now, h);
}

/** First instant of business day `d`. */
export function businessDayStart(d: ISODate, h: BusinessHours): Date {
  return new Date(startOfDayIST(d).getTime() + rolloverMinutes(h) * MIN);
}

/** Last millisecond of business day `d`. */
export function businessDayEnd(d: ISODate, h: BusinessHours): Date {
  return new Date(businessDayStart(d, h).getTime() + DAY_MS - 1);
}

/** Instant at which the shop closes on business day `d` (the next calendar date when it closes after midnight). */
export function closingInstant(d: ISODate, h: BusinessHours): Date {
  const date = closesAfterMidnight(h) ? addDays(d, 1) : d;
  return new Date(startOfDayIST(date).getTime() + hhmmToMinutes(h.closingTime) * MIN);
}

/**
 * The latest business day whose closing time has passed at `now`.
 * At 02:10 on 18 Nov with closing 02:00 this is 17 Nov; at 01:50 it is 16 Nov.
 */
export function lastClosedBusinessDate(h: BusinessHours, now = new Date()): ISODate {
  const today = currentBusinessDate(h, now);
  return now >= closingInstant(today, h) ? today : addDays(today, -1);
}

/** Daily order / bill number as printed: 1 -> "001". */
export function formatDailyNo(n: number | null | undefined): string {
  return n == null ? "-" : String(n).padStart(3, "0");
}
