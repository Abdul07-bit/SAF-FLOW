import type { BillingCycle, Invoice, InvoiceKind, PaymentMethod, Plan, PlanTier, ProductSubscription } from "@prisma/client";
import { PRODUCTS, type ProductCode } from "@/config/catalog";
import {
  addDays, addMonths, daysBetween, endOfDayIST, financialYear, fmtDate, istDate, startOfDayIST, todayIST, type ISODate,
} from "@/lib/dates";
import { formatINR, taxOn } from "@/lib/money";
import { nextSeq, type Tx } from "../db";
import { badRequest, conflict, notFound } from "../http/errors";
import { getPlatformSettings } from "./settings";
import { notify } from "./notify";
import { summarize, subscriptionState } from "./access";

type Actor = { id: string } | null;

/** Inclusive expiry date of a period that starts on `start`. */
export function periodExpiry(start: ISODate, cycle: BillingCycle): ISODate {
  return addDays(addMonths(start, cycle === "MONTHLY" ? 1 : 12), -1);
}

export function cyclePrice(plan: Pick<Plan, "monthlyPrice" | "annualPrice">, cycle: BillingCycle): number {
  return cycle === "MONTHLY" ? plan.monthlyPrice : plan.annualPrice;
}

async function planFor(db: Tx, productCode: string, tier: PlanTier) {
  const plan = await db.plan.findUnique({ where: { productCode_tier: { productCode, tier } } });
  if (!plan || !plan.isActive) throw badRequest(`The ${tier} plan is not available for ${productCode}.`);
  return plan;
}

async function event(db: Tx, sub: { id: string; tenantId: string }, type: string, meta: Record<string, unknown>, actor: Actor) {
  await db.subscriptionEvent.create({
    data: { tenantId: sub.tenantId, subscriptionId: sub.id, type, meta: meta as object, actorId: actor?.id ?? null },
  });
}

// ---------------------------------------------------------------------------
// Invoices & payments
// ---------------------------------------------------------------------------

export async function issueInvoice(
  db: Tx,
  i: {
    tenantId: string;
    subscriptionId?: string | null;
    kind: InvoiceKind;
    productCode?: string | null;
    description: string;
    subtotal: number;
    planId?: string | null;
    billingCycle?: BillingCycle | null;
    periodStart?: ISODate | null;
    periodEnd?: ISODate | null;
  },
): Promise<Invoice> {
  const settings = await getPlatformSettings(db);
  const seq = await nextSeq(db, null, "saf-invoice");
  const fy = financialYear(todayIST()).label;
  const tax = taxOn(i.subtotal, settings.gstRateBp);
  return db.invoice.create({
    data: {
      tenantId: i.tenantId,
      subscriptionId: i.subscriptionId ?? null,
      invoiceNo: `${settings.invoicePrefix}/${fy}/${String(seq).padStart(5, "0")}`,
      kind: i.kind,
      productCode: i.productCode ?? null,
      description: i.description,
      planId: i.planId ?? null,
      billingCycle: i.billingCycle ?? null,
      periodStart: i.periodStart ? startOfDayIST(i.periodStart) : null,
      periodEnd: i.periodEnd ? endOfDayIST(i.periodEnd) : null,
      subtotal: i.subtotal,
      taxAmount: tax,
      total: i.subtotal + tax,
      dueDate: endOfDayIST(addDays(todayIST(), settings.invoiceDueDays)),
    },
  });
}

/**
 * Records a successful payment. When an invoice is fully paid it is marked
 * PAID and, for subscription invoices, the subscription is extended to the
 * invoice period (idempotent).
 */
export async function recordPayment(
  db: Tx,
  p: {
    invoiceId: string;
    amount?: number;
    method: PaymentMethod;
    reference?: string | null;
    notes?: string | null;
    paidAt?: Date;
    recordedById?: string | null;
    gatewayPaymentId?: string | null;
  },
  actor: Actor,
) {
  const invoice = await db.invoice.findUnique({ where: { id: p.invoiceId }, include: { payments: true } });
  if (!invoice) throw notFound("Invoice");
  if (invoice.status === "VOID") throw badRequest("This invoice has been voided.");
  const alreadyPaid = invoice.payments.filter((x) => x.status === "SUCCEEDED").reduce((a, b) => a + b.amount, 0);
  const outstanding = invoice.total - alreadyPaid;
  if (outstanding <= 0) throw conflict("This invoice is already fully paid.");
  const amount = p.amount ?? outstanding;
  if (amount <= 0 || amount > outstanding) throw badRequest(`Amount must be between 0.01 and ${formatINR(outstanding)}.`);

  const payment = await db.payment.create({
    data: {
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      subscriptionId: invoice.subscriptionId,
      amount,
      method: p.method,
      status: "SUCCEEDED",
      reference: p.reference ?? null,
      notes: p.notes ?? null,
      paidAt: p.paidAt ?? new Date(),
      recordedById: p.recordedById ?? null,
      gatewayPaymentId: p.gatewayPaymentId ?? null,
    },
  });
  if (alreadyPaid + amount >= invoice.total) await markInvoicePaid(db, invoice, actor);
  return payment;
}

export async function markInvoicePaid(db: Tx, invoice: Invoice, actor: Actor) {
  await db.invoice.update({ where: { id: invoice.id }, data: { status: "PAID", paidAt: new Date() } });
  if (invoice.kind === "SUBSCRIPTION" && invoice.subscriptionId && invoice.periodEnd) {
    const sub = await db.productSubscription.findUnique({ where: { id: invoice.subscriptionId } });
    if (sub && sub.currentPeriodEnd < invoice.periodEnd) await extendTo(db, sub, invoice, actor);
  }
}

/** Moves the subscription onto the invoice's period, plan and cycle. */
async function extendTo(db: Tx, sub: ProductSubscription, invoice: Invoice, actor: Actor) {
  const data = {
    currentPeriodStart: invoice.periodStart ?? sub.currentPeriodStart,
    currentPeriodEnd: invoice.periodEnd!,
    planId: invoice.planId ?? sub.planId,
    billingCycle: invoice.billingCycle ?? sub.billingCycle,
    pendingPlanId: null,
    pendingBillingCycle: null,
    status: sub.status === "EXPIRED" ? ("ACTIVE" as const) : sub.status,
  };
  await db.productSubscription.update({ where: { id: sub.id }, data });
  await event(db, sub, "RENEWED", {
    invoiceNo: invoice.invoiceNo,
    from: sub.currentPeriodEnd.toISOString(),
    to: invoice.periodEnd!.toISOString(),
    planChanged: data.planId !== sub.planId,
  }, actor);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface NewSubscriptionInput {
  productCode: ProductCode;
  tier: PlanTier;
  billingCycle: BillingCycle;
  startDate: ISODate;
  expiryDate?: ISODate;
  setupFee?: number;
  graceDays?: number | null;
  paid?: { setup?: boolean; subscription?: boolean; method?: PaymentMethod; reference?: string };
}

export async function createSubscription(db: Tx, tenantId: string, input: NewSubscriptionInput, actor: Actor) {
  const plan = await planFor(db, input.productCode, input.tier);
  const expiry = input.expiryDate ?? periodExpiry(input.startDate, input.billingCycle);
  if (expiry < input.startDate) throw badRequest("Subscription expiry must be on or after the activation date.");
  const setupFee = input.setupFee ?? plan.setupFee;

  const existing = await db.productSubscription.findUnique({
    where: { tenantId_productCode: { tenantId, productCode: input.productCode } },
    include: { plan: true },
  });
  if (existing) {
    const st = subscriptionState(existing, existing.plan.graceDays).state;
    if (st !== "CANCELLED" && st !== "EXPIRED")
      throw conflict(`${PRODUCTS[input.productCode].name} is already subscribed (${st.toLowerCase()}).`);
  }

  const data = {
    planId: plan.id,
    billingCycle: input.billingCycle,
    status: "ACTIVE" as const,
    startDate: startOfDayIST(input.startDate),
    currentPeriodStart: startOfDayIST(input.startDate),
    currentPeriodEnd: endOfDayIST(expiry),
    graceDays: input.graceDays ?? null,
    setupFee,
    pendingPlanId: null,
    pendingBillingCycle: null,
    suspendedAt: null,
    suspendedReason: null,
    cancelledAt: null,
  };
  const sub = existing
    ? await db.productSubscription.update({ where: { id: existing.id }, data })
    : await db.productSubscription.create({ data: { tenantId, productCode: input.productCode, ...data } });

  const productName = PRODUCTS[input.productCode].name;
  const method = input.paid?.method ?? "CASH";
  if (setupFee > 0) {
    const inv = await issueInvoice(db, {
      tenantId, subscriptionId: sub.id, kind: "SETUP", productCode: input.productCode,
      description: `${productName} - one-time setup (${plan.name})`, subtotal: setupFee,
    });
    if (input.paid?.setup) await recordPayment(db, { invoiceId: inv.id, method, reference: input.paid.reference, recordedById: actor?.id }, actor);
  }
  const first = await issueInvoice(db, {
    tenantId, subscriptionId: sub.id, kind: "SUBSCRIPTION", productCode: input.productCode,
    description: `${productName} ${plan.name} - ${input.billingCycle === "MONTHLY" ? "monthly maintenance" : "annual advance"}`,
    subtotal: cyclePrice(plan, input.billingCycle), planId: plan.id, billingCycle: input.billingCycle,
    periodStart: input.startDate, periodEnd: expiry,
  });
  if (input.paid?.subscription) await recordPayment(db, { invoiceId: first.id, method, reference: input.paid.reference, recordedById: actor?.id }, actor);

  await event(db, sub, existing ? "REACTIVATED" : "CREATED", { tier: input.tier, cycle: input.billingCycle, expiry }, actor);
  return sub;
}

/** Renews for one more cycle. Early renewals start the day after the current expiry (no days lost). */
export async function renewSubscription(
  db: Tx,
  subId: string,
  opts: { billingCycle?: BillingCycle; payment?: { method: PaymentMethod; reference?: string } },
  actor: Actor,
) {
  const sub = await db.productSubscription.findUnique({ where: { id: subId }, include: { plan: true, pendingPlan: true } });
  if (!sub) throw notFound("Subscription");
  if (sub.status === "CANCELLED") throw badRequest("Reactivate the cancelled subscription before renewing.");

  let invoice = await openRenewalInvoice(db, sub);
  if (!invoice) {
    const plan = sub.pendingPlan ?? sub.plan;
    const cycle = opts.billingCycle ?? sub.pendingBillingCycle ?? sub.billingCycle;
    const start = nextPeriodStart(sub);
    invoice = await issueInvoice(db, {
      tenantId: sub.tenantId, subscriptionId: sub.id, kind: "SUBSCRIPTION", productCode: sub.productCode,
      description: `${PRODUCTS[sub.productCode as ProductCode].name} ${plan.name} - renewal (${cycle === "MONTHLY" ? "monthly" : "annual"})`,
      subtotal: cyclePrice(plan, cycle), planId: plan.id, billingCycle: cycle,
      periodStart: start, periodEnd: periodExpiry(start, cycle),
    });
  }
  // Super Admin renewals take effect immediately; the invoice stays open
  // until a payment is recorded against it.
  await extendTo(db, sub, invoice, actor);
  if (opts.payment) await recordPayment(db, { invoiceId: invoice.id, method: opts.payment.method, reference: opts.payment.reference, recordedById: actor?.id }, actor);
  return db.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
}

function nextPeriodStart(sub: ProductSubscription): ISODate {
  const dayAfterExpiry = addDays(istDate(sub.currentPeriodEnd), 1);
  const today = todayIST();
  return dayAfterExpiry > today ? dayAfterExpiry : today;
}

async function openRenewalInvoice(db: Tx, sub: ProductSubscription) {
  return db.invoice.findFirst({
    where: { subscriptionId: sub.id, kind: "SUBSCRIPTION", status: "ISSUED", periodEnd: { gt: sub.currentPeriodEnd } },
    orderBy: { createdAt: "desc" },
  });
}

export async function changePlan(
  db: Tx,
  subId: string,
  opts: { tier: PlanTier; billingCycle?: BillingCycle; effective: "NOW" | "PERIOD_END"; chargeProration?: boolean },
  actor: Actor,
) {
  const sub = await db.productSubscription.findUnique({ where: { id: subId }, include: { plan: true } });
  if (!sub) throw notFound("Subscription");
  const newPlan = await planFor(db, sub.productCode, opts.tier);
  const cycleChange = opts.billingCycle && opts.billingCycle !== sub.billingCycle;
  if (newPlan.id === sub.planId && !cycleChange) throw badRequest("The subscription is already on this plan and billing cycle.");
  const isUpgrade = sub.plan.tier === "BASIC" && newPlan.tier === "GROWTH";
  const productName = PRODUCTS[sub.productCode as ProductCode].name;

  if (opts.effective === "PERIOD_END") {
    await db.productSubscription.update({
      where: { id: sub.id },
      data: {
        pendingPlanId: newPlan.id === sub.planId ? null : newPlan.id,
        pendingBillingCycle: cycleChange ? opts.billingCycle : null,
      },
    });
    await event(db, sub, "PLAN_CHANGE_SCHEDULED", { toTier: newPlan.tier, toCycle: opts.billingCycle ?? null }, actor);
    return { applied: "PERIOD_END" as const, invoice: null };
  }

  // Immediate change. The billing cycle always changes at the next renewal.
  await db.productSubscription.update({
    where: { id: sub.id },
    data: { planId: newPlan.id, pendingPlanId: null, pendingBillingCycle: cycleChange ? opts.billingCycle : null },
  });

  let invoice: Invoice | null = null;
  if (isUpgrade && opts.chargeProration !== false) {
    const today = todayIST();
    const start = istDate(sub.currentPeriodStart);
    const end = istDate(sub.currentPeriodEnd);
    const total = Math.max(1, daysBetween(start, end) + 1);
    const remaining = Math.min(total, Math.max(0, daysBetween(today, end) + 1));
    const diff = cyclePrice(newPlan, sub.billingCycle) - cyclePrice(sub.plan, sub.billingCycle);
    const prorated = Math.max(0, Math.round((diff * remaining) / total));
    const setupDiff = Math.max(0, newPlan.setupFee - sub.plan.setupFee);
    if (prorated + setupDiff > 0) {
      invoice = await issueInvoice(db, {
        tenantId: sub.tenantId, subscriptionId: sub.id, kind: "PRORATION", productCode: sub.productCode,
        description: `${productName} upgrade ${sub.plan.name} -> ${newPlan.name}: ${remaining}/${total} days prorated` +
          (setupDiff ? ` + setup difference ${formatINR(setupDiff)}` : ""),
        subtotal: prorated + setupDiff, planId: newPlan.id,
      });
    }
  }
  await event(db, sub, isUpgrade ? "UPGRADED" : "DOWNGRADED", { fromTier: sub.plan.tier, toTier: newPlan.tier }, actor);
  return { applied: "NOW" as const, invoice };
}

export async function setSubscriptionStatus(
  db: Tx,
  subId: string,
  action: "suspend" | "reactivate" | "cancel",
  reason: string | undefined,
  actor: Actor,
) {
  const sub = await db.productSubscription.findUnique({ where: { id: subId }, include: { plan: true } });
  if (!sub) throw notFound("Subscription");
  if (action === "suspend") {
    await db.productSubscription.update({ where: { id: subId }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspendedReason: reason ?? null } });
  } else if (action === "cancel") {
    await db.productSubscription.update({ where: { id: subId }, data: { status: "CANCELLED", cancelledAt: new Date(), autoRenew: false } });
  } else {
    const byDates = subscriptionState({ ...sub, status: "ACTIVE" }, sub.plan.graceDays).state;
    await db.productSubscription.update({
      where: { id: subId },
      data: { status: byDates === "EXPIRED" ? "EXPIRED" : "ACTIVE", suspendedAt: null, suspendedReason: null, cancelledAt: null },
    });
  }
  await event(db, sub, action.toUpperCase() + (action.endsWith("e") ? "D" : "ED"), { reason: reason ?? null }, actor);
}

export async function adjustSubscription(
  db: Tx,
  subId: string,
  patch: { expiryDate?: ISODate; graceDays?: number | null; autoRenew?: boolean },
  actor: Actor,
) {
  const sub = await db.productSubscription.findUnique({ where: { id: subId } });
  if (!sub) throw notFound("Subscription");
  const data: Record<string, unknown> = {};
  if (patch.expiryDate) {
    if (patch.expiryDate < istDate(sub.startDate)) throw badRequest("Expiry cannot be before the activation date.");
    data.currentPeriodEnd = endOfDayIST(patch.expiryDate);
    if (sub.status === "EXPIRED") data.status = "ACTIVE";
  }
  if (patch.graceDays !== undefined) data.graceDays = patch.graceDays;
  if (patch.autoRenew !== undefined) data.autoRenew = patch.autoRenew;
  await db.productSubscription.update({ where: { id: subId }, data });
  await event(db, sub, "ADJUSTED", patch as Record<string, unknown>, actor);
}

// ---------------------------------------------------------------------------
// Scheduled renewal job (POST /api/jobs/renewals or `npm run jobs:renewals`)
// ---------------------------------------------------------------------------

export async function runRenewalJob(db: Tx, now = new Date()) {
  const settings = await getPlatformSettings(db);
  const today = istDate(now);
  const maxLead = Math.max(0, ...settings.reminderDays);
  const subs = await db.productSubscription.findMany({
    where: { status: { in: ["ACTIVE", "EXPIRED"] } },
    include: { plan: true, pendingPlan: true, tenant: { select: { status: true } } },
  });
  const result = { expired: 0, invoicesRaised: 0, reminders: 0 };

  for (const sub of subs) {
    const summary = summarize(sub, now);
    const name = PRODUCTS[sub.productCode as ProductCode].name;

    if (summary.state === "EXPIRED" && sub.status === "ACTIVE") {
      await db.productSubscription.update({ where: { id: sub.id }, data: { status: "EXPIRED" } });
      await event(db, sub, "EXPIRED", { graceEndedAt: summary.graceEndsAt }, null);
      await notify(db, {
        tenantId: sub.tenantId, productCode: sub.productCode, kind: "SUBSCRIPTION_EXPIRED",
        title: `${name} subscription expired`,
        body: `Your ${name} subscription expired and the grace period has ended. Renew to restore access.`,
        link: `/${sub.productCode}/subscription`,
      });
      result.expired++;
      continue;
    }
    if (sub.status !== "ACTIVE" || !sub.autoRenew) continue;

    const expiryDay = istDate(sub.currentPeriodEnd);
    const daysLeft = daysBetween(today, expiryDay);
    if (daysLeft > maxLead) continue;

    // Make sure a renewal invoice exists for the next period.
    if (!(await openRenewalInvoice(db, sub))) {
      const plan = sub.pendingPlan ?? sub.plan;
      const cycle = sub.pendingBillingCycle ?? sub.billingCycle;
      const start = nextPeriodStart(sub);
      await issueInvoice(db, {
        tenantId: sub.tenantId, subscriptionId: sub.id, kind: "SUBSCRIPTION", productCode: sub.productCode,
        description: `${name} ${plan.name} - renewal (${cycle === "MONTHLY" ? "monthly" : "annual"})`,
        subtotal: cyclePrice(plan, cycle), planId: plan.id, billingCycle: cycle,
        periodStart: start, periodEnd: periodExpiry(start, cycle),
      });
      result.invoicesRaised++;
    }

    const remindedToday = sub.lastReminderAt && istDate(sub.lastReminderAt) === today;
    if ((settings.reminderDays.includes(daysLeft) || daysLeft < 0) && !remindedToday) {
      await notify(db, {
        tenantId: sub.tenantId, productCode: sub.productCode, kind: "RENEWAL_REMINDER",
        title: daysLeft >= 0 ? `${name} renews in ${daysLeft} day${daysLeft === 1 ? "" : "s"}` : `${name} is in its grace period`,
        body: daysLeft >= 0
          ? `Your ${sub.plan.name} subscription expires on ${fmtDate(expiryDay)}. Pay the renewal invoice to avoid interruption.`
          : `Your subscription expired on ${fmtDate(expiryDay)}. Access continues until ${fmtDate(summary.graceEndsAt)}.`,
        link: `/${sub.productCode}/subscription`,
      });
      await db.productSubscription.update({ where: { id: sub.id }, data: { lastReminderAt: now } });
      result.reminders++;
    }
  }
  return result;
}
