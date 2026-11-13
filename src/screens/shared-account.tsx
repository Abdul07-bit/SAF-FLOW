"use client";

import { useEffect, useRef, useState } from "react";
import { ImageUp, Mail, MessageCircle, Phone, Plus, Send } from "lucide-react";
import type { ProductCode } from "@/config/catalog";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { api, useApi } from "@/lib/client";
import { f, humanize, type FieldDef } from "@/shared/fields";
import { branches } from "@/shared/resources";
import { FieldInput, FormModal, ResourcePage, toDisplay, toWire } from "@/components/forms";
import { PlanCompare, type FeatureRow, type PlanInfo } from "@/components/plan-compare";
import { useProduct, type SubscriptionInfo } from "@/components/product-context";
import { Badge, Button, Card, DataTable, Empty, Field, KeyValue, Loadable, Notice, PageHeader, StatusBadge, Textarea, toast, useAction } from "@/components/ui";

export function BranchesScreen() {
  const p = useProduct();
  return <ResourcePage def={branches} description="Each branch keeps its own rooms, tables, stock and sales. Switch branch from the top bar." onChanged={() => void p.reload()} />;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTINGS: Record<ProductCode, Record<string, FieldDef>> = {
  dine: {
    restaurantName: f.text("Name on bills and QR menu", { max: 100, help: "Leave empty to use the business name." }),
    invoicePrefix: f.text("Invoice number prefix", { required: true, max: 8 }),
    gstin: f.text("GSTIN", { max: 20 }),
    receiptFooter: f.text("Bill footer", { max: 200 }),
    qrOrderingAutoAccept: f.bool("Send QR table orders straight to the kitchen", { help: "Off: a waiter accepts each QR order first." }),
  },
  stay: {
    hotelName: f.text("Name on invoices", { max: 100, help: "Leave empty to use the business name." }),
    invoicePrefix: f.text("Invoice number prefix", { required: true, max: 8 }),
    gstin: f.text("GSTIN", { max: 20 }),
    roomTaxBp: f.percent("GST on room tariff %", { required: true }),
    checkInTime: f.time("Standard check-in time", { required: true }),
    checkOutTime: f.time("Standard check-out time", { required: true }),
    invoiceFooter: f.text("Invoice footer", { max: 200 }),
  },
  bill: {
    storeName: f.text("Name on invoices", { max: 100, help: "Leave empty to use the business name." }),
    invoicePrefix: f.text("Invoice number prefix", { required: true, max: 8 }),
    gstin: f.text("GSTIN", { max: 20 }),
    receiptFooter: f.text("Invoice footer", { max: 200 }),
    allowNegativeStock: f.bool("Allow billing when stock is zero", { help: "Off: the POS refuses to sell more than is in stock." }),
  },
};

const PROFILE = {
  name: f.text("Business name", { required: true, max: 120 }),
  phone: f.phone("Phone", { required: true }),
  email: f.email("Email"),
  address: f.textarea("Address", { max: 300 }),
};

function InlineForm({ fields, initial, onSubmit, submitLabel = "Save changes" }: { fields: Record<string, FieldDef>; initial: Record<string, any>; onSubmit: (v: Record<string, any>) => Promise<unknown>; submitLabel?: string }) {
  const [values, setValues] = useState(() => toDisplay(fields, initial));
  const [busy, run] = useAction();
  return (
    <form className="grid gap-x-4 gap-y-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void run(() => onSubmit(toWire(fields, values)), "Saved"); }}>
      {Object.entries(fields).map(([k, fd]) =>
        fd.type === "bool" ? (
          <div key={k} className="sm:col-span-2">
            <FieldInput name={k} fd={fd} value={values[k]} onChange={(v) => setValues((s) => ({ ...s, [k]: v }))} />
            {fd.help && <span className="block pl-6 text-xs text-slate-500">{fd.help}</span>}
          </div>
        ) : (
          <Field key={k} label={fd.label} help={fd.help} required={fd.required} className={fd.type === "textarea" ? "sm:col-span-2" : ""}>
            <FieldInput name={k} fd={fd} value={values[k]} onChange={(v) => setValues((s) => ({ ...s, [k]: v }))} />
          </Field>
        ),
      )}
      <div className="sm:col-span-2"><Button type="submit" variant="primary" loading={busy}>{submitLabel}</Button></div>
    </form>
  );
}

export function SettingsScreen() {
  const p = useProduct();
  const file = useRef<HTMLInputElement>(null);
  const [busy, run] = useAction();
  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked) return;
    const form = new FormData();
    form.append("file", picked);
    await run(async () => { await api(`${p.base}/business/logo`, { form }); await p.reload(); }, "Logo updated");
  };
  return (
    <>
      <PageHeader title="Settings" description={`${p.product.name} settings for ${p.tenant.name}.`} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={`${p.product.shortName} settings`}>
          <InlineForm fields={SETTINGS[p.code]} initial={p.settings} onSubmit={async (v) => { await api(`${p.base}/settings`, { method: "PUT", body: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x ?? ""])) }); await p.reload(); }} />
        </Card>
        <div className="space-y-4">
          <Card title="Business profile" subtitle="Shared by all your SAF applications. Printed on invoices and ID cards.">
            {p.user.isTenantOwner ? (
              <InlineForm fields={PROFILE} initial={p.tenant} onSubmit={async (v) => { await api(`${p.base}/business`, { method: "PUT", body: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x ?? ""])) }); await p.reload(); }} />
            ) : (
              <KeyValue items={[["Business", p.tenant.name], ["Phone", p.tenant.phone], ["Email", p.tenant.email], ["Address", p.tenant.address]]} />
            )}
          </Card>
          <Card title="Logo" subtitle="PNG or JPEG, up to 2 MB.">
            <div className="flex items-center gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {p.tenant.logoUrl ? <img src={p.tenant.logoUrl} alt="Business logo" className="h-16 w-16 rounded-lg border border-slate-200 object-contain" /> : <span className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-slate-300 text-xs text-slate-400">No logo</span>}
              <input ref={file} type="file" accept="image/png,image/jpeg" className="hidden" onChange={upload} />
              <Button loading={busy} onClick={() => file.current?.click()}><ImageUp className="h-4 w-4" /> Upload logo</Button>
            </div>
          </Card>
          <Card title="Business code"><KeyValue items={[["Code", <span key="c" className="font-mono">{p.tenant.code}</span>], ["Staff login format", <span key="l" className="font-mono">{p.tenant.code}@name</span>]]} /></Card>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Subscription & SAF billing
// ---------------------------------------------------------------------------

interface SubData {
  subscription: SubscriptionInfo | null;
  plans: PlanInfo[];
  features: FeatureRow[];
  invoices: any[];
  events: any[];
  onlinePayments: boolean;
  gstRateBp: number;
  support: { phone: string; email: string; whatsapp: string };
}

function loadCashfree(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).Cashfree) return resolve();
    const s = document.createElement("script");
    s.src = "https://sdk.cashfree.com/js/v3/cashfree.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load the payment window. Check your connection."));
    document.body.appendChild(s);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function SubscriptionScreen() {
  const p = useProduct();
  const data = useApi<SubData>(`${p.base}/subscription`);
  const [request, setRequest] = useState<string | null>(null);
  const [busy, run] = useAction();

  /**
   * Asks the server to read the order from Cashfree. A just-finished payment can
   * take a few seconds to show as PAID, so retry briefly before giving up.
   */
  const confirm = async (orderId: string, tries: number) => {
    for (let i = 0; i < tries; i++) {
      const r = await api<{ status: string }>(`${p.base}/billing/cashfree/confirm`, { body: { orderId } });
      if (r.status === "PAID") {
        toast("Payment received. Thank you!");
        await Promise.all([data.reload(), p.reload()]);
        return true;
      }
      if (i < tries - 1) await wait(2500);
    }
    return false;
  };

  // Back from a Cashfree redirect (in-app browsers cannot use the popup).
  useEffect(() => {
    const url = new URL(window.location.href);
    const orderId = url.searchParams.get("cf_order");
    if (!orderId) return;
    url.searchParams.delete("cf_order");
    window.history.replaceState(null, "", url.toString());
    void run(async () => {
      if (!(await confirm(orderId, 4))) toast("We have not received this payment yet. If money left your account, it will show here once the bank confirms.", "info");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const payOnline = (invoice: any) => run(async () => {
    const order = await api<{ orderId: string; paymentSessionId: string; mode: "sandbox" | "production" }>(`${p.base}/billing/invoices/${invoice.id}/checkout`, { method: "POST" });
    await loadCashfree();
    const cashfree = (window as any).Cashfree({ mode: order.mode });
    const result = await cashfree.checkout({ paymentSessionId: order.paymentSessionId, redirectTarget: "_modal" });
    if (result?.redirect) return; // the page is navigating to Cashfree; the return URL confirms it
    // Never trust the browser result: the server checks the order with Cashfree.
    const paid = await confirm(order.orderId, result?.paymentDetails ? 4 : 1);
    if (!paid && result?.paymentDetails) toast("Payment is being confirmed by the bank. This page will update once it is received.", "info");
  });

  return (
    <>
      <PageHeader title="Subscription" description={`Your ${p.product.name} plan, renewal dates and SmartAutoFlex invoices.`} />
      <Loadable state={data}>
        {(d) => {
          const s = d.subscription;
          const growth = d.plans.find((x) => x.tier === "GROWTH");
          const due = d.invoices.filter((i) => i.status === "ISSUED");
          return (
            <div className="space-y-4">
              {s && s.state !== "ACTIVE" && (
                <Notice tone={s.state === "GRACE" ? "warn" : "bad"} title={s.state === "GRACE" ? "Subscription expired - grace period" : `Subscription ${s.state.toLowerCase()}`}>
                  {s.state === "GRACE" ? `Access continues until ${fmtDate(s.graceEndsAt)}. Pay the renewal invoice below to avoid interruption.` : "Pay the outstanding invoice or contact SmartAutoFlex support to restore access."}
                </Notice>
              )}
              <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
                <Card title="Current plan" actions={s && <StatusBadge value={s.state} label={s.state === "GRACE" ? "Grace period" : undefined} />}>
                  {s ? (
                    <>
                      <KeyValue items={[
                        ["Plan", <span key="p" className="font-semibold">{p.product.name} {s.planName}</span>],
                        ["Billing", s.billingCycle === "MONTHLY" ? "Monthly maintenance" : "Annual advance payment"],
                        ["Started", fmtDate(s.startDate)],
                        [s.state === "ACTIVE" ? "Renews on" : "Expired on", <span key="e">{fmtDate(s.currentPeriodEnd)}{s.state === "ACTIVE" && <span className="text-slate-500"> ({Math.max(0, s.daysLeft)} days left)</span>}</span>],
                        ...(s.pendingTier || s.pendingBillingCycle ? [["Scheduled change", `${s.pendingTier ? humanize(s.pendingTier) : s.planName}${s.pendingBillingCycle ? `, ${s.pendingBillingCycle.toLowerCase()} billing` : ""} from the next renewal`] as [string, string]] : []),
                      ]} />
                      <div className="mt-4 flex flex-wrap gap-2">
                        {s.tier === "BASIC" && growth && <Button variant="primary" onClick={() => setRequest("UPGRADE")}>Upgrade to {growth.name}</Button>}
                        <Button onClick={() => setRequest("RENEWAL")}>Request renewal</Button>
                        <Button onClick={() => setRequest("BILLING_CYCLE")}>Change billing cycle</Button>
                        {s.tier === "GROWTH" && <Button variant="ghost" onClick={() => setRequest("DOWNGRADE")}>Request downgrade</Button>}
                      </div>
                    </>
                  ) : <Empty title="No subscription" />}
                </Card>
                <Card title="SmartAutoFlex support">
                  <ul className="space-y-2 text-sm text-slate-700">
                    {d.support.phone && <li className="flex items-center gap-2"><Phone className="h-4 w-4 text-slate-500" /> <a className="underline" href={`tel:${d.support.phone}`}>{d.support.phone}</a></li>}
                    {d.support.whatsapp && <li className="flex items-center gap-2"><MessageCircle className="h-4 w-4 text-slate-500" /> <a className="underline" href={`https://wa.me/${d.support.whatsapp.replace(/\D/g, "")}`} target="_blank" rel="noreferrer">WhatsApp</a></li>}
                    {d.support.email && <li className="flex items-center gap-2"><Mail className="h-4 w-4 text-slate-500" /> <a className="underline" href={`mailto:${d.support.email}`}>{d.support.email}</a></li>}
                    <li><a className="font-medium text-brand underline" href={`${p.base}/support`}>Raise a support ticket</a></li>
                  </ul>
                </Card>
              </div>

              <Card pad={false} title="Invoices from SmartAutoFlex" subtitle={due.length ? `${due.length} unpaid - ${formatINR(due.reduce((a, i) => a + i.total - i.paidAmount, 0))} due` : "All paid"}>
                <DataTable
                  rows={d.invoices} rowKey={(r) => r.id} empty={<Empty title="No invoices yet" />}
                  columns={[
                    { key: "no", label: "Invoice", render: (r) => <span className="font-mono text-[13px]">{r.invoiceNo}</span> },
                    { key: "date", label: "Date", render: (r) => fmtDate(r.createdAt) },
                    { key: "desc", label: "Description", render: (r) => <span className="block max-w-sm whitespace-normal">{r.description}{r.periodEnd && <span className="block text-xs text-slate-500">{fmtDate(r.periodStart)} to {fmtDate(r.periodEnd)}</span>}</span> },
                    { key: "total", label: "Total (incl. GST)", align: "right", render: (r) => formatINR(r.total) },
                    { key: "st", label: "Status", render: (r) => <StatusBadge value={r.status} label={r.status === "ISSUED" ? (r.paidAmount ? "Part paid" : "Unpaid") : undefined} /> },
                    { key: "act", label: "", align: "right", render: (r) => r.status === "ISSUED" && d.onlinePayments && <Button size="sm" variant="primary" loading={busy} onClick={() => payOnline(r)}>Pay {formatINR(r.total - r.paidAmount)}</Button> },
                  ]}
                />
                {!d.onlinePayments && due.length > 0 && <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-600">To pay, contact SmartAutoFlex support. Your payment will be recorded against the invoice.</p>}
              </Card>

              <div>
                <h2 className="mb-2 text-sm font-semibold text-slate-900">Plans for {p.product.name}</h2>
                <PlanCompare plans={d.plans} features={d.features} currentTier={s?.tier} gstRateBp={d.gstRateBp} />
              </div>
            </div>
          );
        }}
      </Loadable>
      <FormModal
        open={!!request} title={request === "UPGRADE" ? "Request an upgrade" : request === "RENEWAL" ? "Request renewal" : request === "DOWNGRADE" ? "Request a downgrade" : "Change billing cycle"}
        fields={{
          ...(request === "BILLING_CYCLE" || request === "RENEWAL" ? { billingCycle: f.select("Billing cycle", ["MONTHLY", "ANNUAL"], { required: true, default: "ANNUAL" }) } : {}),
          message: f.textarea("Message to SmartAutoFlex (optional)", { max: 1000 }),
        }}
        submitLabel="Send request" onClose={() => setRequest(null)}
        onSubmit={async (v) => {
          const r = await api<{ ticketNo: number }>(`${p.base}/subscription/request`, { body: { type: request, billingCycle: v.billingCycle ?? undefined, message: v.message ?? undefined } });
          toast(`Request sent - ticket #${r.ticketNo}`);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

const TICKET_FIELDS = {
  subject: f.text("Subject", { required: true, max: 150 }),
  category: f.select("Category", ["GENERAL", "TECHNICAL", "BILLING", "SUBSCRIPTION", "FEATURE_REQUEST"], { required: true, default: "GENERAL" }),
  priority: f.select("Priority", ["LOW", "NORMAL", "HIGH", "URGENT"], { required: true, default: "NORMAL" }),
  body: f.textarea("Describe the issue", { required: true, max: 4000 }),
};

export function TicketThread({ path, replyPath, onChanged }: { path: string; replyPath: string; onChanged?: () => void }) {
  const t = useApi<any>(path, { refreshMs: 30_000 });
  const [body, setBody] = useState("");
  const [busy, run] = useAction();
  return (
    <Loadable state={t}>
      {(d) => (
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-900">#{d.ticketNo} {d.subject}</h3>
            <StatusBadge value={d.status} /><Badge>{humanize(d.category)}</Badge><StatusBadge value={d.priority} />
          </div>
          <ul className="space-y-2">
            {d.messages.map((m: any) => (
              <li key={m.id} className={`rounded-lg border px-3 py-2 text-sm ${m.fromSaf ? "border-brand/20 bg-brand-soft" : "border-slate-200 bg-white"}`}>
                <p className="text-xs text-slate-500"><span className="font-semibold text-slate-800">{m.authorName}</span> - {fmtDateTime(m.createdAt)}</p>
                <p className="mt-1 whitespace-pre-wrap text-slate-800">{m.body}</p>
              </li>
            ))}
          </ul>
          {d.status !== "CLOSED" && (
            <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) void run(async () => { await api(replyPath, { body: { body } }); setBody(""); await t.reload(); onChanged?.(); }); }}>
              <Textarea aria-label="Reply" rows={2} placeholder="Write a reply..." value={body} onChange={(e) => setBody(e.target.value)} />
              <Button type="submit" variant="primary" loading={busy} aria-label="Send reply"><Send className="h-4 w-4" /></Button>
            </form>
          )}
        </div>
      )}
    </Loadable>
  );
}

export function SupportScreen() {
  const p = useProduct();
  const tickets = useApi<any[]>(`${p.base}/support/tickets`);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Support" description="Get help from the SmartAutoFlex team." actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New ticket</Button>} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,24rem)_1fr]">
        <Card pad={false} title="Your tickets">
          <Loadable state={tickets}>
            {(d) => !d.length ? <Empty title="No tickets yet" hint="Raise a ticket and our team will reply here." /> : (
              <ul className="divide-y divide-slate-100">
                {d.map((t) => (
                  <li key={t.id}>
                    <button onClick={() => setOpen(t.id)} className={`w-full px-4 py-3 text-left hover:bg-slate-50 ${open === t.id ? "bg-brand-soft" : ""}`}>
                      <span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium text-slate-900">#{t.ticketNo} {t.subject}</span><StatusBadge value={t.status} /></span>
                      <span className="mt-0.5 block text-xs text-slate-500">{fmtDateTime(t.updatedAt)} - {t._count.messages} message{t._count.messages === 1 ? "" : "s"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Loadable>
        </Card>
        <Card>
          {open ? <TicketThread key={open} path={`${p.base}/support/tickets/${open}`} replyPath={`${p.base}/support/tickets/${open}/messages`} onChanged={() => void tickets.reload()} /> : <Empty title="Select a ticket" hint="Choose a ticket to read the conversation." />}
        </Card>
      </div>
      <FormModal open={creating} title="New support ticket" fields={TICKET_FIELDS} submitLabel="Send" onClose={() => setCreating(false)}
        onSubmit={async (v) => { const t = await api<any>(`${p.base}/support/tickets`, { body: v }); toast("Ticket raised"); await tickets.reload(); setOpen(t.id); }} />
    </>
  );
}
