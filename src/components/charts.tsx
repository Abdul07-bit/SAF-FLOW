"use client";

/**
 * Chart kit. Conventions (see docs/ARCHITECTURE.md > Charts):
 *  - a headline number is a stat tile, not a chart
 *  - magnitude = one hue; parts of a whole = ranked bars in one hue
 *  - at most three categorical series (validated order --viz-1..3)
 *  - text is always ink, never the series colour
 *  - every chart has a table view and a hover / keyboard-focus readout
 */
import { useState, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, BarChart3, Table2 } from "lucide-react";
import { Card, cx } from "./ui";

const compact = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });
const compactInr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", notation: "compact", maximumFractionDigits: 1 });

export const fmtCompact = (n: number) => compact.format(n);
/** Paise -> compact rupees for axes and tiles (Rs 1.2L, Rs 12.9K). */
export const fmtCompactINR = (paise: number) => compactInr.format(paise / 100);

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * pow) return m * pow;
  return 10 * pow;
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

export function StatTile({ label, value, sub, delta, tone }: {
  label: string; value: ReactNode; sub?: ReactNode;
  /** Signed % change vs the previous period; null hides it. */
  delta?: { pct: number | null; goodWhenUp?: boolean; vs?: string };
  tone?: "warn" | "bad";
}) {
  const up = (delta?.pct ?? 0) >= 0;
  const good = delta?.goodWhenUp === false ? !up : up;
  return (
    <div className={cx("rounded-xl border bg-white p-4 shadow-sm", tone === "bad" ? "border-red-200" : tone === "warn" ? "border-amber-300" : "border-slate-200")}>
      <p className="text-[13px] text-slate-600">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{value}</p>
      {delta && delta.pct !== null && (
        <p className={cx("mt-1 flex items-center gap-1 text-xs font-medium", good ? "text-emerald-800" : "text-red-700")}>
          {up ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden /> : <ArrowDownRight className="h-3.5 w-3.5" aria-hidden />}
          {up ? "+" : ""}{delta.pct}% <span className="font-normal text-slate-500">{delta.vs ?? "vs previous period"}</span>
        </p>
      )}
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

export function KpiRow({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 | 5 | 6 }) {
  const grid = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4", 5: "sm:grid-cols-3 lg:grid-cols-5", 6: "sm:grid-cols-3 lg:grid-cols-6" }[cols];
  return <div className={cx("mb-4 grid grid-cols-2 gap-3", grid)}>{children}</div>;
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label} className="h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--viz-track)" }}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--viz-1)" }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart card with a table-view twin
// ---------------------------------------------------------------------------

export interface TableView {
  columns: string[];
  rows: (string | number)[][];
}

export function ChartCard({ title, subtitle, table, children, legend, className }: { title: string; subtitle?: string; table: TableView; children: ReactNode; legend?: ReactNode; className?: string }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <Card
      className={className}
      title={title}
      subtitle={subtitle}
      actions={
        <button
          type="button" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}
          className="no-print inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
        >
          {asTable ? <BarChart3 className="h-3.5 w-3.5" aria-hidden /> : <Table2 className="h-3.5 w-3.5" aria-hidden />}
          {asTable ? "Chart" : "Table"}
        </button>
      }
    >
      {asTable ? (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                {table.columns.map((c, i) => <th key={c} scope="col" className={cx("px-2 py-1.5 font-medium", i > 0 && "text-right")}>{c}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.map((r, i) => (
                <tr key={i}>{r.map((v, j) => <td key={j} className={cx("px-2 py-1.5", j > 0 && "tnum text-right")}>{v}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {legend && <div className="mb-3">{legend}</div>}
          {children}
        </>
      )}
    </Card>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: i.color }} aria-hidden />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Columns (single series and stacked)
// ---------------------------------------------------------------------------

interface Series { key: string; label: string; color: string }
interface ColumnsProps {
  data: { label: string; values: Record<string, number> }[];
  series: Series[];
  format: (n: number) => string;
  axisFormat?: (n: number) => string;
  height?: number;
  emptyText?: string;
}

function Columns({ data, series, format, axisFormat = format, height = 180, emptyText = "No data for this period" }: ColumnsProps) {
  const [active, setActive] = useState<number | null>(null);
  const totals = data.map((d) => series.reduce((a, s) => a + (d.values[s.key] ?? 0), 0));
  const peak = Math.max(0, ...totals);
  if (!data.length || peak === 0) return <p className="py-10 text-center text-sm text-slate-500">{emptyText}</p>;
  const max = niceMax(peak);
  const ticks = [max, max / 2, 0];
  const every = Math.max(1, Math.ceil(data.length / 10));
  const peakIndex = totals.indexOf(peak);
  const stacked = series.length > 1;

  return (
    <div className="flex gap-2">
      <div className="tnum flex flex-col justify-between text-right text-[11px] leading-none" style={{ height, color: "var(--viz-muted)" }} aria-hidden>
        {ticks.map((t) => <span key={t}>{axisFormat(t)}</span>)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative" style={{ height }} onMouseLeave={() => setActive(null)}>
          {ticks.map((t, i) => (
            <div key={t} className="absolute inset-x-0 h-px" style={{ top: `${(i / (ticks.length - 1)) * 100}%`, background: i === ticks.length - 1 ? "var(--viz-axis)" : "var(--viz-grid)" }} />
          ))}
          <div className="absolute inset-0 flex items-end">
            {data.map((d, i) => (
              <button
                key={d.label + i} type="button"
                onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}
                aria-label={`${d.label}: ${series.map((s) => `${stacked ? `${s.label} ` : ""}${format(d.values[s.key] ?? 0)}`).join(", ")}`}
                className="group relative flex h-full min-w-0 flex-1 cursor-default flex-col items-center justify-end px-px outline-offset-0"
              >
                {i === peakIndex && active === null && (
                  <span className="tnum mb-1 whitespace-nowrap text-[11px] font-medium text-slate-700">{format(totals[i])}</span>
                )}
                <span className={cx("flex w-full max-w-6 flex-col-reverse", active === i && "brightness-90")} style={{ height: `${(totals[i] / max) * 100}%` }}>
                  {series.map((s, si) => {
                    const v = d.values[s.key] ?? 0;
                    if (v <= 0) return null;
                    const isTop = series.slice(si + 1).every((x) => (d.values[x.key] ?? 0) <= 0);
                    return (
                      <span
                        key={s.key}
                        className={cx("block w-full", isTop && "rounded-t-[4px]")}
                        style={{ flex: `${v} 0 0`, background: s.color, marginTop: isTop ? 0 : 2, minHeight: 2 }}
                      />
                    );
                  })}
                </span>
              </button>
            ))}
          </div>
          {active !== null && (
            <div
              role="tooltip"
              className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-md"
              style={{ left: `${Math.min(88, Math.max(12, ((active + 0.5) / data.length) * 100))}%` }}
            >
              <p className="text-slate-500">{data[active].label}</p>
              {stacked ? (
                <>
                  {series.map((s) => (
                    <p key={s.key} className="flex items-center gap-1.5 whitespace-nowrap">
                      <span className="h-0.5 w-3 rounded" style={{ background: s.color }} aria-hidden />
                      <span className="tnum font-semibold text-slate-900">{format(data[active].values[s.key] ?? 0)}</span>
                      <span className="text-slate-500">{s.label}</span>
                    </p>
                  ))}
                  <p className="tnum mt-0.5 border-t border-slate-100 pt-0.5 font-semibold text-slate-900">{format(totals[active])} total</p>
                </>
              ) : (
                <p className="tnum whitespace-nowrap font-semibold text-slate-900">{format(totals[active])}</p>
              )}
            </div>
          )}
        </div>
        <div className="mt-1.5 flex text-[11px]" style={{ color: "var(--viz-muted)" }} aria-hidden>
          {data.map((d, i) => (
            <span key={d.label + i} className="min-w-0 flex-1 truncate text-center">{i % every === 0 ? d.label : ""}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ColumnChart({ data, ...rest }: Omit<ColumnsProps, "data" | "series"> & { data: { label: string; value: number }[] }) {
  return <Columns data={data.map((d) => ({ label: d.label, values: { v: d.value } }))} series={[{ key: "v", label: "", color: "var(--viz-1)" }]} {...rest} />;
}

/** Up to three series, in the validated categorical order. */
export function StackedColumnChart(props: ColumnsProps) {
  return <Columns {...props} series={props.series.slice(0, 3)} />;
}

export const SERIES_COLORS = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)"] as const;

// ---------------------------------------------------------------------------
// Ranked horizontal bars (comparisons and parts of a whole)
// ---------------------------------------------------------------------------

export function BarList({ data, format, limit = 10, emptyText = "No data for this period" }: { data: { label: string; value: number; sub?: string }[]; format: (n: number) => string; limit?: number; emptyText?: string }) {
  const rows = [...data].filter((d) => d.value > 0).sort((a, b) => b.value - a.value).slice(0, limit);
  if (!rows.length) return <p className="py-8 text-center text-sm text-slate-500">{emptyText}</p>;
  const max = rows[0].value;
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,34%)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
          <span className="min-w-0">
            <span className="block truncate text-slate-800" title={r.label}>{r.label}</span>
            {r.sub && <span className="block truncate text-xs text-slate-500">{r.sub}</span>}
          </span>
          <span className="block h-2.5" aria-hidden>
            <span className="block h-full rounded-r-[4px]" style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%`, background: "var(--viz-1)" }} />
          </span>
          <span className="tnum whitespace-nowrap font-medium text-slate-900">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Heatmap (weekday x hour), one-hue sequential ramp
// ---------------------------------------------------------------------------

const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function heatmapTable(matrix: number[][], format: (n: number) => string): TableView {
  const rows: (string | number)[][] = [];
  matrix.forEach((r, d) => r.forEach((v, h) => { if (v > 0) rows.push([`${DAYS[d]} ${String(h).padStart(2, "0")}:00`, format(v)]); }));
  return { columns: ["Day and hour", "Sales"], rows };
}

export function Heatmap({ matrix, format, fromHour = 7, toHour = 23 }: { matrix: number[][]; format: (n: number) => string; fromHour?: number; toHour?: number }) {
  const [tip, setTip] = useState<string | null>(null);
  const hours = Array.from({ length: toHour - fromHour + 1 }, (_, i) => fromHour + i);
  const max = Math.max(0, ...matrix.flat());
  if (max === 0) return <p className="py-8 text-center text-sm text-slate-500">No sales in this period</p>;
  const color = (v: number) => (v <= 0 ? "#f1f0ec" : RAMP[Math.min(RAMP.length - 1, Math.floor((v / max) * RAMP.length))]);
  return (
    <div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[520px] gap-[2px]" style={{ gridTemplateColumns: `2.25rem repeat(${hours.length}, minmax(0, 1fr))` }} onMouseLeave={() => setTip(null)}>
          <span />
          {hours.map((h) => <span key={h} className="text-center text-[10px]" style={{ color: "var(--viz-muted)" }} aria-hidden>{h % 2 === 1 ? h : ""}</span>)}
          {matrix.map((row, d) => (
            <div key={d} className="contents">
              <span className="self-center text-[11px]" style={{ color: "var(--viz-muted)" }}>{DAYS[d]}</span>
              {hours.map((h) => {
                const label = `${DAYS[d]} ${String(h).padStart(2, "0")}:00 - ${format(row[h])}`;
                return (
                  <button
                    key={h} type="button" aria-label={label}
                    onMouseEnter={() => setTip(label)} onFocus={() => setTip(label)} onBlur={() => setTip(null)}
                    className="h-6 cursor-default rounded-[3px] hover:ring-2 hover:ring-slate-400"
                    style={{ background: color(row[h]) }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-slate-600">
        <span className="tnum min-h-4 font-medium text-slate-900" role="status">{tip ?? ""}</span>
        <span className="flex items-center gap-1" aria-hidden>
          Less
          {RAMP.map((c) => <span key={c} className="h-2.5 w-4 rounded-[2px]" style={{ background: c }} />)}
          More
        </span>
      </div>
    </div>
  );
}
