"use client";

import { Plus, X } from "lucide-react";
import { formatINR, rupeesToPaise } from "@/lib/money";
import { SPLIT_TENDERS, type TenderPart } from "@/shared/tender";
import { cx, Input, Select } from "@/components/ui";

/** One editable row: amount is what the cashier typed, in rupees. */
export interface SplitRow {
  method: string;
  amount: string;
}

const label = (m: string) => (m === "UPI" ? "UPI" : m.charAt(0) + m.slice(1).toLowerCase());

export const newSplit = (): SplitRow[] => [{ method: "UPI", amount: "" }, { method: "CASH", amount: "" }];

/** Rows -> wire parts in paise (empty rows dropped). */
export function splitParts(rows: SplitRow[]): TenderPart[] {
  return rows.map((r) => ({ method: r.method, amount: rupeesToPaise(r.amount || 0) })).filter((p) => p.amount > 0);
}

/** Ready to submit: at least two parts, two different methods, adding up to the total exactly. */
export function splitReady(rows: SplitRow[], total: number): boolean {
  const parts = splitParts(rows);
  return parts.length >= 2 && new Set(parts.map((p) => p.method)).size >= 2 && parts.reduce((a, p) => a + p.amount, 0) === total;
}

/**
 * Split payment editor: e.g. Rs 700 bill -> UPI 400 + Cash 300.
 * With two rows, typing one amount fills the other with the balance.
 */
export function SplitPaymentEditor({ total, rows, onChange }: { total: number; rows: SplitRow[]; onChange: (rows: SplitRow[]) => void }) {
  const paid = splitParts(rows).reduce((a, p) => a + p.amount, 0);
  const remaining = total - paid;

  const setAmount = (i: number, amount: string) => {
    const next = rows.map((r, j) => (j === i ? { ...r, amount } : r));
    if (rows.length === 2) {
      const other = 1 - i;
      const rest = total - rupeesToPaise(amount || 0);
      next[other] = { ...next[other], amount: rest > 0 ? String(rest / 100) : "" };
    }
    onChange(next);
  };
  const setMethod = (i: number, method: string) => onChange(rows.map((r, j) => (j === i ? { ...r, method } : r)));
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  const add = () => {
    const unused = SPLIT_TENDERS.find((m) => !rows.some((r) => r.method === m)) ?? "OTHER";
    onChange([...rows, { method: unused, amount: remaining > 0 ? String(remaining / 100) : "" }]);
  };

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-2.5">
      <p className="text-[13px] font-medium text-slate-700">Split payment - amount paid by each method</p>
      {rows.map((r, i) => (
        <div key={i} className={cx("grid items-center gap-2", rows.length > 2 ? "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" : "grid-cols-2")}>
          <Select aria-label={`Method ${i + 1}`} value={r.method} onChange={(e) => setMethod(i, e.target.value)}>
            {SPLIT_TENDERS.map((m) => <option key={m} value={m}>{label(m)}</option>)}
          </Select>
          <Input aria-label={`${label(r.method)} amount (Rs)`} type="number" min="0" step="0.01" inputMode="decimal" placeholder="Rs" value={r.amount} onChange={(e) => setAmount(i, e.target.value)} />
          {rows.length > 2 && (
            <button type="button" aria-label="Remove this part" onClick={() => remove(i)} className="rounded p-1 text-slate-500 hover:bg-slate-100"><X className="h-4 w-4" /></button>
          )}
        </div>
      ))}
      <div className="flex items-center justify-between text-sm">
        {rows.length < 4
          ? <button type="button" onClick={add} className="inline-flex items-center gap-1 font-medium text-brand"><Plus className="h-3.5 w-3.5" /> Add method</button>
          : <span />}
        <span className={cx("tnum font-semibold", total <= 0 ? "text-slate-500" : remaining === 0 ? "text-emerald-700" : "text-red-700")}>
          {total <= 0 ? "Add items first" : remaining === 0 ? "Matches total" : remaining > 0 ? `Remaining ${formatINR(remaining)}` : `Over by ${formatINR(-remaining)}`}
        </span>
      </div>
    </div>
  );
}
