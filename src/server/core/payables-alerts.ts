/**
 * Supplier credit alerts and summaries.
 *
 * - Addressed to each user who may view supplier credit (dine.payables.view),
 *   never tenant-wide: a notification without a user is visible to every
 *   staff member, waiters included.
 * - Raised once: supplier_notifications has a unique (tenant, dedupe_key).
 * - In-app always. WhatsApp only when the server has the WhatsApp credentials
 *   and WHATSAPP_PAYABLES_TEMPLATE, and the business turned it on; and only from
 *   the scheduled check (never inside a request's database transaction).
 *
 * The scheduled check runs with the daily reports job (/api/jobs/daily-reports):
 * once per business day, after closing time.
 */
import type { Prisma } from "@prisma/client";
import { closingInstant, lastClosedBusinessDate } from "@/lib/business-day";
import { addDays, dateOnly, endOfMonth, fmtDate, type ISODate } from "@/lib/dates";
import { docNo, periodRange } from "@/lib/payables";
import { withPlatform, withTenant, type Tx } from "../db";
import { tenantEntitled } from "./access";
import { notify } from "./notify";
import { billsWithDue, supplierBalance, type PresentedBill } from "./payables";
import { buildPayablesReport, supplierOverview } from "./payables-report";
import { pdfMoney } from "./daybook-pdf";
import { getProductSettings } from "./settings";
import { payablesWhatsAppReady, sendTemplateOnWhatsApp, waNumber } from "./whatsapp";

export const PAYABLES_FEATURE = "supplier_credit";
export const VIEW_PERMISSION = "dine.payables.view";
const SEND_WINDOW_MS = 6 * 3600_000;
const MAX_TENANTS_PER_RUN = 60;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const SETTINGS_DEFAULTS = {
  notifyPurchases: true, notifyPayments: true, notifyOverdue: true, totalCreditLimit: null as number | null, agingDays: 30 as number | null,
  dailySummary: true, weeklySummary: true, monthlySummary: true, whatsappEnabled: false, whatsappNumber: null as string | null, linkStockPurchases: false,
};
export type CreditSettings = typeof SETTINGS_DEFAULTS;

export async function getCreditSettings(db: Tx, tenantId: string): Promise<CreditSettings> {
  const row = await db.supplierCreditSetting.findUnique({ where: { tenantId } });
  if (!row) return { ...SETTINGS_DEFAULTS };
  const { id: _id, tenantId: _t, updatedAt: _u, updatedById: _b, ...s } = row;
  return s;
}

export async function saveCreditSettings(db: Tx, tenantId: string, userId: string, patch: Partial<CreditSettings>) {
  const merged = { ...(await getCreditSettings(db, tenantId)), ...patch };
  await db.supplierCreditSetting.upsert({
    where: { tenantId },
    create: { tenantId, ...merged, updatedById: userId },
    update: { ...merged, updatedById: userId },
  });
  return merged;
}

// ---------------------------------------------------------------------------
// Raising an alert
// ---------------------------------------------------------------------------

export interface Alert {
  kind: string;
  dedupeKey: string;
  supplierId?: string | null;
  title: string;
  body: string;
  link: string;
}

/** Users who may see supplier credit: an active Dine role that has dine.payables.view. */
export async function alertRecipients(db: Tx, tenantId: string): Promise<string[]> {
  const users = await db.user.findMany({
    where: {
      tenantId, isActive: true,
      productAccess: { some: { productCode: "dine", isActive: true, role: { permissions: { some: { permissionKey: VIEW_PERMISSION } } } } },
    },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/** Raises the alert unless it was raised before. Returns its log id, or null when it already existed. */
export async function raiseAlert(db: Tx, tenantId: string, a: Alert): Promise<string | null> {
  const exists = await db.supplierNotification.findUnique({ where: { tenantId_dedupeKey: { tenantId, dedupeKey: a.dedupeKey } }, select: { id: true } });
  if (exists) return null;
  const users = await alertRecipients(db, tenantId);
  const row = await db.supplierNotification.create({
    data: {
      tenantId, supplierId: a.supplierId ?? null, kind: a.kind, dedupeKey: a.dedupeKey, title: a.title.slice(0, 200), body: a.body.slice(0, 1000),
      recipients: users.length, channels: { inApp: users.length ? "SENT" : "NO_RECIPIENTS" } as Prisma.InputJsonValue,
    },
  });
  for (const userId of users)
    await notify(db, { tenantId, userId, productCode: "dine", kind: `SUPPLIER_${a.kind}`, title: a.title, body: a.body, link: a.link });
  return row.id;
}

const supplierLink = (id: string) => `/dine/supplier-credit/${id}`;

// ---------------------------------------------------------------------------
// Event alerts (inside the request's transaction)
// ---------------------------------------------------------------------------

async function limitChecks(db: Tx, tenantId: string, today: ISODate, supplier: { id: string; name: string; creditLimit: number | null }, s: CreditSettings) {
  if (supplier.creditLimit != null) {
    const bal = await supplierBalance(db, tenantId, supplier.id);
    if (bal > supplier.creditLimit)
      await raiseAlert(db, tenantId, {
        kind: "CREDIT_LIMIT", dedupeKey: `limit:${supplier.id}:${today}`, supplierId: supplier.id,
        title: `${supplier.name} is over its credit limit`,
        body: `You owe ${pdfMoney(bal)}; the limit is ${pdfMoney(supplier.creditLimit)}.`, link: supplierLink(supplier.id),
      });
  }
  if (s.totalCreditLimit != null) {
    const agg = await db.supplierLedgerEntry.aggregate({ where: { tenantId }, _sum: { increase: true, decrease: true } });
    const total = (agg._sum.increase ?? 0) - (agg._sum.decrease ?? 0);
    if (total > s.totalCreditLimit)
      await raiseAlert(db, tenantId, {
        kind: "TOTAL_LIMIT", dedupeKey: `total-limit:${today}`,
        title: "Supplier credit is over your limit",
        body: `You owe suppliers ${pdfMoney(total)} in total; your limit is ${pdfMoney(s.totalCreditLimit)}.`, link: "/dine/supplier-credit",
      });
  }
}

export async function onPurchaseRecorded(db: Tx, tenantId: string, today: ISODate, bill: PresentedBill) {
  const s = await getCreditSettings(db, tenantId);
  const supplier = await db.dineSupplier.findUniqueOrThrow({ where: { id: bill.supplier.id }, select: { id: true, name: true, creditLimit: true } });
  if (s.notifyPurchases) {
    const unpaid = bill.total - bill.paidAtPurchase;
    await raiseAlert(db, tenantId, {
      kind: "PURCHASE", dedupeKey: `purchase:${bill.id}`, supplierId: supplier.id,
      title: `Credit purchase from ${supplier.name}`,
      body: `${bill.number}: ${pdfMoney(bill.total)}${bill.paidAtPurchase ? `, paid ${pdfMoney(bill.paidAtPurchase)}` : ""}. ${unpaid > 0 ? `${pdfMoney(unpaid)} on credit` : "Fully paid"}${bill.dueDate ? `, due ${fmtDate(bill.dueDate)}` : ""}.`,
      link: supplierLink(supplier.id),
    });
  }
  await limitChecks(db, tenantId, today, supplier, s);
}

export async function onPaymentRecorded(db: Tx, tenantId: string, payment: { id: string; paymentNo: number; amount: number; supplierId: string }) {
  const s = await getCreditSettings(db, tenantId);
  if (!s.notifyPayments) return;
  const supplier = await db.dineSupplier.findUniqueOrThrow({ where: { id: payment.supplierId }, select: { name: true } });
  const bal = await supplierBalance(db, tenantId, payment.supplierId);
  await raiseAlert(db, tenantId, {
    kind: "PAYMENT", dedupeKey: `payment:${payment.id}`, supplierId: payment.supplierId,
    title: `Paid ${supplier.name} ${pdfMoney(payment.amount)}`,
    body: `${docNo("payment", payment.paymentNo)}. ${bal > 0 ? `Still owed: ${pdfMoney(bal)}` : bal < 0 ? `Advance with the supplier: ${pdfMoney(-bal)}` : "Nothing more is owed"}.`,
    link: supplierLink(payment.supplierId),
  });
}

// ---------------------------------------------------------------------------
// Daily check (scheduled job)
// ---------------------------------------------------------------------------

interface Outgoing { logId: string; title: string; body: string }

/**
 * Everything due at the end of business day `date`: overdue bills, limits,
 * long-unpaid balances and the daily / weekly / monthly summaries.
 * Returns the alerts raised (for WhatsApp delivery after the transaction).
 */
export async function runDailyChecks(db: Tx, tenantId: string, date: ISODate): Promise<Outgoing[] | null> {
  // One run per business day; the marker is part of this transaction.
  const claimed = await db.supplierNotification.createMany({
    data: [{ tenantId, kind: "DAILY_CHECK", dedupeKey: `run:${date}`, title: "Daily check", body: `Business day ${date}` }],
    skipDuplicates: true,
  });
  if (!claimed.count) return null;

  const s = await getCreditSettings(db, tenantId);
  const raised: Outgoing[] = [];
  const raise = async (a: Alert, whatsapp: boolean) => {
    const id = await raiseAlert(db, tenantId, a);
    if (id && whatsapp) raised.push({ logId: id, title: a.title, body: a.body });
  };
  // Bills due on `date` are late once the shop has closed that day.
  const asOf = addDays(date, 1);

  if (s.notifyOverdue) {
    const late = (await billsWithDue(db, asOf, { tenantId, status: "ACTIVE", dueDate: { lte: dateOnly(date) } }, { orderBy: [{ dueDate: "asc" }] }))
      .filter((b) => b.due > 0);
    const keys = late.map((b) => `overdue:${b.id}`);
    const seen = new Set((await db.supplierNotification.findMany({ where: { tenantId, dedupeKey: { in: keys } }, select: { dedupeKey: true } })).map((r) => r.dedupeKey));
    const fresh = late.filter((b) => !seen.has(`overdue:${b.id}`));
    // One alert per supplier, listing its newly overdue bills; each bill is remembered so it is reported once.
    const bySupplier = new Map<string, PresentedBill[]>();
    for (const b of fresh) bySupplier.set(b.supplier.id, [...(bySupplier.get(b.supplier.id) ?? []), b]);
    for (const [supplierId, bills] of bySupplier) {
      const total = bills.reduce((a, b) => a + b.due, 0);
      await db.supplierNotification.createMany({
        data: bills.map((b) => ({ tenantId, supplierId, kind: "OVERDUE_BILL", dedupeKey: `overdue:${b.id}`, title: b.number, body: `Due ${b.dueDate}` })),
        skipDuplicates: true,
      });
      await raise({
        kind: "OVERDUE", dedupeKey: `overdue-alert:${supplierId}:${date}`, supplierId,
        title: `Payment overdue: ${bills[0].supplier.name}`,
        body: `${bills.length === 1 ? `${bills[0].number} was due on ${fmtDate(bills[0].dueDate)}` : `${bills.length} bills are past their due date`}. ${pdfMoney(total)} is overdue.`,
        link: supplierLink(supplierId),
      }, true);
    }
  }

  const rows = await supplierOverview(db, tenantId, asOf);
  for (const r of rows.filter((x) => x.overLimit))
    await raise({
      kind: "CREDIT_LIMIT", dedupeKey: `limit:${r.id}:${date}`, supplierId: r.id, title: `${r.name} is over its credit limit`,
      body: `You owe ${pdfMoney(r.balance)}; the limit is ${pdfMoney(r.creditLimit ?? 0)}.`, link: supplierLink(r.id),
    }, false);
  const totalOwed = rows.reduce((a, r) => a + r.balance, 0);
  if (s.totalCreditLimit != null && totalOwed > s.totalCreditLimit)
    await raise({
      kind: "TOTAL_LIMIT", dedupeKey: `total-limit:${date}`, title: "Supplier credit is over your limit",
      body: `You owe suppliers ${pdfMoney(totalOwed)} in total; your limit is ${pdfMoney(s.totalCreditLimit)}.`, link: "/dine/supplier-credit",
    }, true);

  if (s.agingDays != null) {
    const cutoff = addDays(date, -s.agingDays);
    const open = await billsWithDue(db, asOf, { tenantId, status: "ACTIVE", billDate: { lte: dateOnly(cutoff) } }, { orderBy: [{ billDate: "asc" }] });
    const oldest = new Map<string, PresentedBill>();
    for (const b of open) if (b.due > 0 && !oldest.has(b.supplier.id)) oldest.set(b.supplier.id, b);
    for (const [supplierId, b] of oldest) {
      const bal = rows.find((r) => r.id === supplierId)?.balance ?? b.due;
      await raise({
        kind: "AGING", dedupeKey: `aging:${supplierId}:${b.id}:${s.agingDays}`, supplierId,
        title: `${b.supplier.name}: unpaid for over ${s.agingDays} days`,
        body: `${b.number} from ${fmtDate(b.billDate)} still has ${pdfMoney(b.due)} unpaid. Total owed to ${b.supplier.name}: ${pdfMoney(bal)}.`,
        link: supplierLink(supplierId),
      }, false);
    }
  }

  const summary = async (period: "day" | "week" | "month", kind: string, key: string, label: string) => {
    const { from, to } = periodRange(period, date);
    const r = await buildPayablesReport(db, tenantId, { period, from, to, today: asOf });
    if (r.opening === 0 && r.closing === 0 && r.flow.increase === 0 && r.flow.decrease === 0) return;
    await raise({
      kind, dedupeKey: key, title: `${label} supplier credit summary`,
      body: `${from === to ? fmtDate(from) : `${fmtDate(from)} - ${fmtDate(to)}`}: purchases ${pdfMoney(r.flow.purchases)}, paid ${pdfMoney(r.flow.payments - r.flow.paymentReversals)}. Owed to suppliers: ${pdfMoney(r.closing)}${r.overdueTotal ? ` (${pdfMoney(r.overdueTotal)} overdue)` : ""}.`,
      link: `/dine/supplier-reports?period=${period}&date=${date}`,
    }, true);
  };
  if (s.dailySummary) await summary("day", "DAILY_SUMMARY", `daily:${date}`, "Daily");
  // Weeks run Monday to Sunday; months end on their last day.
  if (s.weeklySummary && new Date(`${date}T00:00:00Z`).getUTCDay() === 0) await summary("week", "WEEKLY_SUMMARY", `weekly:${periodRange("week", date).from}`, "Weekly");
  if (s.monthlySummary && date === endOfMonth(date)) await summary("month", "MONTHLY_SUMMARY", `monthly:${date.slice(0, 7)}`, "Monthly");
  return raised;
}

/** WhatsApp delivery of the alerts raised by a daily check; the result is kept on each alert's log row. */
async function deliverWhatsApp(tenantId: string, alerts: Outgoing[]) {
  const info = await withTenant(tenantId, async (db) => {
    const [s, business, settings] = await Promise.all([
      getCreditSettings(db, tenantId),
      db.business.findUnique({ where: { tenantId }, select: { name: true, phone: true } }),
      getProductSettings(db, tenantId, "dine"),
    ]);
    return { s, name: settings.restaurantName || business?.name || "Your restaurant", to: waNumber(s.whatsappNumber || settings.reportWhatsApp || business?.phone) };
  });
  const status = !info.s.whatsappEnabled ? "OFF" : !payablesWhatsAppReady() ? "NOT_CONFIGURED" : !info.to ? "NO_NUMBER" : null;
  for (const a of alerts) {
    let result = status;
    if (!result) {
      try {
        await sendTemplateOnWhatsApp({ to: info.to!, template: process.env.WHATSAPP_PAYABLES_TEMPLATE!, params: [info.name, a.title, a.body] });
        result = "SENT";
      } catch (e) {
        result = `FAILED: ${(e as Error).message.slice(0, 200)}`;
      }
    }
    await withTenant(tenantId, (db) =>
      db.supplierNotification.update({ where: { id: a.logId }, data: { channels: { inApp: "SENT", whatsapp: result } as Prisma.InputJsonValue } }),
    );
  }
}

/** One restaurant's end-of-day check for business day `date`, then WhatsApp delivery. null when it already ran. */
export async function checkRestaurant(tenantId: string, date: ISODate) {
  const raised = await withTenant(tenantId, (db) => runDailyChecks(db, tenantId, date));
  if (raised?.length) await deliverWhatsApp(tenantId, raised);
  return raised;
}

/** Scheduled: every restaurant with supplier credit whose closing time passed in the last few hours, once per business day. */
export async function runPayablesAlertJob(now = new Date()) {
  const due = await withPlatform(async (db) => {
    const subs = await db.productSubscription.findMany({
      where: { productCode: "dine", status: { in: ["ACTIVE", "EXPIRED"] }, tenant: { status: "ACTIVE" } },
      select: { tenantId: true },
    });
    const out: { tenantId: string; date: ISODate }[] = [];
    for (const s of subs) {
      if (!(await tenantEntitled(db, s.tenantId, "dine", PAYABLES_FEATURE))) continue;
      const settings = await getProductSettings(db, s.tenantId, "dine");
      const hours = { openingTime: settings.openingTime, closingTime: settings.closingTime };
      const date = lastClosedBusinessDate(hours, now);
      if (now.getTime() - closingInstant(date, hours).getTime() > SEND_WINDOW_MS) continue;
      const done = await db.supplierNotification.findUnique({ where: { tenantId_dedupeKey: { tenantId: s.tenantId, dedupeKey: `run:${date}` } }, select: { id: true } });
      if (!done && (await db.dineSupplier.count({ where: { tenantId: s.tenantId } }))) out.push({ tenantId: s.tenantId, date });
    }
    return out;
  });

  const result = { due: due.length, checked: 0, alerts: 0, failed: 0, deferred: Math.max(0, due.length - MAX_TENANTS_PER_RUN) };
  for (const c of due.slice(0, MAX_TENANTS_PER_RUN)) {
    try {
      const raised = await checkRestaurant(c.tenantId, c.date);
      if (!raised) continue;
      result.checked++;
      result.alerts += raised.length;
    } catch {
      // One restaurant's problem never stops the others; its check runs again on the next call.
      result.failed++;
    }
  }
  return result;
}
