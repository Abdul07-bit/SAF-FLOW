"use client";

import { useEffect, useState } from "react";
import { formatINR } from "@/lib/money";
import { qs, useApi } from "@/lib/client";

function useDebouncedValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export interface ShopUpiInfo { upiId: string | null; payeeName: string; amount: number; link: string | null; qr: string; amountInQr: boolean }

/** The QR image + payee details. Used on cashier screens and on printed bills. */
export function UpiQrBlock({ upi, compact = false }: { upi: ShopUpiInfo; compact?: boolean }) {
  return (
    <div className="flex flex-col items-center text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={upi.qr} alt={`UPI QR code to pay ${formatINR(upi.amount)} to ${upi.payeeName}`} className={`${compact ? "h-36 w-36" : "h-52 w-52"} rounded-lg border border-slate-200 bg-white object-contain p-1.5`} />
      <p className="mt-2 text-sm font-semibold text-slate-900">Scan to pay {formatINR(upi.amount)}</p>
      <p className="text-xs text-slate-600">{upi.payeeName}{upi.upiId && <> · <span className="font-mono">{upi.upiId}</span></>}</p>
      {!upi.amountInQr && <p className="mt-0.5 text-xs font-medium text-amber-800">Enter {formatINR(upi.amount)} in your UPI app</p>}
    </div>
  );
}

/**
 * Cashier screen: the business's UPI QR for the bill amount, for the customer
 * to scan at the counter. The cashier confirms the money in their own UPI app
 * before settling the bill as UPI.
 */
export function ShopUpiQr({ base, amount, note }: { base: string; amount: number; note?: string }) {
  const amt = useDebouncedValue(amount, 400);
  const r = useApi<{ upi: ShopUpiInfo | null }>(amt >= 100 ? `${base}/payments/upi${qs({ amount: amt, note })}` : null);
  if (amt < 100) return null;
  if (r.loading && !r.data) return <div className="h-52 animate-pulse rounded-lg bg-slate-100" aria-label="Loading UPI QR" />;
  if (!r.data?.upi) return <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">Add your shop&apos;s UPI ID or QR in Settings to show a payment QR here.</p>;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <UpiQrBlock upi={r.data.upi} />
      <p className="mt-2 text-center text-xs text-slate-500">Check the payment in your UPI app before settling.</p>
    </div>
  );
}
