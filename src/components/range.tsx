"use client";

import { useState } from "react";
import { Plus, Printer, Trash2 } from "lucide-react";
import { addDays, startOfMonth, todayIST } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { Button, Input, Select } from "./ui";

export interface Range {
  from: string;
  to: string;
}

const PRESETS: Record<string, { label: string; get: () => Range }> = {
  today: { label: "Today", get: () => ({ from: todayIST(), to: todayIST() }) },
  yesterday: { label: "Yesterday", get: () => ({ from: addDays(todayIST(), -1), to: addDays(todayIST(), -1) }) },
  "7d": { label: "Last 7 days", get: () => ({ from: addDays(todayIST(), -6), to: todayIST() }) },
  "30d": { label: "Last 30 days", get: () => ({ from: addDays(todayIST(), -29), to: todayIST() }) },
  month: { label: "This month", get: () => ({ from: startOfMonth(todayIST()), to: todayIST() }) },
};

export function useRange(initial: keyof typeof PRESETS = "7d") {
  const [preset, setPreset] = useState<string>(initial);
  const [range, setRange] = useState<Range>(PRESETS[initial].get());
  return { preset, setPreset, range, setRange, query: `from=${range.from}&to=${range.to}` };
}

/** One filter row above everything it scopes. */
export function RangePicker({ state, print }: { state: ReturnType<typeof useRange>; print?: boolean }) {
  const { preset, setPreset, range, setRange } = state;
  return (
    <div className="no-print mb-4 flex flex-wrap items-center gap-2">
      <Select aria-label="Period" className="w-40" value={preset} onChange={(e) => { setPreset(e.target.value); if (PRESETS[e.target.value]) setRange(PRESETS[e.target.value].get()); }}>
        {Object.entries(PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        <option value="custom">Custom range</option>
      </Select>
      <Input aria-label="From date" type="date" className="w-40" value={range.from} max={range.to} onChange={(e) => { if (e.target.value) { setPreset("custom"); setRange({ ...range, from: e.target.value }); } }} />
      <span className="text-sm text-slate-500">to</span>
      <Input aria-label="To date" type="date" className="w-40" value={range.to} min={range.from} max={todayIST()} onChange={(e) => { if (e.target.value) { setPreset("custom"); setRange({ ...range, to: e.target.value }); } }} />
      {print && <Button onClick={() => window.print()}><Printer className="h-4 w-4" /> Print</Button>}
    </div>
  );
}

export interface Line {
  itemId: string;
  quantity: string;
  unitCost: string;
}

/** Purchase line editor: item, quantity, unit cost (rupees). */
export function LineItemsEditor({ lines, onChange, options, itemLabel = "Item" }: { lines: Line[]; onChange: (l: Line[]) => void; options: { id: string; label: string }[]; itemLabel?: string }) {
  const set = (i: number, patch: Partial<Line>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((a, l) => a + Number(l.quantity || 0) * Number(l.unitCost || 0), 0);
  return (
    <div>
      <div className="space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_2rem] items-center gap-2">
            <Select aria-label={`${itemLabel} ${i + 1}`} required value={l.itemId} onChange={(e) => set(i, { itemId: e.target.value })}>
              <option value="">Select {itemLabel.toLowerCase()}...</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </Select>
            <Input aria-label="Quantity" required type="number" min="0.001" step="any" placeholder="Qty" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} />
            <Input aria-label="Unit cost in rupees" required type="number" min="0" step="0.01" placeholder="Cost Rs" value={l.unitCost} onChange={(e) => set(i, { unitCost: e.target.value })} />
            <button type="button" aria-label="Remove line" disabled={lines.length === 1} onClick={() => onChange(lines.filter((_, j) => j !== i))} className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <Button size="sm" onClick={() => onChange([...lines, { itemId: "", quantity: "", unitCost: "" }])}><Plus className="h-3.5 w-3.5" /> Add line</Button>
        <span className="text-sm text-slate-700">Total <strong className="tnum">{formatINR(Math.round(total * 100))}</strong></span>
      </div>
    </div>
  );
}

export const emptyLine = (): Line => ({ itemId: "", quantity: "", unitCost: "" });
export const linesToWire = (lines: Line[], key: string) => lines.map((l) => ({ [key]: l.itemId, quantity: Number(l.quantity), unitCost: Math.round(Number(l.unitCost) * 100) }));
