"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Pencil, Printer } from "lucide-react";
import { PRODUCTS, PRODUCT_CODES, type ProductCode } from "@/config/catalog";
import { fmtDate } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { api, qs, useApi } from "@/lib/client";
import { f, humanize } from "@/shared/fields";
import { FormModal } from "@/components/forms";
import { BarList, ChartCard, KpiRow, Legend, SERIES_COLORS, StackedColumnChart, StatTile, fmtCompactINR } from "@/components/charts";
import { themeVars } from "@/components/shell";
import { Badge, Button, Card, DataTable, Empty, Input, Loadable, Modal, Notice, PageHeader, Select, StatusBadge, Tabs, toast, useAction } from "@/components/ui";
import {
  InvoiceStatus, PAYMENT_METHODS, Pager, ProductFilter, RecordPaymentModal, SearchBox, SubscriptionActions, SubscriptionHistory, SubscriptionState,
  cycleLabel, productName, productShort, useDebounced, type AdminSub,
} from "./admin-shared";

const linkCls = "font-medium text-brand underline-offset-2 hover:underline";

// ---------------------------------------------------------------------------
// Product management
// ---------------------------------------------------------------------------

export function AdminProducts() {
  const products = useApi<any[]>("/admin/products");
  const [editing, setEditing] = useState<any | null>(null);
  const [busy, run] = useAction();
  const toggle = (p: any) => {
    if (p.isActive && !window.confirm(`Disable ${p.name} platform-wide? Every business loses access to it until you enable it again.`)) return;
    void run(async () => { await api(`/admin/products/${p.code}`, { method: "PATCH", body: { isActive: !p.isActive } }); await products.reload(); }, p.isActive ? `${p.name} disabled` : `${p.name} enabled`);
  };
  return (
    <>
      <PageHeader title="Product management" description="The three SAF products. Each has its own plans, features, roles and subscribers." />
      <Loadable state={products}>
        {(list) => (
          <div className="grid gap-4 xl:grid-cols-3">
            {list.map((p) => (
              <div key={p.code} style={themeVars(PRODUCTS[p.code as ProductCode].theme)}>
                <Card
                  title={<span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-brand" aria-hidden />{p.name}</span>} subtitle={p.tagline}
                  actions={<StatusBadge value={p.isActive ? "ACTIVE" : "INACTIVE"} label={p.isActive ? "Enabled" : "Disabled"} />}
                >
                  <p className="text-sm text-slate-600">{p.description}</p>
                  <dl className="mt-4 grid grid-cols-4 gap-2 text-center">
                    {[["Active", p.subscribers.active], ["Basic", p.subscribers.basic], ["Growth", p.subscribers.growth], ["Expired", p.subscribers.expired]].map(([k, v]) => (
                      <div key={k} className="rounded-lg bg-slate-50 px-2 py-2"><dd className="text-lg font-semibold text-slate-900">{v}</dd><dt className="text-[11px] text-slate-500">{k}</dt></div>
                    ))}
                  </dl>
                  <table className="mt-4 w-full text-left text-sm">
                    <thead><tr className="text-xs uppercase tracking-wide text-slate-500"><th scope="col" className="py-1 font-medium">Plan</th><th scope="col" className="py-1 text-right font-medium">Monthly</th><th scope="col" className="py-1 text-right font-medium">Annual</th><th scope="col" className="py-1 text-right font-medium">Setup</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {p.plans.map((pl: any) => (
                        <tr key={pl.id}><td className="py-1.5">{pl.name}</td><td className="tnum py-1.5 text-right">{formatINR(pl.monthlyPrice, { whole: true })}</td><td className="tnum py-1.5 text-right">{formatINR(pl.annualPrice, { whole: true })}</td><td className="tnum py-1.5 text-right">{formatINR(pl.setupFee, { whole: true })}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-xs text-slate-500">{p.featureCount} features in the catalog - {p.subscribers.total} subscription{p.subscribers.total === 1 ? "" : "s"} in total</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setEditing(p)}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
                    <Link href="/admin/plans"><Button size="sm">Pricing</Button></Link>
                    <Link href="/admin/features"><Button size="sm">Features</Button></Link>
                    <Button size="sm" variant="ghost" loading={busy} onClick={() => toggle(p)}>{p.isActive ? "Disable" : "Enable"}</Button>
                  </div>
                </Card>
              </div>
            ))}
          </div>
        )}
      </Loadable>
      <FormModal
        open={!!editing} title={`Edit ${editing?.name ?? "product"}`} onClose={() => setEditing(null)}
        fields={{ name: f.text("Name", { required: true, max: 60 }), tagline: f.text("Tagline", { max: 120 }), description: f.textarea("Description", { max: 500 }) }}
        initial={editing ? { name: editing.name, tagline: editing.tagline ?? "", description: editing.description ?? "" } : null}
        onSubmit={async (v) => { await api(`/admin/products/${editing.code}`, { method: "PATCH", body: { name: v.name, tagline: v.tagline ?? "", description: v.description ?? "" } }); toast("Product saved"); await products.reload(); }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Subscription management
// ---------------------------------------------------------------------------

const STATES = ["ACTIVE", "EXPIRING", "GRACE", "EXPIRED", "SUSPENDED", "CANCELLED"] as const;

export function AdminSubscriptions() {
  const [q, setQ] = useState("");
  const [product, setProduct] = useState("");
  const [tier, setTier] = useState("");
  const [state, setState] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get("state");
    if (s && (STATES as readonly string[]).includes(s)) setState(s);
  }, []);
  const dq = useDebounced(q);
  const list = useApi<{ items: (AdminSub & { tenantId: string; business: string; code: string; phone: string | null; tenantStatus: string })[]; total: number }>(`/admin/subscriptions${qs({ q: dq, product, tier, state })}`);
  const current = list.data?.items.find((s) => s.id === open) ?? null;
  return (
    <>
      <PageHeader
        title="Subscription management" description="One row per business per product. Each product renews on its own date."
        actions={<>
          <SearchBox value={q} onChange={setQ} placeholder="Business or code" label="Search subscriptions" />
          <ProductFilter value={product} onChange={setProduct} />
          <Select aria-label="Plan" className="w-32" value={tier} onChange={(e) => setTier(e.target.value)}><option value="">Any plan</option><option value="BASIC">Basic</option><option value="GROWTH">Growth</option></Select>
          <Select aria-label="State" className="w-44" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Any state</option>
            {STATES.map((s) => <option key={s} value={s}>{s === "EXPIRING" ? "Expiring in 30 days" : s === "GRACE" ? "Grace period" : humanize(s)}</option>)}
          </Select>
        </>}
      />
      <Card pad={false}>
        <Loadable state={list}>
          {(d) => (
            <>
              <DataTable
                rows={d.items} rowKey={(r) => r.id} empty={<Empty title="No subscriptions match these filters" />}
                columns={[
                  { key: "b", label: "Business", render: (r) => <span className="block"><Link className={linkCls} href={`/admin/businesses/${r.tenantId}`}>{r.business ?? r.code}</Link><span className="block text-xs text-slate-500"><span className="font-mono">{r.code}</span>{r.tenantStatus !== "ACTIVE" ? ` - business ${r.tenantStatus.toLowerCase()}` : ""}</span></span> },
                  { key: "p", label: "Product", render: (r) => productShort(r.productCode) },
                  { key: "pl", label: "Plan", render: (r) => <span className="flex flex-col items-start gap-0.5"><Badge tone={r.tier === "GROWTH" ? "brand" : "neutral"}>{r.planName}</Badge>{(r.pendingTier || r.pendingBillingCycle) && <span className="text-xs text-slate-500">Change scheduled</span>}</span> },
                  { key: "c", label: "Billing", render: (r) => cycleLabel(r.billingCycle) },
                  { key: "s", label: "State", render: (r) => <SubscriptionState sub={r} /> },
                  { key: "e", label: "Expiry", render: (r) => fmtDate(r.currentPeriodEnd) },
                  { key: "a", label: "Renewal", align: "right", render: (r) => formatINR(r.price, { whole: true }) },
                  { key: "x", label: "", align: "right", render: (r) => <Button size="sm" onClick={() => setOpen(r.id)}>Manage</Button> },
                ]}
              />
              <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">{d.total} subscription{d.total === 1 ? "" : "s"}</p>
            </>
          )}
        </Loadable>
      </Card>
      <Modal open={!!current} title={current ? `${current.business ?? current.code} - ${productName(current.productCode)}` : ""} onClose={() => setOpen(null)} size="lg">
        {current && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-slate-700">
                <p><span className="font-semibold">{current.planName}</span>, {cycleLabel(current.billingCycle).toLowerCase()} billing - {formatINR(current.price)} + GST per renewal</p>
                <p className="text-slate-500">Started {fmtDate(current.startDate)} - expires {fmtDate(current.currentPeriodEnd)} - grace until {fmtDate(current.graceEndsAt)}</p>
              </div>
              <SubscriptionState sub={current} />
            </div>
            <div className="flex justify-start"><SubscriptionActions sub={current} size="md" onChanged={() => void list.reload()} /></div>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">History</h3>
              <SubscriptionHistory key={`${current.id}-${current.currentPeriodEnd}-${current.status}-${current.tier}`} id={current.id} />
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Plans and pricing
// ---------------------------------------------------------------------------

const PLAN_FIELDS = {
  name: f.text("Plan name", { required: true, max: 40 }),
  graceDays: f.int("Grace period (days)", { required: true, min: 0, max: 90 }),
  monthlyPrice: f.money("Monthly maintenance", { required: true }),
  annualPrice: f.money("Annual advance payment", { required: true }),
  setupFee: f.money("One-time setup", { required: true }),
  isActive: f.bool("Available for new subscriptions"),
  description: f.textarea("Description", { max: 300 }),
};

export function AdminPlans() {
  const plans = useApi<any[]>("/admin/plans");
  const [editing, setEditing] = useState<any | null>(null);
  return (
    <>
      <PageHeader title="Plans and pricing" description="Prices are set separately for each product and are read from here everywhere - nothing is hardcoded in the apps. All prices exclude GST." />
      <Loadable state={plans}>
        {(list) => (
          <div className="space-y-4">
            {PRODUCT_CODES.map((c) => (
              <Card key={c} pad={false} title={PRODUCTS[c].name} subtitle={PRODUCTS[c].tagline}>
                <DataTable
                  rows={list.filter((p) => p.productCode === c)} rowKey={(r) => r.id}
                  columns={[
                    { key: "n", label: "Plan", render: (r) => <span className="flex items-center gap-2 font-medium">{r.name}{!r.isActive && <Badge tone="bad">Not offered</Badge>}</span> },
                    { key: "m", label: "Monthly maintenance", align: "right", render: (r) => formatINR(r.monthlyPrice) },
                    { key: "a", label: "Annual advance", align: "right", render: (r) => formatINR(r.annualPrice) },
                    { key: "s", label: "One-time setup", align: "right", render: (r) => formatINR(r.setupFee) },
                    { key: "g", label: "Grace", align: "right", render: (r) => `${r.graceDays} days` },
                    { key: "f", label: "Features", align: "right", render: (r) => r._count.features },
                    { key: "u", label: "Subscribers", align: "right", render: (r) => r._count.subscriptions },
                    { key: "x", label: "", align: "right", render: (r) => <Button size="sm" onClick={() => setEditing(r)}><Pencil className="h-3.5 w-3.5" /> Edit pricing</Button> },
                  ]}
                />
              </Card>
            ))}
            <Notice tone="info">A price change applies to new subscriptions and to the next renewal invoice of existing ones. Invoices already raised keep their amount.</Notice>
          </div>
        )}
      </Loadable>
      <FormModal
        open={!!editing} title={editing ? `${productName(editing.productCode)} - ${editing.name}` : ""} fields={PLAN_FIELDS} initial={editing} onClose={() => setEditing(null)}
        onSubmit={async (v) => { await api(`/admin/plans/${editing.id}`, { method: "PATCH", body: { ...v, description: v.description ?? "" } }); toast("Pricing saved"); await plans.reload(); }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Feature management (plan matrix)
// ---------------------------------------------------------------------------

export function AdminFeatures() {
  const data = useApi<any[]>("/admin/features");
  const [product, setProduct] = useState<ProductCode>("dine");
  const [busy, run] = useAction();
  const toggle = (planId: string, key: string, enabled: boolean) => run(async () => { await api(`/admin/plans/${planId}/features/${encodeURIComponent(key)}`, { method: "PUT", body: { enabled } }); await data.reload(); });
  return (
    <>
      <PageHeader title="Feature management" description="Which modules each plan includes. Basic and Growth are defined per product; changes take effect immediately for every subscriber on that plan." />
      <Tabs value={product} onChange={setProduct} tabs={PRODUCT_CODES.map((c) => ({ key: c, label: PRODUCTS[c].name }))} />
      <Loadable state={data}>
        {(all) => {
          const p = all.find((x) => x.code === product);
          if (!p) return <Empty title="Product not found" />;
          const groups = [...new Set<string>(p.features.map((x: any) => x.group))];
          return (
            <Card pad={false}>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                      <th scope="col" className="px-4 py-2 font-medium">Feature</th>
                      <th scope="col" className="px-3 py-2 font-medium">Default</th>
                      {p.plans.map((pl: any) => <th key={pl.id} scope="col" className="w-28 px-3 py-2 text-center font-medium">{pl.name}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => (
                      <FeatureGroupRows key={g} group={g} rows={p.features.filter((x: any) => x.group === g)} plans={p.plans} busy={busy} onToggle={toggle} />
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">To give one business a single extra module without changing its plan, use Feature access on the business page.</p>
            </Card>
          );
        }}
      </Loadable>
    </>
  );
}

function FeatureGroupRows({ group, rows, plans, busy, onToggle }: { group: string; rows: any[]; plans: any[]; busy: boolean; onToggle: (planId: string, key: string, enabled: boolean) => void }) {
  return (
    <>
      <tr className="bg-slate-50/60"><th scope="colgroup" colSpan={2 + plans.length} className="px-4 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">{group}</th></tr>
      {rows.map((r) => (
        <tr key={r.key} className="border-t border-slate-100">
          <td className="px-4 py-2"><span className="block text-slate-900">{r.name}</span><span className="font-mono text-[11px] text-slate-400">{r.key}</span></td>
          <td className="px-3 py-2"><Badge tone={r.defaultTier === "GROWTH" ? "brand" : "neutral"}>{humanize(r.defaultTier)}</Badge></td>
          {plans.map((pl) => (
            <td key={pl.id} className="px-3 py-2 text-center">
              <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" aria-label={`${r.name} in ${pl.name}`} disabled={busy} checked={!!r.plans[pl.tier]} onChange={(e) => onToggle(pl.id, r.key, e.target.checked)} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Payments & invoices
// ---------------------------------------------------------------------------

export function AdminPayments() {
  const [tab, setTab] = useState<"verify" | "payments" | "invoices">("verify");
  const waiting = useApi<{ total: number }>(`/admin/payments${qs({ status: "PENDING", receipts: "1", pageSize: 1 })}`, { refreshMs: 60_000 });
  const n = waiting.data?.total ?? 0;
  return (
    <>
      <PageHeader title="Payments" description="UPI receipts to verify, payment history and SAF invoices across every business." />
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: "verify", label: n ? `To verify (${n})` : "To verify" },
        { key: "payments", label: "Payment history" },
        { key: "invoices", label: "Invoices" },
      ]} />
      {tab === "verify" ? <ReceiptsToVerify onChanged={() => void waiting.reload()} /> : tab === "payments" ? <PaymentsTable /> : <InvoicesTable />}
    </>
  );
}

/** UPI receipts uploaded by businesses. Check the bank / UPI app statement, then approve or reject. */
function ReceiptsToVerify({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState("PENDING");
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<any | null>(null);
  const [rejecting, setRejecting] = useState<any | null>(null);
  const [busy, run] = useAction();
  useEffect(() => setPage(1), [status]);
  const list = useApi<{ items: any[]; total: number }>(`/admin/payments${qs({ receipts: "1", status, page, pageSize: 50 })}`);
  const done = async () => { setViewing(null); setRejecting(null); await list.reload(); onChanged(); };
  const approve = (r: any) => {
    if (!window.confirm(`Approve ${formatINR(r.amount)} from ${r.business ?? r.code} (UTR ${r.reference})?\n\nOnly approve after you see this amount in your bank or UPI app.`)) return;
    void run(async () => { await api(`/admin/payments/${r.id}/approve`, { body: {} }); await done(); }, "Payment approved: invoice updated");
  };
  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <Select aria-label="Status" className="w-48" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="PENDING">Waiting for review</option><option value="SUCCEEDED">Approved</option><option value="FAILED">Rejected</option><option value="">All receipts</option>
        </Select>
        <p className="text-sm text-slate-600">Match the UTR and amount with your bank or UPI app before approving.</p>
      </div>
      <Card pad={false}>
        <Loadable state={list}>
          {(d) => (
            <>
              <DataTable
                rows={d.items} rowKey={(r) => r.id} empty={<Empty title={status === "PENDING" ? "No receipts waiting" : "No receipts"} hint={status === "PENDING" ? "Receipts uploaded by businesses appear here." : undefined} />}
                columns={[
                  { key: "d", label: "Sent", render: (r) => fmtDate(r.createdAt) },
                  { key: "b", label: "Business", render: (r) => <Link className={linkCls} href={`/admin/businesses/${r.tenantId}`}>{r.business ?? r.code}</Link> },
                  { key: "i", label: "Invoice", render: (r) => r.invoiceNo ? <span className="font-mono text-[13px]">{r.invoiceNo}</span> : "-" },
                  { key: "a", label: "Amount", align: "right", render: (r) => formatINR(r.amount) },
                  { key: "u", label: "UTR", render: (r) => <span className="font-mono text-[13px]">{r.reference}</span> },
                  { key: "r", label: "Receipt", render: (r) => r.receiptUrl ? (
                    <button type="button" onClick={() => setViewing(r)} className="block" aria-label={`View receipt from ${r.business ?? r.code}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={r.receiptUrl} alt="" className="h-12 w-12 rounded border border-slate-200 object-cover" />
                    </button>
                  ) : "-" },
                  { key: "s", label: "Status", render: (r) => <span><StatusBadge value={r.status} label={r.status === "PENDING" ? "To verify" : r.status === "SUCCEEDED" ? "Approved" : r.status === "FAILED" ? "Rejected" : undefined} />{r.reviewNote && <span className="mt-0.5 block max-w-[14rem] whitespace-normal text-xs text-slate-500">{r.reviewNote}</span>}</span> },
                  { key: "x", label: "", align: "right", render: (r) => r.status === "PENDING" && (
                    <span className="flex justify-end gap-1">
                      <Button size="sm" variant="primary" loading={busy} onClick={() => approve(r)}>Approve</Button>
                      <Button size="sm" variant="ghost" onClick={() => setRejecting(r)}>Reject</Button>
                    </span>
                  ) },
                ]}
              />
              <Pager page={page} pageSize={50} total={d.total} onPage={setPage} />
            </>
          )}
        </Loadable>
      </Card>
      <Modal open={!!viewing} title={viewing ? `Receipt - ${viewing.business ?? viewing.code}` : "Receipt"} onClose={() => setViewing(null)} size="lg"
        footer={viewing?.status === "PENDING" && (
          <>
            <Button variant="ghost" onClick={() => { setRejecting(viewing); setViewing(null); }}>Reject</Button>
            <Button variant="primary" loading={busy} onClick={() => approve(viewing)}>Approve {formatINR(viewing.amount)}</Button>
          </>
        )}>
        {viewing && (
          <div className="space-y-3">
            <p className="text-sm text-slate-700">Invoice <span className="font-mono">{viewing.invoiceNo}</span> · {formatINR(viewing.amount)} · UTR <span className="font-mono">{viewing.reference}</span></p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={viewing.receiptUrl} alt={`Payment receipt, UTR ${viewing.reference}`} className="mx-auto max-h-[70vh] rounded-lg border border-slate-200 object-contain" />
          </div>
        )}
      </Modal>
      <FormModal open={!!rejecting} title="Reject receipt" submitLabel="Reject"
        intro={rejecting ? `The business (${rejecting.business ?? rejecting.code}) sees this reason and can upload a new receipt.` : undefined}
        fields={{ reason: f.select("Reason", ["Payment not received in the bank", "Amount does not match the invoice", "UPI reference does not match", "Screenshot is unclear"], { required: true }), details: f.text("Details (optional)", { max: 200 }) }}
        onClose={() => setRejecting(null)}
        onSubmit={async (v) => {
          await api(`/admin/payments/${rejecting.id}/reject`, { body: { reason: [v.reason, v.details].filter(Boolean).join(". ") } });
          toast("Receipt rejected");
          await done();
        }} />
    </>
  );
}

function PaymentsTable() {
  const [q, setQ] = useState("");
  const [method, setMethod] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, method, from, to]);
  const list = useApi<{ items: any[]; total: number; collected: number }>(`/admin/payments${qs({ q: dq, method, from, to, page, pageSize: 50 })}`);
  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Business or reference" label="Search payments" />
        <Select aria-label="Method" className="w-40" value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="">Any method</option>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{humanize(m)}</option>)}
        </Select>
        <Input aria-label="From date" type="date" className="w-40" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-sm text-slate-500">to</span>
        <Input aria-label="To date" type="date" className="w-40" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
      </div>
      <Loadable state={list}>
        {(d) => (
          <>
            <KpiRow cols={2}>
              <StatTile label="Collected (matching filters)" value={formatINR(d.collected)} sub="Successful payments, incl. GST" />
              <StatTile label="Payments" value={d.total} />
            </KpiRow>
            <Card pad={false}>
              <DataTable
                rows={d.items} rowKey={(r) => r.id} empty={<Empty title="No payments match these filters" />}
                columns={[
                  { key: "d", label: "Date", render: (r) => fmtDate(r.paidAt ?? r.createdAt) },
                  { key: "b", label: "Business", render: (r) => <Link className={linkCls} href={`/admin/businesses/${r.tenantId}`}>{r.business ?? r.code}</Link> },
                  { key: "i", label: "Invoice", render: (r) => r.invoiceNo ? <span className="font-mono text-[13px]">{r.invoiceNo}</span> : "-" },
                  { key: "k", label: "For", render: (r) => <span>{r.invoiceKind ? humanize(r.invoiceKind) : "-"}{r.productCode ? ` - ${productShort(r.productCode)}` : ""}</span> },
                  { key: "a", label: "Amount", align: "right", render: (r) => formatINR(r.amount) },
                  { key: "m", label: "Method", render: (r) => humanize(r.method) },
                  { key: "r", label: "Reference", render: (r) => r.reference ?? "-" },
                  { key: "s", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
                ]}
              />
              <Pager page={page} pageSize={50} total={d.total} onPage={setPage} />
            </Card>
          </>
        )}
      </Loadable>
    </>
  );
}

function InvoicesTable() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("ISSUED");
  const [page, setPage] = useState(1);
  const [paying, setPaying] = useState<any | null>(null);
  const [busy, run] = useAction();
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, status]);
  const list = useApi<{ items: any[]; total: number }>(`/admin/invoices${qs({ q: dq, status, page, pageSize: 50 })}`);
  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Invoice no. or business" label="Search invoices" />
        <Select aria-label="Status" className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option><option value="ISSUED">Unpaid</option><option value="PAID">Paid</option><option value="VOID">Void</option>
        </Select>
      </div>
      <Card pad={false}>
        <Loadable state={list}>
          {(d) => (
            <>
              <DataTable
                rows={d.items} rowKey={(r) => r.id} empty={<Empty title={status === "ISSUED" ? "No unpaid invoices" : "No invoices match these filters"} />}
                columns={[
                  { key: "no", label: "Invoice", render: (r) => <Link className={`font-mono text-[13px] ${linkCls}`} href={`/admin/invoices/${r.id}`}>{r.invoiceNo}</Link> },
                  { key: "d", label: "Date", render: (r) => fmtDate(r.createdAt) },
                  { key: "b", label: "Business", render: (r) => <Link className={linkCls} href={`/admin/businesses/${r.tenantId}`}>{r.business ?? r.code}</Link> },
                  { key: "desc", label: "Description", render: (r) => <span className="block max-w-xs whitespace-normal">{r.description}</span> },
                  { key: "t", label: "Total", align: "right", render: (r) => formatINR(r.total) },
                  { key: "due", label: "Due", render: (r) => fmtDate(r.dueDate) },
                  { key: "s", label: "Status", render: (r) => <InvoiceStatus inv={r} /> },
                  { key: "x", label: "", align: "right", render: (r) => r.status === "ISSUED" && (
                    <span className="flex justify-end gap-1">
                      <Button size="sm" variant="primary" onClick={() => setPaying(r)}>Record payment</Button>
                      <Button size="sm" variant="ghost" loading={busy} onClick={() => { if (window.confirm(`Void invoice ${r.invoiceNo}?`)) void run(async () => { await api(`/admin/invoices/${r.id}/void`, { body: {} }); await list.reload(); }, "Invoice voided"); }}>Void</Button>
                    </span>
                  ) },
                ]}
              />
              <Pager page={page} pageSize={50} total={d.total} onPage={setPage} />
            </>
          )}
        </Loadable>
      </Card>
      <RecordPaymentModal invoice={paying} onClose={() => setPaying(null)} onDone={() => void list.reload()} />
    </>
  );
}

/** Printable SAF tax invoice. */
export function AdminInvoice({ id }: { id: string }) {
  const data = useApi<{ invoice: any; platform: any }>(`/admin/invoices/${id}`);
  return (
    <Loadable state={data}>
      {({ invoice: inv, platform }) => {
        const biz = inv.tenant?.business ?? {};
        const paid = inv.payments.filter((p: any) => p.status === "SUCCEEDED").reduce((a: number, p: any) => a + p.amount, 0);
        return (
          <>
            <div className="no-print mb-3 flex flex-wrap items-center justify-between gap-2">
              <Link href={`/admin/businesses/${inv.tenantId}`} className="inline-flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900"><ArrowLeft className="h-4 w-4" /> {biz.name ?? "Business"}</Link>
              <Button onClick={() => window.print()}><Printer className="h-4 w-4" /> Print</Button>
            </div>
            <Card className="mx-auto max-w-3xl">
              <div className="flex flex-wrap justify-between gap-4 border-b border-slate-200 pb-4">
                <div>
                  <p className="text-lg font-semibold text-slate-900">{platform.platformName}</p>
                  {platform.companyAddress && <p className="max-w-xs whitespace-pre-line text-sm text-slate-600">{platform.companyAddress}</p>}
                  {platform.companyGstin && <p className="text-sm text-slate-600">GSTIN: {platform.companyGstin}</p>}
                  {(platform.supportPhone || platform.supportEmail) && <p className="text-sm text-slate-600">{[platform.supportPhone, platform.supportEmail].filter(Boolean).join(" - ")}</p>}
                </div>
                <div className="text-right">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Tax invoice</p>
                  <p className="font-mono text-base font-semibold text-slate-900">{inv.invoiceNo}</p>
                  <p className="text-sm text-slate-600">Date: {fmtDate(inv.createdAt)}</p>
                  <p className="text-sm text-slate-600">Due: {fmtDate(inv.dueDate)}</p>
                  <div className="mt-1"><StatusBadge value={inv.status} label={inv.status === "ISSUED" ? (paid ? "Part paid" : "Unpaid") : undefined} /></div>
                </div>
              </div>
              <div className="py-4 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Billed to</p>
                <p className="font-semibold text-slate-900">{biz.name} <span className="font-mono text-xs font-normal text-slate-500">{inv.tenant?.code}</span></p>
                <p className="text-slate-600">{[biz.address, biz.city, biz.state, biz.pincode].filter(Boolean).join(", ")}</p>
                {biz.gstin && <p className="text-slate-600">GSTIN: {biz.gstin}</p>}
              </div>
              <table className="w-full text-left text-sm">
                <thead><tr className="border-y border-slate-200 text-xs uppercase tracking-wide text-slate-500"><th scope="col" className="py-2 font-medium">Description</th><th scope="col" className="py-2 text-right font-medium">Amount</th></tr></thead>
                <tbody>
                  <tr className="border-b border-slate-100">
                    <td className="py-3">{inv.description}{inv.periodStart && inv.periodEnd && <span className="block text-xs text-slate-500">Period: {fmtDate(inv.periodStart)} to {fmtDate(inv.periodEnd)}</span>}</td>
                    <td className="tnum py-3 text-right align-top">{formatINR(inv.subtotal)}</td>
                  </tr>
                </tbody>
                <tfoot className="text-sm">
                  <tr><td className="pt-3 text-right text-slate-600">Subtotal</td><td className="tnum w-36 pt-3 text-right">{formatINR(inv.subtotal)}</td></tr>
                  <tr><td className="pt-1 text-right text-slate-600">GST{inv.subtotal ? ` (${Math.round((inv.taxAmount / inv.subtotal) * 1000) / 10}%)` : ""}</td><td className="tnum pt-1 text-right">{formatINR(inv.taxAmount)}</td></tr>
                  <tr className="font-semibold"><td className="pt-1 text-right">Total</td><td className="tnum pt-1 text-right">{formatINR(inv.total)}</td></tr>
                  <tr><td className="pt-1 text-right text-slate-600">Paid</td><td className="tnum pt-1 text-right">{formatINR(paid)}</td></tr>
                  <tr className="font-semibold"><td className="pt-1 text-right">Balance due</td><td className="tnum pt-1 text-right">{formatINR(inv.status === "VOID" ? 0 : inv.total - paid)}</td></tr>
                </tfoot>
              </table>
              {inv.payments.length > 0 && (
                <div className="mt-5 border-t border-slate-200 pt-3 text-sm">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Payments</p>
                  <ul className="mt-1 space-y-0.5 text-slate-700">{inv.payments.map((p: any) => <li key={p.id}>{fmtDate(p.paidAt ?? p.createdAt)} - {formatINR(p.amount)} by {humanize(p.method)}{p.reference ? ` (${p.reference})` : ""}{p.status !== "SUCCEEDED" ? ` - ${humanize(p.status)}` : ""}</li>)}</ul>
                </div>
              )}
            </Card>
          </>
        );
      }}
    </Loadable>
  );
}

// ---------------------------------------------------------------------------
// Revenue analytics
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;

export function AdminRevenue() {
  const [months, setMonths] = useState(12);
  const data = useApi<any>(`/admin/analytics/revenue?months=${months}`);
  // Three series is the validated maximum; one-off "other" invoices are folded
  // into the setup series for the chart and listed separately in the table.
  const series = [
    { key: "monthly", label: "Monthly maintenance", color: SERIES_COLORS[0] },
    { key: "annual", label: "Annual advance", color: SERIES_COLORS[1] },
    { key: "oneoff", label: "Setup & one-off", color: SERIES_COLORS[2] },
  ];
  return (
    <>
      <PageHeader
        title="Revenue analytics" description="Paid SAF invoices, excluding GST."
        actions={<Select aria-label="Period" className="w-44" value={months} onChange={(e) => setMonths(Number(e.target.value))}><option value={6}>Last 6 months</option><option value={12}>Last 12 months</option><option value={24}>Last 24 months</option></Select>}
      />
      <Loadable state={data}>
        {(d) => (
          <>
            <KpiRow cols={5}>
              <StatTile label="Monthly recurring revenue" value={formatINR(d.totalMrr, { whole: true })} sub="Active subscriptions today" />
              <StatTile label={`Revenue, last ${months} months`} value={formatINR(d.totals.total, { whole: true })} />
              <StatTile label="Monthly maintenance" value={formatINR(d.totals.monthly, { whole: true })} />
              <StatTile label="Annual prepaid" value={formatINR(d.totals.annual, { whole: true })} />
              <StatTile label="Setup revenue" value={formatINR(d.totals.setup, { whole: true })} sub={d.totals.other ? `+ ${formatINR(d.totals.other, { whole: true })} one-off` : undefined} />
            </KpiRow>
            <ChartCard
              className="mb-4" title="Revenue by month" subtitle="Month the invoice was paid" legend={<Legend items={series} />}
              table={{ columns: ["Month", "Monthly", "Annual", "Setup", "One-off", "Total"], rows: d.series.map((s: any) => [monthLabel(s.month), formatINR(s.monthly), formatINR(s.annual), formatINR(s.setup), formatINR(s.other), formatINR(s.total)]) }}
            >
              <StackedColumnChart
                data={d.series.map((s: any) => ({ label: monthLabel(s.month), values: { monthly: s.monthly, annual: s.annual, oneoff: s.setup + s.other } }))}
                series={series} format={(n) => formatINR(n, { whole: true })} axisFormat={fmtCompactINR} height={220} emptyText="No paid invoices in this period"
              />
            </ChartCard>
            <div className="grid gap-4 xl:grid-cols-3">
              <ChartCard title="Revenue by product" subtitle={`Last ${months} months`} table={{ columns: ["Product", "Revenue"], rows: PRODUCT_CODES.map((c) => [PRODUCTS[c].name, formatINR(d.byProduct[c] ?? 0)]) }}>
                <BarList data={PRODUCT_CODES.map((c) => ({ label: PRODUCTS[c].name, value: d.byProduct[c] ?? 0 }))} format={(n) => formatINR(n, { whole: true })} emptyText="No product revenue yet" />
              </ChartCard>
              <ChartCard title="Collections by method" subtitle="Payments received, incl. GST" table={{ columns: ["Method", "Collected"], rows: d.collectionsByMethod.map((m: any) => [humanize(m.method), formatINR(m.amount)]) }}>
                <BarList data={d.collectionsByMethod.map((m: any) => ({ label: humanize(m.method), value: m.amount }))} format={(n) => formatINR(n, { whole: true })} emptyText="No payments yet" />
              </ChartCard>
              <Card pad={false} title="Recurring revenue by plan" subtitle="Active subscriptions today">
                <DataTable
                  rows={d.mrr} rowKey={(r: any) => `${r.product}-${r.tier}`} dense
                  columns={[
                    { key: "p", label: "Product", render: (r: any) => productShort(r.product) },
                    { key: "t", label: "Plan", render: (r: any) => <Badge tone={r.tier === "GROWTH" ? "brand" : "neutral"}>{humanize(r.tier)}</Badge> },
                    { key: "s", label: "Subs", align: "right", render: (r: any) => r.subscriptions },
                    { key: "m", label: "MRR", align: "right", render: (r: any) => formatINR(r.mrr, { whole: true }) },
                  ]}
                />
              </Card>
            </div>
          </>
        )}
      </Loadable>
    </>
  );
}
