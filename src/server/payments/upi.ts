import type { Invoice } from "@prisma/client";
import { badRequest, conflict, notFound } from "../http/errors";
import type { Tx } from "../db";
import { markInvoicePaid } from "../core/subscriptions";
import { notify } from "../core/notify";
import { formatINR } from "@/lib/money";

/**
 * Manual UPI payments. There is no payment gateway: the business pays SAF's
 * UPI ID from any UPI app, then uploads the screenshot and the UPI reference
 * number (UTR). A Super Admin compares it with the bank statement and approves
 * (the invoice is settled) or rejects it (the business can try again).
 */

type Actor = { id: string };

/** UPI transaction reference (UTR / RRN): 12 digits on most apps; allow 6-35 letters/digits. */
export const UTR = /^[A-Za-z0-9]{6,35}$/;

/** `upi://pay` deep link per the NPCI UPI linking spec. Amount in paise. */
export function upiPayLink(p: { upiId: string; payeeName: string; amountPaise: number; note: string }): string {
  const q = new URLSearchParams({
    pa: p.upiId,
    pn: p.payeeName || "SAF Flow",
    am: (p.amountPaise / 100).toFixed(2),
    cu: "INR",
    tn: p.note.slice(0, 50),
  });
  return `upi://pay?${q.toString().replace(/\+/g, "%20")}`;
}

async function outstanding(db: Tx, invoiceId: string, exceptPaymentId?: string) {
  const inv = await db.invoice.findUnique({ where: { id: invoiceId }, include: { payments: { where: { status: "SUCCEEDED" } } } });
  if (!inv) throw notFound("Invoice");
  const paid = inv.payments.filter((p) => p.id !== exceptPaymentId).reduce((a, b) => a + b.amount, 0);
  return { invoice: inv as Invoice, due: inv.total - paid, paid };
}

/** Amount still due on an invoice, in paise. */
export async function invoiceDue(db: Tx, invoiceId: string) {
  return outstanding(db, invoiceId);
}

/** Business side: record an uploaded receipt as a PENDING UPI payment. */
export async function submitReceipt(db: Tx, p: { tenantId: string; invoiceId: string; receiptKey: string; utr: string; userId: string }) {
  const { invoice, due } = await outstanding(db, p.invoiceId);
  if (invoice.tenantId !== p.tenantId) throw notFound("Invoice");
  if (invoice.status !== "ISSUED") throw conflict("This invoice is not payable.");
  if (due < 100) throw conflict("Nothing left to pay on this invoice.");
  const waiting = await db.payment.findFirst({ where: { invoiceId: invoice.id, status: "PENDING", receiptKey: { not: null } }, select: { id: true } });
  if (waiting) throw conflict("A receipt for this invoice is already waiting for SAF to verify.");
  const used = await db.payment.findFirst({ where: { method: "UPI", reference: p.utr, receiptKey: { not: null }, status: { not: "FAILED" } }, select: { id: true } });
  if (used) throw conflict("This UPI reference number has already been submitted.");
  return db.payment.create({
    data: {
      tenantId: invoice.tenantId, invoiceId: invoice.id, subscriptionId: invoice.subscriptionId,
      amount: due, method: "UPI", status: "PENDING", reference: p.utr, receiptKey: p.receiptKey,
      notes: "Receipt uploaded by the business", recordedById: p.userId,
    },
  });
}

async function pendingReceipt(db: Tx, paymentId: string) {
  const pay = await db.payment.findUnique({ where: { id: paymentId } });
  if (!pay || !pay.receiptKey || !pay.invoiceId) throw notFound("Payment");
  if (pay.status !== "PENDING") throw conflict("This receipt has already been reviewed.");
  return pay;
}

/** Super Admin: money is in the bank. Settles the invoice (and renews the subscription). */
export async function approveReceipt(db: Tx, paymentId: string, actor: Actor, opts: { amount?: number; note?: string }) {
  const pay = await pendingReceipt(db, paymentId);
  const { invoice, due } = await outstanding(db, pay.invoiceId!, pay.id);
  if (invoice.status === "VOID") throw conflict("This invoice has been voided. Reject the receipt instead.");
  if (due <= 0) throw conflict("This invoice is already fully paid. Reject the receipt instead.");
  const amount = opts.amount ?? Math.min(pay.amount, due);
  if (amount < 1 || amount > due) throw badRequest(`Amount must be between ₹0.01 and ${formatINR(due)}.`);
  const now = new Date();
  // Compare-and-set: two admins clicking at once settle it only once.
  const won = await db.payment.updateMany({
    where: { id: pay.id, status: "PENDING" },
    data: { status: "SUCCEEDED", amount, paidAt: now, reviewedAt: now, reviewNote: opts.note ?? null, recordedById: actor.id },
  });
  if (won.count === 0) throw conflict("This receipt has already been reviewed.");
  if (amount >= due) await markInvoicePaid(db, invoice, actor);
  await notify(db, {
    tenantId: pay.tenantId, productCode: invoice.productCode, kind: "payment.approved",
    title: "Payment received",
    body: `${formatINR(amount)} for invoice ${invoice.invoiceNo} has been verified. Thank you!`,
    link: invoice.productCode ? `/${invoice.productCode}/subscription` : undefined,
  });
  return db.payment.findUniqueOrThrow({ where: { id: pay.id } });
}

/** Super Admin: payment not found / wrong amount. The business can upload again. */
export async function rejectReceipt(db: Tx, paymentId: string, reason: string) {
  const pay = await pendingReceipt(db, paymentId);
  const won = await db.payment.updateMany({
    where: { id: pay.id, status: "PENDING" },
    data: { status: "FAILED", reviewedAt: new Date(), reviewNote: reason },
  });
  if (won.count === 0) throw conflict("This receipt has already been reviewed.");
  const inv = await db.invoice.findUnique({ where: { id: pay.invoiceId! }, select: { invoiceNo: true, productCode: true } });
  await notify(db, {
    tenantId: pay.tenantId, productCode: inv?.productCode, kind: "payment.rejected",
    title: "Payment could not be verified",
    body: `Your receipt for invoice ${inv?.invoiceNo ?? ""} was not accepted: ${reason}`,
    link: inv?.productCode ? `/${inv.productCode}/subscription` : undefined,
  });
  return pay;
}
