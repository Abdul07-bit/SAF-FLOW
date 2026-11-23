"use client";

import { useEffect, useId, useState, useSyncExternalStore, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from "lucide-react";
import { humanize } from "@/shared/fields";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Buttons & inputs
// ---------------------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand text-brand-ink hover:brightness-110 shadow-sm",
  secondary: "bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 shadow-sm",
  ghost: "text-slate-700 hover:bg-slate-100",
  danger: "bg-red-600 text-white hover:bg-red-700 shadow-sm",
};
const SIZES = { sm: "h-8 px-2.5 text-[13px] gap-1.5", md: "h-10 px-4 text-sm gap-2", lg: "h-12 px-5 text-base gap-2" };

export function Button({
  variant = "secondary", size = "md", loading, className, children, disabled, type = "button", ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: keyof typeof SIZES; loading?: boolean }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap transition disabled:opacity-50",
        VARIANTS[variant], SIZES[size], className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

const CONTROL = "w-full rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-900 sm:text-sm placeholder:text-slate-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25 disabled:bg-slate-100";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(CONTROL, "h-10", className)} {...rest} />;
}
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(CONTROL, "h-10 pr-8", className)} {...rest}>{children}</select>;
}
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} className={cx(CONTROL, "py-2", className)} {...rest} />;
}

export function Field({ label, help, required, children, className }: { label: string; help?: string; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-[13px] font-medium text-slate-700">
        {label}
        {required && <span className="text-red-600" aria-hidden> *</span>}
      </span>
      {children}
      {help && <span className="mt-1 block text-xs text-slate-500">{help}</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Card({ title, subtitle, actions, children, className, pad = true }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx("print-card rounded-xl border border-slate-200 bg-white shadow-sm", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-slate-600">{description}</p>}
      </div>
      {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { key: T; label: string; count?: number }[] }) {
  return (
    <div role="tablist" className="no-print mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.key} role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)}
          className={cx("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium", value === t.key ? "border-brand text-brand" : "border-transparent text-slate-600 hover:text-slate-900")}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status: always icon/label + colour, never colour alone
// ---------------------------------------------------------------------------

export type Tone = "neutral" | "good" | "warn" | "bad" | "info" | "brand";
const TONES: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
  good: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  warn: "bg-amber-50 text-amber-900 ring-amber-200",
  bad: "bg-red-50 text-red-800 ring-red-200",
  info: "bg-sky-50 text-sky-800 ring-sky-200",
  brand: "bg-brand-soft text-brand ring-brand/20",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap", TONES[tone], className)}>{children}</span>;
}

const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: "good", PAID: "good", COMPLETED: "good", CLEAN: "good", INSPECTED: "good", AVAILABLE: "good", FREE: "good", PRESENT: "good", RESOLVED: "good",
  RECEIVED: "good", SUCCEEDED: "good", DONE: "good", SERVED: "good", CHECKED_IN: "good", READY: "good",
  GRACE: "warn", PENDING: "warn", ISSUED: "warn", DIRTY: "warn", RESERVED: "warn", LATE: "warn", HALF_DAY: "warn", ORDERED: "warn", OPEN: "warn",
  PENDING_ACCEPT: "warn", CLEANING: "warn", HIGH: "warn", NEW: "warn", CONFIRMED: "info", IN_PROGRESS: "info", PREPARING: "info", SENT: "info", OCCUPIED: "info",
  CHECKED_OUT: "neutral", CLOSED: "neutral", INACTIVE: "neutral", BASIC: "neutral", NORMAL: "neutral", LOW: "neutral", ON_LEAVE: "neutral",
  EXPIRED: "bad", SUSPENDED: "bad", CANCELLED: "bad", VOID: "bad", ABSENT: "bad", OUT_OF_ORDER: "bad", FAILED: "bad", REVOKED: "bad", NO_SHOW: "bad", URGENT: "bad",
  GROWTH: "brand",
};

export function StatusBadge({ value, label }: { value: string | null | undefined; label?: string }) {
  if (!value) return <span className="text-slate-400">-</span>;
  return <Badge tone={STATUS_TONE[value] ?? "neutral"}>{label ?? humanize(value)}</Badge>;
}

export function Notice({ tone = "info", title, children, action }: { tone?: "info" | "warn" | "bad" | "good"; title?: string; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === "good" ? CheckCircle2 : tone === "bad" ? XCircle : tone === "warn" ? AlertTriangle : Info;
  const cls = { info: "border-sky-200 bg-sky-50 text-sky-900", warn: "border-amber-300 bg-amber-50 text-amber-900", bad: "border-red-200 bg-red-50 text-red-900", good: "border-emerald-200 bg-emerald-50 text-emerald-900" }[tone];
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={cx("flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm", cls)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5" : ""}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {label}...
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm font-medium text-slate-800">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{hint}</p>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

/** Standard loading / error wrapper for a screen section. */
export function Loadable<T>({ state, children }: { state: { data: T | null; error: Error | null; loading: boolean }; children: (data: T) => ReactNode }) {
  if (state.error && !state.data) return <Notice tone="bad" title="Could not load">{state.error.message}</Notice>;
  if (!state.data) return <Spinner />;
  return <>{children(state.data)}</>;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export interface Col<R> {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
  render: (row: R) => ReactNode;
  className?: string;
}

export function DataTable<R>({ columns, rows, rowKey, empty, onRowClick, dense }: {
  columns: Col<R>[]; rows: R[]; rowKey: (r: R, i: number) => string; empty?: ReactNode; onRowClick?: (r: R) => void; dense?: boolean;
}) {
  if (!rows.length) return <>{empty ?? <Empty title="Nothing here yet" />}</>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx("px-3 py-2 font-medium", c.align === "right" && "text-right", c.align === "center" && "text-center")}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r, i) => (
            <tr key={rowKey(r, i)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cx(onRowClick && "cursor-pointer hover:bg-slate-50")}>
              {columns.map((c) => (
                <td key={c.key} className={cx("px-3 text-slate-800", dense ? "py-1.5" : "py-2.5", c.align === "right" && "tnum text-right", c.align === "center" && "text-center", c.className)}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal({ open, title, onClose, children, footer, size = "md" }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg" | "xl" }) {
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  const width = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl", xl: "max-w-5xl" }[size];
  return (
    <div className="no-print fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={id} className={cx("flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl", width)}>
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <h2 id={id} className="text-base font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-slate-500 hover:bg-slate-100"><X className="h-5 w-5" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

interface Toast { id: number; tone: "good" | "bad" | "info"; text: string }
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(text: string, tone: Toast["tone"] = "good") {
  const t = { id: nextId++, tone, text };
  toasts = [...toasts, t];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    emit();
  }, tone === "bad" ? 6000 : 3500);
}
export const toastError = (e: unknown) => toast(e instanceof Error ? e.message : "Something went wrong.", "bad");

const EMPTY: Toast[] = [];
export function Toaster() {
  const list = useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => toasts, () => EMPTY);
  return (
    <div className="no-print pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={cx("pointer-events-auto flex max-w-md items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white shadow-lg", t.tone === "bad" ? "bg-red-700" : t.tone === "good" ? "bg-emerald-700" : "bg-slate-800")}>
          {t.tone === "bad" ? <XCircle className="h-4 w-4 shrink-0" /> : <CheckCircle2 className="h-4 w-4 shrink-0" />}
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** Runs an async action with a busy flag and error toast. */
export function useAction(): [boolean, (fn: () => Promise<unknown>, success?: string) => Promise<boolean>] {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await fn();
      if (success) toast(success);
      return true;
    } catch (e) {
      toastError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return [busy, run];
}

export function KeyValue({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-500">{k}</dt>
          <dd className="min-w-0 break-words text-slate-900">{v ?? "-"}</dd>
        </div>
      ))}
    </dl>
  );
}
