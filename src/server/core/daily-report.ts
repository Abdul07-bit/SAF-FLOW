/**
 * Growth plan: when a shop closes, the day's sales and expenses go to the
 * owner's WhatsApp as a PDF.
 *
 * A scheduled job (/api/jobs/daily-reports, every 15 minutes) finds every
 * shop whose closing time has passed and sends that business day's report
 * once. daily_reports keeps one row per business day and product, so running
 * the job again, or twice at the same time, never sends a second copy.
 */
import { PRODUCTS, PRODUCT_CODES, type ProductCode } from "@/config/catalog";
import { closingInstant, lastClosedBusinessDate } from "@/lib/business-day";
import { dateOnly, fmtDate, type ISODate } from "@/lib/dates";
import { withPlatform, withTenant } from "../db";
import { tenantEntitled } from "./access";
import { buildDayBook } from "./daybook";
import { dayBookPdf, pdfMoney } from "./daybook-pdf";
import { notify } from "./notify";
import { getProductSettings } from "./settings";
import { sendReportOnWhatsApp, waNumber, WhatsAppNotConfigured } from "./whatsapp";

export const REPORT_FEATURE = "daily_report_whatsapp";
const MAX_ATTEMPTS = 3;
/** A report not sent within this time after closing is not sent automatically any more. */
const SEND_WINDOW_MS = 6 * 3600_000;
/** A row left in SENDING this long (crashed run) may be claimed again. */
const STALE_SENDING_MS = 15 * 60_000;
/** Deliveries per job run; the next run (15 minutes later) picks up the rest. */
const MAX_PER_RUN = 40;
/** Stop starting new deliveries after this long, so a run fits the host's function time limit. */
const RUN_BUDGET_MS = () => Number(process.env.SAF_REPORT_JOB_BUDGET_MS || 45_000);

export type ReportStatus = "SENT" | "FAILED" | "SKIPPED" | "SENDING";

export interface DeliveryResult {
  status: ReportStatus;
  sentTo: string | null;
  error: string | null;
  /** false when another run already handled (or is handling) this report. */
  delivered: boolean;
}

function done(row: { status: string; attempts: number; updatedAt: Date }, now: Date) {
  if (row.status === "SENT" || row.status === "SKIPPED") return true;
  if (row.status === "FAILED") return row.attempts >= MAX_ATTEMPTS;
  if (row.status === "SENDING") return now.getTime() - row.updatedAt.getTime() < STALE_SENDING_MS;
  return false;
}

/**
 * Builds and sends one business day's report. `force` (the manager's "Send now")
 * sends again even when it already went out.
 */
export async function deliverDailyReport(tenantId: string, product: ProductCode, date: ISODate, opts: { force?: boolean; now?: Date } = {}): Promise<DeliveryResult> {
  const now = opts.now ?? new Date();
  const key = { tenantId_productCode_businessDate: { tenantId, productCode: product, businessDate: dateOnly(date) } };

  const prepared = await withTenant(tenantId, async (db) => {
    // Claim the row. A concurrent run loses the unique insert or the conditional update.
    const existing = await db.dailyReport.findUnique({ where: key });
    if (existing) {
      if (!opts.force && done(existing, now)) return null;
      const claimed = await db.dailyReport.updateMany({
        where: { id: existing.id, updatedAt: existing.updatedAt },
        data: { status: "SENDING", attempts: { increment: 1 }, error: null },
      });
      if (!claimed.count) return null;
    } else {
      try {
        await db.$executeRaw`SAVEPOINT claim_report`;
        await db.dailyReport.create({ data: { tenantId, productCode: product, businessDate: dateOnly(date), status: "SENDING", attempts: 1 } });
      } catch {
        await db.$executeRaw`ROLLBACK TO SAVEPOINT claim_report`;
        return null;
      }
    }

    const [business, settings, activeBranches] = await Promise.all([
      db.business.findUnique({ where: { tenantId }, select: { name: true, phone: true } }),
      getProductSettings(db, tenantId, product),
      db.branch.count({ where: { tenantId, isActive: true } }),
    ]);
    const book = await buildDayBook(db, tenantId, product, { from: date, to: date, branchId: null });
    const displayName = ((settings as Record<string, unknown>)[product === "dine" ? "restaurantName" : product === "stay" ? "hotelName" : "storeName"] as string) || business?.name || "Your business";
    const pdf = await dayBookPdf(book, { businessName: displayName, productName: PRODUCTS[product].name, branchName: activeBranches > 1 ? "All branches" : null, generatedAt: now });
    return { book, pdf, displayName, to: waNumber(settings.reportWhatsApp || business?.phone) };
  });
  if (!prepared) return { status: "SENDING", sentTo: null, error: null, delivered: false };

  const { book, pdf, displayName, to } = prepared;
  const summary = { count: book.totals.count, sales: book.totals.sales, expenses: book.totals.expenses, net: book.totals.net };
  let status: ReportStatus;
  let error: string | null = null;
  if (!to) {
    status = "SKIPPED";
    error = "No valid WhatsApp number. Add one in Settings > Daily report.";
  } else if (!opts.force && book.totals.count === 0 && book.totals.sales === 0 && book.totals.expenses === 0) {
    status = "SKIPPED";
    error = "No sales or expenses that day.";
  } else {
    try {
      await sendReportOnWhatsApp({
        to, pdf, filename: `${PRODUCTS[product].shortName.replace(/\s+/g, "-")}-report-${date}.pdf`,
        params: [displayName, fmtDate(date), pdfMoney(book.totals.sales), pdfMoney(book.totals.expenses)],
      });
      status = "SENT";
    } catch (e) {
      status = e instanceof WhatsAppNotConfigured ? "SKIPPED" : "FAILED";
      error = (e as Error).message.slice(0, 500);
    }
  }

  await withTenant(tenantId, async (db) => {
    const row = await db.dailyReport.update({
      where: key,
      data: { status, error, sentTo: to, summary, sentAt: status === "SENT" ? new Date() : null },
    });
    // The owner still learns about the day in the app when WhatsApp did not go out.
    const finalFailure = status === "FAILED" && row.attempts >= MAX_ATTEMPTS;
    if ((status === "SKIPPED" && error !== "No sales or expenses that day.") || finalFailure) {
      await notify(db, {
        tenantId, productCode: product, kind: "DAILY_REPORT",
        title: `Daily report for ${fmtDate(date)}`,
        body: `Sales ${pdfMoney(summary.sales)}, expenses ${pdfMoney(summary.expenses)}. Not sent on WhatsApp: ${error}`,
        link: `/${product}/day-book`,
      });
    }
  });
  return { status, sentTo: to, error, delivered: true };
}

/** Scheduled job: sends every report whose shop closed within the last few hours. */
export async function runDailyReportJob(now = new Date()) {
  const candidates = await withPlatform(async (db) => {
    const subs = await db.productSubscription.findMany({
      where: { status: { in: ["ACTIVE", "EXPIRED"] }, productCode: { in: [...PRODUCT_CODES] }, tenant: { status: "ACTIVE" } },
      select: { tenantId: true, productCode: true },
    });
    const due: { tenantId: string; product: ProductCode; date: ISODate }[] = [];
    for (const s of subs) {
      const product = s.productCode as ProductCode;
      if (!(await tenantEntitled(db, s.tenantId, product, REPORT_FEATURE))) continue;
      const settings = await getProductSettings(db, s.tenantId, product);
      if (!settings.dailyReportEnabled) continue;
      const hours = { openingTime: settings.openingTime, closingTime: settings.closingTime };
      const date = lastClosedBusinessDate(hours, now);
      if (now.getTime() - closingInstant(date, hours).getTime() > SEND_WINDOW_MS) continue;
      const row = await db.dailyReport.findUnique({ where: { tenantId_productCode_businessDate: { tenantId: s.tenantId, productCode: product, businessDate: dateOnly(date) } } });
      if (row && done(row, now)) continue;
      due.push({ tenantId: s.tenantId, product, date });
    }
    return due;
  });

  const result = { due: candidates.length, sent: 0, failed: 0, skipped: 0, deferred: 0 };
  const stopAt = Date.now() + RUN_BUDGET_MS();
  for (const [i, c] of candidates.entries()) {
    if (i >= MAX_PER_RUN || Date.now() > stopAt) { result.deferred = candidates.length - i; break; }
    try {
      const r = await deliverDailyReport(c.tenantId, c.product, c.date, { now });
      if (!r.delivered) continue;
      if (r.status === "SENT") result.sent++;
      else if (r.status === "FAILED") result.failed++;
      else result.skipped++;
    } catch {
      // One shop's problem (e.g. bad data) never stops the others.
      result.failed++;
    }
  }
  return result;
}
