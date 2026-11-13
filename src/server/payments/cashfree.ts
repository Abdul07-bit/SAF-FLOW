import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "../http/errors";

/**
 * Cashfree Payments (PG) integration for businesses paying SAF invoices online.
 * Enabled only when CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET are set;
 * otherwise SAF records payments manually.
 *
 * Flow: the server creates an order and hands the browser a payment_session_id
 * for the Cashfree JS checkout. The browser result is never trusted: a payment
 * is settled only after the server reads the order back from Cashfree (PAID)
 * or receives a signed webhook.
 */
export const CASHFREE_API_VERSION = process.env.CASHFREE_API_VERSION || "2025-01-01";

export type CashfreeMode = "sandbox" | "production";

export function cashfreeMode(): CashfreeMode {
  return process.env.CASHFREE_ENV === "production" ? "production" : "sandbox";
}

export function isCashfreeConfigured(): boolean {
  return !!process.env.CASHFREE_CLIENT_ID && !!process.env.CASHFREE_CLIENT_SECRET;
}

function baseUrl() {
  return cashfreeMode() === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
}

async function call(path: string, init: { method: "GET" | "POST"; body?: unknown; idempotencyKey?: string }) {
  if (!isCashfreeConfigured()) throw new HttpError(503, "PAYMENTS_NOT_CONFIGURED", "Online payments are not configured.");
  const res = await fetch(`${baseUrl()}${path}`, {
    method: init.method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-api-version": CASHFREE_API_VERSION,
      "x-client-id": process.env.CASHFREE_CLIENT_ID!,
      "x-client-secret": process.env.CASHFREE_CLIENT_SECRET!,
      ...(init.idempotencyKey ? { "x-idempotency-key": init.idempotencyKey } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  }).catch((e) => {
    console.error("[cashfree] request failed", path, e);
    throw new HttpError(502, "PAYMENT_GATEWAY_ERROR", "Could not reach the payment gateway. Please try again.");
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    console.error("[cashfree] error", res.status, path, body);
    throw new HttpError(502, "PAYMENT_GATEWAY_ERROR", "The payment gateway could not process this request. Please try again.");
  }
  return body;
}

/** Cashfree order ids: 3-45 chars of letters, digits, "_" and "-". Unique per attempt. */
export function newOrderId(invoiceNo: string): string {
  const base = invoiceNo.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 28);
  return `${base}-${randomBytes(6).toString("hex")}`;
}

/** Cashfree wants a 10-digit phone; Indian numbers may arrive as +91..., 0..., with spaces. */
export function cashfreePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

export async function createCashfreeOrder(input: {
  orderId: string;
  amountPaise: number;
  customer: { id: string; phone: string; name?: string; email?: string | null };
  returnUrl: string;
  notifyUrl?: string;
  note?: string;
}): Promise<{ orderId: string; cfOrderId: string; paymentSessionId: string }> {
  const r = await call("/orders", {
    method: "POST",
    idempotencyKey: input.orderId,
    body: {
      order_id: input.orderId,
      order_amount: input.amountPaise / 100,
      order_currency: "INR",
      customer_details: {
        // 3-50 alphanumeric characters.
        customer_id: input.customer.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 50).padEnd(3, "0"),
        customer_phone: input.customer.phone,
        ...(input.customer.name && input.customer.name.length >= 3 ? { customer_name: input.customer.name.slice(0, 100) } : {}),
        ...(input.customer.email ? { customer_email: input.customer.email.slice(0, 100) } : {}),
      },
      order_meta: { return_url: input.returnUrl, ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}) },
      ...(input.note ? { order_note: input.note.slice(0, 200) } : {}),
    },
  });
  if (!r?.payment_session_id) throw new HttpError(502, "PAYMENT_GATEWAY_ERROR", "The payment gateway did not start a session.");
  return { orderId: String(r.order_id), cfOrderId: String(r.cf_order_id ?? ""), paymentSessionId: String(r.payment_session_id) };
}

/**
 * Reads the order back from Cashfree. Returns the successful payment when the
 * order is PAID, otherwise the order status ("ACTIVE", "EXPIRED", ...).
 */
export async function fetchCashfreePayment(orderId: string): Promise<
  { status: "PAID"; cfPaymentId: string; amountPaise: number } | { status: string }
> {
  const order = await call(`/orders/${encodeURIComponent(orderId)}`, { method: "GET" });
  const status = String(order?.order_status ?? "UNKNOWN");
  if (status !== "PAID") return { status };
  const payments = await call(`/orders/${encodeURIComponent(orderId)}/payments`, { method: "GET" });
  const ok = (Array.isArray(payments) ? payments : []).find((p: any) => p?.payment_status === "SUCCESS");
  if (!ok) return { status: "PENDING" };
  return { status: "PAID", cfPaymentId: String(ok.cf_payment_id), amountPaise: Math.round(Number(ok.payment_amount) * 100) };
}

/**
 * Webhook signature: base64(HMAC_SHA256(x-webhook-timestamp + raw body, client secret)).
 * Must be computed over the raw bytes; re-serialised JSON changes "170.00" to 170.
 */
export function verifyCashfreeWebhook(rawBody: string, timestamp: string, signature: string, secret = process.env.CASHFREE_CLIENT_SECRET || ""): boolean {
  if (!secret || !signature || !timestamp) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(timestamp + rawBody).digest("base64"), "utf8");
  const given = Buffer.from(signature, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
