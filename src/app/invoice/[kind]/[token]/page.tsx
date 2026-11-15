"use client";

/**
 * Public printable invoice for all three products. The link carries an
 * unguessable token; the API returns only what belongs on the bill.
 */
import { useParams } from "next/navigation";
import { Printer } from "lucide-react";
import { PRODUCTS, isProductCode } from "@/config/catalog";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { useApi } from "@/lib/client";
import { humanize } from "@/shared/fields";
import { themeVars } from "@/components/shell";
import { Badge, Button, Spinner } from "@/components/ui";
import { UpiQrBlock, type ShopUpiInfo } from "@/components/shop-upi";

interface InvoiceData {
  kind: "dine" | "stay" | "bill";
  status?: string;
  /** Settled in full. Unpaid bills carry the business's UPI QR in `pay`. */
  isPaid?: boolean;
  pay?: ShopUpiInfo | null;
  seller: { name: string; address: string; phone: string | null; gstin: string | null; logoUrl: string | null };
  invoiceNo: string | null;
  date: string | null;
  customer: { name: string | null; phone: string | null; address?: string | null; gstin?: string | null; company?: string | null };
  meta: string[];
  lines: { name: string; qty: number; rate: number; taxRate: number; amount: number; discount?: number }[];
  subtotal: number; discount: number; tax: number; total: number;
  amountPaid?: number; changeDue?: number;
  payments?: { method: string; amount: number; date: string }[]; paid?: number; balance?: number;
  footer: string | null;
}

function Message({ title, text }: { title: string; text: string }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
      <p className="mt-1 text-sm text-slate-600">{text}</p>
    </main>
  );
}

export default function PublicInvoicePage() {
  const { kind, token } = useParams<{ kind: string; token: string }>();
  const valid = isProductCode(kind);
  const inv = useApi<InvoiceData>(valid ? `/public/invoice/${kind}/${token}` : null);

  if (!valid) return <Message title="Invoice not found" text="This link is not valid." />;
  if (inv.error && !inv.data) return <Message title="Invoice not available" text={inv.error.status === 404 ? "This invoice does not exist, or the bill has not been settled yet." : inv.error.message} />;
  if (!inv.data) return <Spinner label="Loading invoice" />;
  const d = inv.data;
  const hasLineDiscount = d.lines.some((l) => l.discount);
  const qty = (n: number) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 });
  // Restaurant bills can be printed / shared before payment: no invoice number yet.
  const unpaidBill = d.isPaid === false && !d.invoiceNo;

  return (
    <div style={themeVars(PRODUCTS[d.kind].theme)} className="mx-auto max-w-2xl px-3 py-6 print:max-w-none print:p-0">
      <div className="no-print mb-3 flex justify-end"><Button onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / save as PDF</Button></div>
      <article className="print-card relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
        <header className="-mx-5 -mt-5 rounded-t-2xl bg-brand px-5 py-5 text-white sm:-mx-8 sm:-mt-8 sm:px-8 print:rounded-none" style={{ printColorAdjust: "exact", WebkitPrintColorAdjust: "exact" }}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {d.seller.logoUrl && <img src={d.seller.logoUrl} alt="" className="h-16 w-16 rounded-xl bg-white object-contain p-1.5 shadow-sm" />}
              <div>
                <h1 className="text-xl font-semibold leading-tight">{d.seller.name}</h1>
                {d.seller.address && <p className="max-w-xs text-sm text-white/85">{d.seller.address}</p>}
                <p className="text-sm text-white/85">{[d.seller.phone && `Phone: ${d.seller.phone}`, d.seller.gstin && `GSTIN: ${d.seller.gstin}`].filter(Boolean).join(" · ")}</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs font-semibold uppercase tracking-wider text-white/80">{unpaidBill ? "Bill" : d.seller.gstin ? "Tax invoice" : "Invoice"}</p>
              {d.invoiceNo && <p className="font-mono text-base font-semibold">{d.invoiceNo}</p>}
              <p className="text-sm text-white/85">{fmtDateTime(d.date)}</p>
            </div>
          </div>
        </header>
        {d.status === "VOID" && <div className="mt-3"><Badge tone="bad">Void</Badge></div>}

        <div className="grid gap-4 py-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Billed to</p>
            <p className="font-medium text-slate-900">{d.customer.name || "Walk-in customer"}</p>
            {d.customer.company && <p className="text-slate-600">{d.customer.company}</p>}
            {d.customer.phone && <p className="text-slate-600">{d.customer.phone}</p>}
            {d.customer.address && <p className="text-slate-600">{d.customer.address}</p>}
            {d.customer.gstin && <p className="text-slate-600">GSTIN: {d.customer.gstin}</p>}
          </div>
          <ul className="text-slate-600 sm:text-right">{d.meta.map((m) => <li key={m}>{m}</li>)}</ul>
        </div>

        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-y border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <th scope="col" className="py-2 font-medium">Item</th>
              <th scope="col" className="py-2 text-right font-medium">Qty</th>
              <th scope="col" className="py-2 text-right font-medium">Rate</th>
              <th scope="col" className="py-2 text-right font-medium">GST</th>
              <th scope="col" className="py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {d.lines.map((l, i) => (
              <tr key={i}>
                <td className="py-2 pr-2 text-slate-900">{l.name}{hasLineDiscount && !!l.discount && <span className="block text-xs text-slate-500">Discount {formatINR(l.discount)}</span>}</td>
                <td className="tnum py-2 text-right">{qty(l.qty)}</td>
                <td className="tnum py-2 text-right">{formatINR(l.rate)}</td>
                <td className="tnum py-2 text-right">{l.taxRate ? `${l.taxRate / 100}%` : "-"}</td>
                <td className="tnum py-2 text-right">{formatINR(l.amount - (l.discount ?? 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex-1">
          {d.isPaid && d.status !== "VOID" && (
            <div role="img" aria-label="Paid" className="ml-2 inline-block rotate-[-10deg] rounded-lg border-4 border-emerald-600 px-4 py-1 text-3xl font-black uppercase tracking-widest text-emerald-600 opacity-85" style={{ printColorAdjust: "exact", WebkitPrintColorAdjust: "exact" }}>
              Paid
            </div>
          )}
        </div>
        <dl className="w-full max-w-xs space-y-1 border-t border-slate-200 pt-3 text-sm">
          <div className="flex justify-between"><dt className="text-slate-600">Subtotal</dt><dd className="tnum">{formatINR(d.subtotal)}</dd></div>
          {d.discount > 0 && <div className="flex justify-between"><dt className="text-slate-600">Discount</dt><dd className="tnum">- {formatINR(d.discount)}</dd></div>}
          <div className="flex justify-between"><dt className="text-slate-600">GST</dt><dd className="tnum">{formatINR(d.tax)}</dd></div>
          <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-semibold text-slate-900"><dt>Total</dt><dd className="tnum">{formatINR(d.total)}</dd></div>
          {d.amountPaid !== undefined && d.amountPaid > 0 && <div className="flex justify-between"><dt className="text-slate-600">Received</dt><dd className="tnum">{formatINR(d.amountPaid)}</dd></div>}
          {!!d.changeDue && <div className="flex justify-between"><dt className="text-slate-600">Change returned</dt><dd className="tnum">{formatINR(d.changeDue)}</dd></div>}
          {d.paid !== undefined && <div className="flex justify-between"><dt className="text-slate-600">Paid</dt><dd className="tnum">{formatINR(d.paid)}</dd></div>}
          {d.balance !== undefined && d.balance !== 0 && <div className="flex justify-between font-semibold"><dt>{d.balance > 0 ? "Balance due" : "Refund due"}</dt><dd className="tnum">{formatINR(Math.abs(d.balance))}</dd></div>}
        </dl>
        </div>

        {!!d.payments?.length && (
          <div className="mt-4 border-t border-slate-200 pt-3 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Payments</p>
            <ul className="mt-1 space-y-0.5 text-slate-700">{d.payments.map((p, i) => <li key={i}>{fmtDate(p.date)} - {formatINR(p.amount)} by {humanize(p.method)}</li>)}</ul>
          </div>
        )}

        {d.pay && (
          <section className="mt-6 flex flex-col items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center" aria-label="Pay by UPI">
            <UpiQrBlock upi={d.pay} compact />
            <div className="text-center text-sm text-slate-700 sm:text-left">
              <p className="text-base font-semibold text-slate-900">Pay {formatINR(d.pay.amount)} by UPI</p>
              <p>Scan with Google Pay, PhonePe, Paytm or any UPI app.</p>
              <p className="mt-1">Show the payment to the cashier; your paid bill is sent once it is confirmed.</p>
              {d.pay.link && <a href={d.pay.link} className="no-print mt-2 inline-block font-medium text-brand underline sm:hidden">Open UPI app</a>}
            </div>
          </section>
        )}

        <p className="mt-6 text-center text-base font-semibold text-slate-900">{d.footer || (d.isPaid ? "Thank you for your payment!" : "Thank you!")}</p>
        <p className="mt-2 text-center text-[11px] text-slate-400">Generated by {PRODUCTS[d.kind].name}</p>
      </article>
    </div>
  );
}
