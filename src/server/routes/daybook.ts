/**
 * Day book (every product): expenses, daily sales / expenses / order counts
 * for any date range, PDF download, and the Growth plan's daily WhatsApp
 * report (history and "send now"). The scheduled job is in routes/system.ts.
 */
import { z } from "zod";
import { PRODUCTS, type ProductCode } from "@/config/catalog";
import { currentBusinessDate, lastClosedBusinessDate } from "@/lib/business-day";
import { dateOnly, daysBetween, fromDateOnly, isISODate, type ISODate } from "@/lib/dates";
import { billExpenses, dineExpenses, stayExpenses } from "@/shared/resources";
import type { ResourceDef } from "@/shared/fields";
import { registerCrud } from "../http/crud";
import { route, type Ctx } from "../http/router";
import { badRequest, HttpError } from "../http/errors";
import { buildDayBook } from "../core/daybook";
import { dayBookPdf } from "../core/daybook-pdf";
import { deliverDailyReport, REPORT_FEATURE } from "../core/daily-report";
import { getBusinessHours, getProductSettings } from "../core/settings";
import { whatsappConfigured } from "../core/whatsapp";

// ---------------------------------------------------------------------------
// Expenses (stay had them already; dine and bill get the same screen)
// ---------------------------------------------------------------------------

function registerExpenses(def: ResourceDef, model: string) {
  const product = def.product as ProductCode;
  registerCrud(def, {
    model,
    orderBy: [{ expenseDate: "desc" }, { createdAt: "desc" }],
    // No date given: the shop's current business day (02:00 spending before a
    // 02:00 closing still belongs to yesterday).
    beforeCreate: async (ctx, d) => ({
      ...d,
      expenseDate: d.expenseDate ?? dateOnly(currentBusinessDate(await getBusinessHours(ctx.db, ctx.tenantId, product))),
      createdById: ctx.user.id,
    }),
    beforeUpdate: (_ctx, d) => {
      if (d.expenseDate == null) delete d.expenseDate;
      return d;
    },
  });
}

registerExpenses(dineExpenses, "dineExpense");
registerExpenses(stayExpenses, "stayExpense");
registerExpenses(billExpenses, "billExpense");

// ---------------------------------------------------------------------------
// Day book
// ---------------------------------------------------------------------------

const DAYBOOK = { product: ":product", feature: "day_book", permission: "dashboard.view" } as const;
const REPORTS = { product: ":product", feature: REPORT_FEATURE, permission: "dashboard.view" } as const;
const MAX_DAYS = 366;

const isoDate = z.string().refine(isISODate, "Use YYYY-MM-DD");
const bookQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** "1": every branch (owners and unrestricted managers only). */
  all: z.enum(["0", "1"]).optional(),
  /** Branch for a plain link (a PDF download cannot send the x-saf-branch header). */
  branch: z.uuid().optional(),
});

async function resolveRange(ctx: Ctx<unknown, z.infer<typeof bookQuery>>) {
  const hours = await getBusinessHours(ctx.db, ctx.tenantId, ctx.product);
  const today = currentBusinessDate(hours);
  const to = ctx.query.to ?? today;
  const from = ctx.query.from ?? to;
  if (from > to) throw new HttpError(400, "BAD_RANGE", "'from' must be on or before 'to'.");
  if (daysBetween(from, to) >= MAX_DAYS) throw badRequest(`Pick at most ${MAX_DAYS} days.`);
  const all = ctx.query.all === "1";
  if (all && ctx.access.branchRestricted) throw new HttpError(403, "BRANCH_ACCESS_DENIED", "Your account can only see its own branch.");
  let branchId = ctx.branchId;
  if (ctx.query.branch && ctx.query.branch !== branchId) {
    // Same rule as the x-saf-branch header: a granted branch, and other than the main one only with multi-branch.
    const b = ctx.access.branches.find((x) => x.id === ctx.query.branch);
    if (!b || (!b.isMain && !ctx.has("multi_branch") && !ctx.access.branchRestricted))
      throw new HttpError(403, "BRANCH_ACCESS_DENIED", "Your account does not have access to this branch.");
    branchId = b.id;
  }
  return { from, to, today, hours, branchId: all ? null : branchId };
}

route({
  method: "GET", path: "/:product/day-book", tag: "day-book",
  summary: "Day book: sales, order count and expenses per business day for a date range", auth: DAYBOOK, query: bookQuery,
  handler: async (ctx) => {
    const r = await resolveRange(ctx);
    const book = await buildDayBook(ctx.db, ctx.tenantId, ctx.product, r);
    return { ...book, today: r.today, allBranches: r.branchId === null };
  },
});

route({
  method: "GET", path: "/:product/day-book/pdf", tag: "day-book",
  summary: "Day book as a PDF (one day: the daily closing report)", auth: DAYBOOK, query: bookQuery,
  rateLimit: { limit: 30, windowMs: 60_000, by: "user" },
  handler: async (ctx) => {
    const r = await resolveRange(ctx);
    const product = ctx.product as ProductCode;
    const [book, business, settings, branch] = await Promise.all([
      buildDayBook(ctx.db, ctx.tenantId, product, r),
      ctx.db.business.findUnique({ where: { tenantId: ctx.tenantId }, select: { name: true } }),
      getProductSettings(ctx.db, ctx.tenantId, product),
      r.branchId ? ctx.db.branch.findFirst({ where: { id: r.branchId, tenantId: ctx.tenantId }, select: { name: true } }) : null,
    ]);
    const s = settings as Record<string, unknown>;
    const name = (s.restaurantName || s.hotelName || s.storeName || business?.name || "Business") as string;
    const pdf = await dayBookPdf(book, { businessName: name, productName: PRODUCTS[product].name, branchName: branch?.name ?? "All branches" });
    const file = r.from === r.to ? `day-book-${r.from}.pdf` : `day-book-${r.from}-to-${r.to}.pdf`;
    return new Response(Buffer.from(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${file}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
});

// ---------------------------------------------------------------------------
// Daily WhatsApp report (Growth)
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/:product/daily-reports", tag: "day-book",
  summary: "Daily WhatsApp report: settings summary and the last 60 reports", auth: REPORTS,
  handler: async (ctx) => {
    const settings = await getProductSettings(ctx.db, ctx.tenantId, ctx.product);
    const hours = { openingTime: settings.openingTime, closingTime: settings.closingTime };
    const [rows, business] = await Promise.all([
      ctx.db.dailyReport.findMany({ where: { tenantId: ctx.tenantId, productCode: ctx.product }, orderBy: { businessDate: "desc" }, take: 60 }),
      ctx.db.business.findUnique({ where: { tenantId: ctx.tenantId }, select: { phone: true } }),
    ]);
    return {
      enabled: settings.dailyReportEnabled,
      sendTo: settings.reportWhatsApp || business?.phone || null,
      hours,
      lastClosed: lastClosedBusinessDate(hours),
      whatsappReady: whatsappConfigured(),
      items: rows.map((r) => ({ ...r, businessDate: fromDateOnly(r.businessDate) })),
    };
  },
});

route({
  method: "POST", path: "/:product/daily-reports/send", tag: "day-book",
  summary: "Send a day's closing report to the owner's WhatsApp now (sends again if it already went)", auth: REPORTS,
  body: z.object({ date: isoDate.optional() }),
  rateLimit: { limit: 10, windowMs: 3600_000, by: "user" },
  handler: async (ctx) => {
    const hours = await getBusinessHours(ctx.db, ctx.tenantId, ctx.product);
    const today = currentBusinessDate(hours);
    const date: ISODate = ctx.body.date ?? lastClosedBusinessDate(hours);
    if (date > today) throw badRequest("That business day has not started yet.");
    const r = await deliverDailyReport(ctx.tenantId, ctx.product as ProductCode, date, { force: true });
    if (!r.delivered) throw new HttpError(409, "REPORT_IN_PROGRESS", "This report is being sent right now. Try again in a minute.");
    return { date, ...r };
  },
});
