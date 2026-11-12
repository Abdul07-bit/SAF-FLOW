"use client";

import { Check, Minus } from "lucide-react";
import { formatINR } from "@/lib/money";
import { Badge, cx } from "./ui";

export interface PlanInfo {
  id: string;
  tier: "BASIC" | "GROWTH";
  name: string;
  description: string | null;
  monthlyPrice: number;
  annualPrice: number;
  setupFee: number;
  graceDays: number;
}
export interface FeatureRow {
  key: string;
  name: string;
  group: string;
  tiers: Record<string, boolean>;
}

/** Plan cards + feature matrix. Prices always come from the API (configured by SAF). */
export function PlanCompare({ plans, features, currentTier, gstRateBp }: { plans: PlanInfo[]; features: FeatureRow[]; currentTier?: string | null; gstRateBp?: number }) {
  const groups = [...new Set(features.map((f) => f.group))];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {plans.map((p) => (
          <div key={p.id} className={cx("rounded-xl border bg-white p-4", p.tier === currentTier ? "border-brand ring-1 ring-brand" : "border-slate-200")}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-slate-900">{p.name}</h3>
              {p.tier === currentTier && <Badge tone="brand">Current plan</Badge>}
            </div>
            {p.description && <p className="mt-1 text-sm text-slate-600">{p.description}</p>}
            <p className="mt-3 text-2xl font-semibold text-slate-900">
              {formatINR(p.monthlyPrice, { whole: true })}
              <span className="text-sm font-normal text-slate-500"> / month maintenance</span>
            </p>
            <ul className="mt-2 space-y-1 text-sm text-slate-700">
              <li>Annual advance: <strong>{formatINR(p.annualPrice, { whole: true })}</strong></li>
              <li>One-time setup: <strong>{formatINR(p.setupFee, { whole: true })}</strong></li>
              <li className="text-xs text-slate-500">{p.graceDays}-day grace period after expiry{gstRateBp ? ` - prices exclude ${gstRateBp / 100}% GST` : ""}</li>
            </ul>
          </div>
        ))}
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <th scope="col" className="px-3 py-2 font-medium">Feature</th>
              {plans.map((p) => <th key={p.id} scope="col" className="w-24 px-3 py-2 text-center font-medium">{p.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <FeatureGroup key={g} group={g} rows={features.filter((f) => f.group === g)} plans={plans} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FeatureGroup({ group, rows, plans }: { group: string; rows: FeatureRow[]; plans: PlanInfo[] }) {
  return (
    <>
      <tr className="bg-slate-50/60">
        <th scope="colgroup" colSpan={plans.length + 1} className="px-3 py-1.5 text-left text-xs font-semibold text-slate-600">{group}</th>
      </tr>
      {rows.map((f) => (
        <tr key={f.key} className="border-t border-slate-100">
          <td className="px-3 py-1.5 text-slate-800">{f.name}</td>
          {plans.map((p) => (
            <td key={p.id} className="px-3 py-1.5 text-center">
              {f.tiers[p.tier] ? (
                <><Check className="mx-auto h-4 w-4 text-emerald-700" aria-hidden /><span className="sr-only">Included</span></>
              ) : (
                <><Minus className="mx-auto h-4 w-4 text-slate-300" aria-hidden /><span className="sr-only">Not included</span></>
              )}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
