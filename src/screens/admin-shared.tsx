"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Copy, Search } from "lucide-react";
import { PRODUCTS, PRODUCT_CODES, type ProductCode } from "@/config/catalog";
import { fmtDate, fmtDateTime, istDate } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { api, useApi } from "@/lib/client";
import { f, humanize } from "@/shared/fields";
import { FormModal } from "@/components/forms";
import { Badge, Button, Input, Modal, Notice, Select, StatusBadge, toast, useAction } from "@/components/ui";

export const PAYMENT_METHODS = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "CHEQUE", "OTHER"] as const;
export const productName = (code: string | null | undefined) => (code && code in PRODUCTS ? PRODUCTS[code as ProductCode].name : code ?? "-");
export const productShort = (code: string | null | undefined) => (code && code in PRODUCTS ? PRODUCTS[code as ProductCode].shortName : code ?? "-");
export const cycleLabel = (c: string | null | undefined) => (c === "ANNUAL" ? "Annual" : c === "MONTHLY" ? "Monthly" : "-");

/** Drops null / empty values so optional (non-nullable) API fields are omitted. */
export function clean<T extends Record<string, any>>(v: T): Partial<T> {
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined && x !== "")) as Partial<T>;
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function SearchBox({ value, onChange, placeholder = "Search...", label = "Search" }: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" aria-hidden />
      <Input aria-label={label} placeholder={placeholder} className="w-48 pl-8 sm:w-60" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function ProductFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select aria-label="Product" className="w-40" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All products</option>
      {PRODUCT_CODES.map((c) => <option key={c} value={c}>{PRODUCTS[c].name}</option>)}
    </Select>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">{total} record{total === 1 ? "" : "s"}</p>;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-2 text-xs text-slate-600">
      <span>{(page - 1) * pageSize + 1}-{Math.min(total, page * pageSize)} of {total}</span>
      <span className="flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
        <span>Page {page} of {pages}</span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
      </span>
    </div>
  );
}

/** One chip per subscribed product: "Dine Flow - Growth". */
export function ProductChips({ products }: { products: { code: string; tier: string; state?: string }[] }) {
  if (!products.length) return <span className="text-slate-400">None</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {products.map((p) => (
        <Badge key={p.code} tone={p.state && p.state !== "ACTIVE" ? (p.state === "GRACE" ? "warn" : "bad") : p.tier === "GROWTH" ? "brand" : "neutral"}>
          {productShort(p.code)} - {humanize(p.tier)}{p.state && p.state !== "ACTIVE" ? ` (${humanize(p.state)})` : ""}
        </Badge>
      ))}
    </span>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  return (
    <Button size="sm" onClick={() => navigator.clipboard.writeText(text).then(() => toast("Copied"), () => toast("Could not copy", "bad"))}>
      <Copy className="h-3.5 w-3.5" /> {label}
    </Button>
  );
}

/** One-time credentials (new business / password reset). Never stored in the browser. */
export function Credentials({ username, password, title = "Login credentials" }: { username: string; password: string; title?: string }) {
  return (
    <Notice tone="good" title={title}>
      <dl className="mt-1 grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-1">
        <dt>Login ID</dt><dd className="font-mono font-semibold">{username}</dd>
        <dt>Temporary password</dt><dd className="font-mono font-semibold">{password}</dd>
      </dl>
      <p className="mt-2 text-xs">Shown once. The user must set a new password at first sign-in.</p>
      <div className="mt-2"><CopyButton text={`Login ID: ${username}\nTemporary password: ${password}`} label="Copy both" /></div>
    </Notice>
  );
}

export function CredentialsModal({ creds, onClose }: { creds: { username: string; temporaryPassword: string } | null; onClose: () => void }) {
  return (
    <Modal open={!!creds} title="Temporary password issued" onClose={onClose} size="sm" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      {creds && <Credentials username={creds.username} password={creds.temporaryPassword} />}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// User account actions (managers / employees)
// ---------------------------------------------------------------------------

export function UserActions({ user, onChanged }: { user: { id: string; username: string; isActive: boolean; lockedUntil?: string | null }; onChanged: () => void }) {
  const [busy, run] = useAction();
  const [creds, setCreds] = useState<{ username: string; temporaryPassword: string } | null>(null);
  const locked = !!user.lockedUntil && new Date(user.lockedUntil) > new Date();
  return (
    <span className="flex justify-end gap-1">
      {locked && <Button size="sm" loading={busy} onClick={() => run(async () => { await api(`/admin/users/${user.id}/unlock`, { method: "POST" }); onChanged(); }, "Account unlocked")}>Unlock</Button>}
      <Button size="sm" loading={busy} onClick={() => { if (window.confirm(`Issue a new temporary password for ${user.username}? Their current sessions will be signed out.`)) void run(async () => setCreds(await api(`/admin/users/${user.id}/reset-password`, { method: "POST" }))); }}>Reset password</Button>
      <Button size="sm" variant="ghost" loading={busy} onClick={() => { if (user.isActive && !window.confirm(`Disable ${user.username}? They will be signed out immediately.`)) return; void run(async () => { await api(`/admin/users/${user.id}/status`, { body: { isActive: !user.isActive } }); onChanged(); }, user.isActive ? "Account disabled" : "Account enabled"); }}>
        {user.isActive ? "Disable" : "Enable"}
      </Button>
      <CredentialsModal creds={creds} onClose={() => { setCreds(null); onChanged(); }} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Subscription actions: renew, change plan, adjust, suspend / reactivate / cancel
// ---------------------------------------------------------------------------

export interface AdminSub {
  id: string;
  productCode: string;
  tier: string;
  planName: string;
  billingCycle: string;
  status: string;
  state: string;
  startDate: string;
  currentPeriodEnd: string;
  graceEndsAt: string;
  daysLeft: number;
  price: number;
  autoRenew: boolean;
  pendingTier?: string | null;
  pendingBillingCycle?: string | null;
  graceDaysOverride?: number | null;
}

export function SubscriptionActions({ sub, onChanged, size = "sm" }: { sub: AdminSub; onChanged: () => void; size?: "sm" | "md" }) {
  const [mode, setMode] = useState<"renew" | "plan" | "adjust" | "suspend" | null>(null);
  const [busy, run] = useAction();
  const done = (msg: string) => { toast(msg); onChanged(); };
  const setStatus = (action: "reactivate" | "cancel") => run(async () => { await api(`/admin/subscriptions/${sub.id}/status`, { body: { action } }); onChanged(); }, action === "cancel" ? "Subscription cancelled" : "Subscription reactivated");
  const name = productName(sub.productCode);

  return (
    <>
      <span className="flex flex-wrap justify-end gap-1">
        {sub.status !== "CANCELLED" && <Button size={size} variant="primary" onClick={() => setMode("renew")}>Renew</Button>}
        <Button size={size} onClick={() => setMode("plan")}>Change plan</Button>
        <Button size={size} onClick={() => setMode("adjust")}>Adjust</Button>
        {sub.status === "SUSPENDED" || sub.status === "CANCELLED"
          ? <Button size={size} loading={busy} onClick={() => setStatus("reactivate")}>Reactivate</Button>
          : <Button size={size} variant="ghost" onClick={() => setMode("suspend")}>Suspend</Button>}
        {sub.status !== "CANCELLED" && <Button size={size} variant="ghost" loading={busy} onClick={() => { if (window.confirm(`Cancel ${name}? The business loses access to this application. Data is kept.`)) void setStatus("cancel"); }}>Cancel</Button>}
      </span>

      <FormModal
        open={mode === "renew"} title={`Renew ${name}`} submitLabel="Renew" onClose={() => setMode(null)}
        intro={<p className="text-sm text-slate-600">Extends the subscription by one billing cycle from {sub.state === "ACTIVE" ? "the current expiry" : "today"} and raises a renewal invoice at the price configured for the plan.</p>}
        fields={{
          billingCycle: f.select("Billing cycle", ["MONTHLY", "ANNUAL"], { required: true }),
          paid: f.bool("Payment received", { help: "Records the payment and marks the invoice paid." }),
          method: f.select("Payment method", PAYMENT_METHODS, { required: true }),
          reference: f.text("Payment reference", { max: 100, placeholder: "UPI ref / cheque no." }),
        }}
        initial={{ billingCycle: sub.billingCycle, paid: false, method: "UPI", reference: "" }}
        onSubmit={async (v) => {
          const r = await api<{ invoice: { invoiceNo: string } }>(`/admin/subscriptions/${sub.id}/renew`, {
            body: { billingCycle: v.billingCycle, ...(v.paid ? { payment: clean({ method: v.method, reference: v.reference }) } : {}) },
          });
          done(`Renewed - invoice ${r.invoice.invoiceNo}`);
        }}
      />

      <FormModal
        open={mode === "plan"} title={`Change plan - ${name}`} submitLabel="Change plan" onClose={() => setMode(null)}
        intro={<p className="text-sm text-slate-600">Currently {sub.planName}, {cycleLabel(sub.billingCycle).toLowerCase()} billing. Upgrades usually apply now; downgrades at the period end.</p>}
        fields={{
          tier: f.select("Plan", ["BASIC", "GROWTH"], { required: true }),
          billingCycle: f.select("Billing cycle", ["MONTHLY", "ANNUAL"], { required: true }),
          effective: f.select("Takes effect", ["NOW", "PERIOD_END"], { required: true }),
          chargeProration: f.bool("Invoice the price difference", { help: "Only when upgrading now: bills the unused part of the period at the new rate." }),
        }}
        initial={{ tier: sub.tier === "BASIC" ? "GROWTH" : "BASIC", billingCycle: sub.billingCycle, effective: sub.tier === "BASIC" ? "NOW" : "PERIOD_END", chargeProration: false }}
        onSubmit={async (v) => {
          const r = await api<{ applied: string }>(`/admin/subscriptions/${sub.id}/change-plan`, { body: v });
          done(r.applied === "NOW" ? "Plan changed" : "Plan change scheduled for the next renewal");
        }}
      />

      <FormModal
        open={mode === "adjust"} title={`Adjust ${name}`} onClose={() => setMode(null)}
        fields={{
          expiryDate: f.date("Expiry date", { required: true }),
          graceDays: f.int("Grace period (days)", { min: 0, max: 90, help: "Leave empty to use the plan default." }),
          autoRenew: f.bool("Raise renewal invoices automatically"),
        }}
        initial={{ expiryDate: istDate(new Date(sub.currentPeriodEnd)), graceDays: sub.graceDaysOverride ?? null, autoRenew: sub.autoRenew }}
        onSubmit={async (v) => {
          await api(`/admin/subscriptions/${sub.id}`, { method: "PATCH", body: { expiryDate: v.expiryDate, graceDays: v.graceDays ?? null, autoRenew: v.autoRenew } });
          done("Subscription updated");
        }}
      />

      <FormModal
        open={mode === "suspend"} title={`Suspend ${name}`} submitLabel="Suspend" danger onClose={() => setMode(null)}
        intro={<Notice tone="warn">The business keeps its data but nobody can use {name} until it is reactivated.</Notice>}
        fields={{ reason: f.textarea("Reason (shown to the business)", { max: 300 }) }}
        onSubmit={async (v) => {
          await api(`/admin/subscriptions/${sub.id}/status`, { body: clean({ action: "suspend", reason: v.reason }) });
          done("Subscription suspended");
        }}
      />
    </>
  );
}

export function SubscriptionState({ sub }: { sub: { state: string; currentPeriodEnd: string; graceEndsAt: string; daysLeft: number } }): ReactNode {
  return (
    <span className="flex flex-col gap-0.5">
      <StatusBadge value={sub.state} label={sub.state === "GRACE" ? "Grace period" : undefined} />
      <span className="text-xs text-slate-500">
        {sub.state === "ACTIVE" ? `${Math.max(0, sub.daysLeft)} day${sub.daysLeft === 1 ? "" : "s"} left` : sub.state === "GRACE" ? `Access until ${fmtDate(sub.graceEndsAt)}` : `Since ${fmtDate(sub.currentPeriodEnd)}`}
      </span>
    </span>
  );
}

const EVENT_LABELS: Record<string, string> = {
  CREATED: "Subscription created", RENEWED: "Renewed", PLAN_CHANGED: "Plan changed", PLAN_CHANGE_SCHEDULED: "Plan change scheduled",
  SUSPENDED: "Suspended", REACTIVATED: "Reactivated", CANCELLED: "Cancelled", EXPIRED: "Expired", ADJUSTED: "Adjusted", REMINDER: "Renewal reminder sent",
};

export function EventList({ events }: { events: { id: string; type: string; meta: any; createdAt: string }[] }) {
  if (!events.length) return <p className="py-6 text-center text-sm text-slate-500">No history yet.</p>;
  return (
    <ol className="space-y-2">
      {events.map((e) => (
        <li key={e.id} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
          <p className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium text-slate-900">{EVENT_LABELS[e.type] ?? humanize(e.type)}</span>
            <span className="text-xs text-slate-500">{fmtDateTime(e.createdAt)}</span>
          </p>
          {e.meta && Object.keys(e.meta).length > 0 && (
            <p className="mt-0.5 break-words text-xs text-slate-600">
              {Object.entries(e.meta).filter(([, v]) => v !== null && v !== "" && typeof v !== "object").map(([k, v]) => `${humanize(k.replace(/([A-Z])/g, "_$1"))}: ${v}`).join(" - ")}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

export function SubscriptionHistory({ id }: { id: string }) {
  const ev = useApi<any[]>(`/admin/subscriptions/${id}/events`);
  if (!ev.data) return <p className="py-6 text-center text-sm text-slate-500">{ev.error ? ev.error.message : "Loading..."}</p>;
  return <EventList events={ev.data} />;
}

// ---------------------------------------------------------------------------
// Invoices: record a payment
// ---------------------------------------------------------------------------

export function RecordPaymentModal({ invoice, onClose, onDone }: { invoice: { id: string; invoiceNo: string; total: number; paidAmount: number } | null; onClose: () => void; onDone: () => void }) {
  return (
    <FormModal
      open={!!invoice} title={invoice ? `Record payment - ${invoice.invoiceNo}` : "Record payment"} submitLabel="Record payment" onClose={onClose}
      intro={invoice && <p className="text-sm text-slate-600">Invoice total {formatINR(invoice.total)}; {formatINR(invoice.total - invoice.paidAmount)} outstanding. The invoice is marked paid once fully covered, and a paid renewal invoice extends the subscription.</p>}
      fields={{
        amount: f.money("Amount received", { required: true }),
        method: f.select("Method", PAYMENT_METHODS, { required: true }),
        paidAt: f.date("Received on"),
        reference: f.text("Reference", { max: 100 }),
        notes: f.textarea("Notes", { max: 300 }),
      }}
      initial={invoice ? { amount: invoice.total - invoice.paidAmount, method: "UPI", paidAt: "", reference: "", notes: "" } : null}
      onSubmit={async (v) => {
        await api("/admin/payments", { body: clean({ invoiceId: invoice!.id, amount: v.amount, method: v.method, paidAt: v.paidAt, reference: v.reference, notes: v.notes }) });
        toast("Payment recorded");
        onDone();
      }}
    />
  );
}

export function InvoiceStatus({ inv }: { inv: { status: string; paidAmount: number; dueDate: string } }) {
  const overdue = inv.status === "ISSUED" && new Date(inv.dueDate) < new Date();
  if (inv.status !== "ISSUED") return <StatusBadge value={inv.status} />;
  return <Badge tone={overdue ? "bad" : "warn"}>{inv.paidAmount ? "Part paid" : "Unpaid"}{overdue ? " - overdue" : ""}</Badge>;
}
