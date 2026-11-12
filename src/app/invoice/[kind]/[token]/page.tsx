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

interface InvoiceData {
  kind: "dine" | "stay" | "bill";
  status?: string;
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

  return (
    <div style={themeVars(PRODUCTS[d.kind].theme)} className="mx-auto max-w-2xl px-3 py-6 print:max-w-none print:p-0">
      <div className="no-print mb-3 flex justify-end"><Button onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / save as PDF</Button></div>
      <article className="print-card rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
          <div className="flex items-start gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {d.seller.logoUrl && <img src={d.seller.logoUrl} alt="" className="h-14 w-14 rounded-lg object-contain" />}
            <div>
              <h1 className="text-lg font-semibold text-slate-900">{d.seller.name}</h1>
              {d.seller.address && <p className="max-w-xs text-sm text-slate-600">{d.seller.address}</p>}
              {d.seller.phone && <p className="text-sm text-slate-600">Phone: {d.seller.phone}</p>}
              {d.seller.gstin && <p className="text-sm text-slate-600">GSTIN: {d.seller.gstin}</p>}
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{d.seller.gstin ? "Tax invoice" : "Invoice"}</p>
            <p className="font-mono text-base font-semibold text-slate-900">{d.invoiceNo ?? "-"}</p>
            <p className="text-sm text-slate-600">{fmtDateTime(d.date)}</p>
            {d.status === "VOID" && <div className="mt-1"><Badge tone="bad">Void</Badge></div>}
          </div>
        </header>

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

        <dl className="ml-auto mt-4 w-full max-w-xs space-y-1 border-t border-slate-200 pt-3 text-sm">
          <div className="flex justify-between"><dt className="text-slate-600">Subtotal</dt><dd className="tnum">{formatINR(d.subtotal)}</dd></div>
          {d.discount > 0 && <div className="flex justify-between"><dt className="text-slate-600">Discount</dt><dd className="tnum">- {formatINR(d.discount)}</dd></div>}
          <div className="flex justify-between"><dt className="text-slate-600">GST</dt><dd className="tnum">{formatINR(d.tax)}</dd></div>
          <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-semibold text-slate-900"><dt>Total</dt><dd className="tnum">{formatINR(d.total)}</dd></div>
          {d.amountPaid !== undefined && d.amountPaid > 0 && <div className="flex justify-between"><dt className="text-slate-600">Received</dt><dd className="tnum">{formatINR(d.amountPaid)}</dd></div>}
          {!!d.changeDue && <div className="flex justify-between"><dt className="text-slate-600">Change returned</dt><dd className="tnum">{formatINR(d.changeDue)}</dd></div>}
          {d.paid !== undefined && <div className="flex justify-between"><dt className="text-slate-600">Paid</dt><dd className="tnum">{formatINR(d.paid)}</dd></div>}
          {d.balance !== undefined && d.balance !== 0 && <div className="flex justify-between font-semibold"><dt>{d.balance > 0 ? "Balance due" : "Refund due"}</dt><dd className="tnum">{formatINR(Math.abs(d.balance))}</dd></div>}
        </dl>

        {!!d.payments?.length && (
          <div className="mt-4 border-t border-slate-200 pt-3 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Payments</p>
            <ul className="mt-1 space-y-0.5 text-slate-700">{d.payments.map((p, i) => <li key={i}>{fmtDate(p.date)} - {formatINR(p.amount)} by {humanize(p.method)}</li>)}</ul>
          </div>
        )}

        {d.footer && <p className="mt-6 border-t border-slate-200 pt-3 text-center text-sm text-slate-600">{d.footer}</p>}
        <p className="mt-2 text-center text-[11px] text-slate-400">Generated by {PRODUCTS[d.kind].name}</p>
      </article>
    </div>
  );
}
