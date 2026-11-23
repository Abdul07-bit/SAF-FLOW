/**
 * Split payments: one bill paid with more than one tender, e.g. a Rs 700 bill
 * paid Rs 400 by UPI and Rs 300 in cash. The sale/order stores
 * paymentMethod = "SPLIT" plus the parts in `payment_split`; every report
 * and cash-drawer total uses tenderParts() so each rupee lands under the
 * tender it was actually paid with (never under a vague "Split" bucket).
 *
 * Shared by the server routes and the client screens - keep it dependency-free.
 */
import { z } from "zod";
import { formatINR } from "@/lib/money";

/** Tenders allowed inside a split. Credit is excluded: a split bill is fully paid. */
export const SPLIT_TENDERS = ["CASH", "UPI", "CARD", "WALLET", "OTHER"] as const;
export type SplitTender = (typeof SPLIT_TENDERS)[number];

export interface TenderPart {
  method: string;
  amount: number; // paise
}

export const splitPartsSchema = z
  .array(z.object({ method: z.enum(SPLIT_TENDERS), amount: z.number().int().min(1) }))
  .min(2, "A split payment needs at least two parts.")
  .max(4);

/** Merges parts of the same tender (two UPI entries become one) and drops empty ones. */
export function normalizeSplit(parts: TenderPart[]): TenderPart[] {
  const merged = new Map<string, number>();
  for (const p of parts) if (p.amount > 0) merged.set(p.method, (merged.get(p.method) ?? 0) + p.amount);
  return [...merged].map(([method, amount]) => ({ method, amount }));
}

/** Throws (with a message fit for the cashier) unless the parts add up to the bill total exactly. */
export function assertSplitMatches(parts: TenderPart[], total: number): TenderPart[] {
  const clean = normalizeSplit(parts);
  if (clean.length < 2) throw new Error("A split payment needs at least two different payment methods.");
  const sum = clean.reduce((a, p) => a + p.amount, 0);
  if (sum !== total)
    throw new Error(`Split parts add up to ${formatINR(sum)} but the bill total is ${formatINR(total)}.`);
  return clean;
}

/** How a settled bill was actually paid, as tender parts. Works for split and single-tender rows. */
export function tenderParts(row: { paymentMethod: string | null; paymentSplit?: unknown; total: number }): TenderPart[] {
  if (row.paymentMethod === "SPLIT" && Array.isArray(row.paymentSplit)) {
    const parts = (row.paymentSplit as TenderPart[]).filter((p) => p && typeof p.method === "string" && Number.isFinite(p.amount));
    if (parts.length) return parts;
  }
  return [{ method: row.paymentMethod ?? "OTHER", amount: row.total }];
}

/** Adds a bill's tender parts into a { method: amount } total. */
export function addTenders(into: Record<string, number>, row: { paymentMethod: string | null; paymentSplit?: unknown; total: number }) {
  for (const p of tenderParts(row)) into[p.method] = (into[p.method] ?? 0) + p.amount;
  return into;
}

/** Cash portion of a bill (full total for cash bills, the cash part of a split, else 0). */
export function cashPart(row: { paymentMethod: string | null; paymentSplit?: unknown; total: number }): number {
  return tenderParts(row).filter((p) => p.method === "CASH").reduce((a, p) => a + p.amount, 0);
}

const label = (m: string) => (m === "UPI" ? "UPI" : m.charAt(0) + m.slice(1).toLowerCase());

/** "Cash", or "Split: UPI Rs 400.00 + Cash Rs 300.00". */
export function describePayment(row: { paymentMethod: string | null; paymentSplit?: unknown; total: number }): string {
  if (!row.paymentMethod) return "-";
  if (row.paymentMethod !== "SPLIT") return label(row.paymentMethod);
  return `Split: ${tenderParts(row).map((p) => `${label(p.method)} ${formatINR(p.amount)}`).join(" + ")}`;
}
