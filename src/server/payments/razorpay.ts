import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../http/errors";

/**
 * Razorpay integration for tenants paying SAF renewal invoices online.
 * Enabled only when RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are configured;
 * otherwise the Super Admin records payments manually.
 */
export function isRazorpayConfigured(): boolean {
  return !!process.env.RAZORPAY_KEY_ID && !!process.env.RAZORPAY_KEY_SECRET;
}

export async function createRazorpayOrder(amountPaise: number, receipt: string, notes: Record<string, string>) {
  if (!isRazorpayConfigured()) throw new HttpError(503, "PAYMENTS_NOT_CONFIGURED", "Online payments are not configured.");
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
    body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt: receipt.slice(0, 40), notes }),
  });
  if (!res.ok) {
    console.error("[razorpay] order creation failed", res.status, await res.text().catch(() => ""));
    throw new HttpError(502, "PAYMENT_GATEWAY_ERROR", "Could not start the payment. Please try again.");
  }
  return (await res.json()) as { id: string; amount: number; currency: string };
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Checkout success signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyPaymentSignature(orderId: string, paymentId: string, signature: string, secret = process.env.RAZORPAY_KEY_SECRET || ""): boolean {
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  return safeEqualHex(expected, signature);
}

/** Webhook signature: HMAC_SHA256(raw body, webhook secret). */
export function verifyWebhookSignature(rawBody: string, signature: string, secret = process.env.RAZORPAY_WEBHOOK_SECRET || ""): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqualHex(expected, signature);
}
