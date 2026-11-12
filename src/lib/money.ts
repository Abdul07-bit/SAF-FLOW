/**
 * Money is always handled as integer paise; tax rates as basis points
 * (1800 = 18%). Shared by server and browser code.
 */

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

export function formatINR(paise: number | null | undefined, opts: { whole?: boolean } = {}): string {
  const v = (paise ?? 0) / 100;
  return opts.whole ? inr0.format(v) : inr.format(v);
}

export function rupeesToPaise(rupees: number | string): number {
  const n = typeof rupees === "string" ? Number(rupees) : rupees;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function paiseToRupees(paise: number): number {
  return Math.round(paise) / 100;
}

export function percentToBp(pct: number): number {
  return Math.round(pct * 100);
}

export function bpToPercent(bp: number): number {
  return bp / 100;
}

export function taxOn(amountPaise: number, rateBp: number): number {
  return Math.round((amountPaise * rateBp) / 10000);
}

export interface PricedLine {
  unitPrice: number;
  qty: number;
  taxRate: number;
  /** Line-level discount in paise. */
  discount?: number;
}

export interface Totals {
  subtotal: number;
  discount: number;
  taxTotal: number;
  total: number;
  lines: { net: number; tax: number; allocatedDiscount: number; lineTotal: number }[];
}

/**
 * Computes bill totals. Prices are tax-exclusive. A bill-level discount is
 * allocated across lines proportionally (before tax) so GST is charged on the
 * discounted value. Integer arithmetic only; rounding remainders go to the
 * last line so the totals always reconcile.
 */
export function computeTotals(lines: PricedLine[], billDiscount = 0): Totals {
  const nets = lines.map((l) => Math.max(0, Math.round(l.unitPrice * l.qty) - (l.discount ?? 0)));
  const subtotal = nets.reduce((a, b) => a + b, 0);
  const discount = Math.min(Math.max(0, Math.round(billDiscount)), subtotal);

  let allocatedSoFar = 0;
  const out = lines.map((l, i) => {
    let alloc = 0;
    if (discount > 0 && subtotal > 0) {
      alloc = i === lines.length - 1 ? discount - allocatedSoFar : Math.round((discount * nets[i]) / subtotal);
      allocatedSoFar += alloc;
    }
    const taxable = nets[i] - alloc;
    const tax = taxOn(taxable, l.taxRate);
    return { net: nets[i], tax, allocatedDiscount: alloc, lineTotal: taxable + tax };
  });

  const taxTotal = out.reduce((a, b) => a + b.tax, 0);
  return { subtotal, discount, taxTotal, total: subtotal - discount + taxTotal, lines: out };
}
