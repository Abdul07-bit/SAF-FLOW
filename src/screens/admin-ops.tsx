"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { fmtDateTime } from "@/lib/dates";
import { api, qs, useApi } from "@/lib/client";
import { humanize } from "@/shared/fields";
import { Badge, Button, Card, DataTable, Empty, Field, Input, KeyValue, Loadable, Modal, Notice, PageHeader, Select, StatusBadge, Textarea, toast, useAction } from "@/components/ui";
import { TicketThread } from "./shared-account";
import { Pager, ProductFilter, SearchBox, UserActions, productShort, useDebounced } from "./admin-shared";

const linkCls = "font-medium text-brand underline-offset-2 hover:underline";

function AccountStatus({ u }: { u: any }) {
  const locked = u.lockedUntil && new Date(u.lockedUntil) > new Date();
  return (
    <span className="flex flex-wrap gap-1">
      <StatusBadge value={u.isActive ? "ACTIVE" : "INACTIVE"} label={u.isActive ? "Active" : "Disabled"} />
      {u.mustChangePassword && <Badge tone="warn">Temp password</Badge>}
      {locked && <Badge tone="bad">Locked</Badge>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Manager accounts
// ---------------------------------------------------------------------------

export function AdminManagers() {
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const list = useApi<any[]>(`/admin/managers${qs({ q: dq })}`);
  return (
    <>
      <PageHeader title="Manager accounts" description="The owner login of each business. One manager account opens every product the business subscribes to." actions={<SearchBox value={q} onChange={setQ} placeholder="Login ID or name" label="Search managers" />} />
      <Card pad={false}>
        <Loadable state={list}>
          {(d) => (
            <DataTable
              rows={d} rowKey={(r) => r.id} empty={<Empty title={dq ? "No managers match" : "No manager accounts yet"} hint="A manager account is generated when you add a business." />}
              columns={[
                { key: "u", label: "Login ID", render: (r) => <span className="font-mono text-[13px]">{r.username}</span> },
                { key: "n", label: "Name", render: (r) => <span className="block">{r.fullName}<span className="block text-xs text-slate-500">{[r.phone, r.email].filter(Boolean).join(" - ")}</span></span> },
                { key: "b", label: "Business", render: (r) => r.tenantId ? <Link className={linkCls} href={`/admin/businesses/${r.tenantId}`}>{r.business ?? r.code}</Link> : "-" },
                { key: "p", label: "Products", render: (r) => <span className="flex flex-wrap gap-1">{r.products.map((c: string) => <Badge key={c}>{productShort(c)}</Badge>)}</span> },
                { key: "l", label: "Last sign-in", render: (r) => (r.lastLoginAt ? fmtDateTime(r.lastLoginAt) : "Never") },
                { key: "s", label: "Status", render: (r) => <AccountStatus u={r} /> },
                { key: "x", label: "", align: "right", render: (r) => <UserActions user={r} onChanged={() => void list.reload()} /> },
              ]}
            />
          )}
        </Loadable>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Employee overview
// ---------------------------------------------------------------------------

export function AdminEmployees() {
  const [q, setQ] = useState("");
  const [product, setProduct] = useState("");
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, product]);
  const list = useApi<{ items: any[]; total: number; summary: { product: string; role: string; count: number }[] }>(`/admin/employees${qs({ q: dq, product, page, pageSize: 50 })}`);
  return (
    <>
      <PageHeader
        title="Employee overview" description="Every login across all businesses, with the role held in each product."
        actions={<><SearchBox value={q} onChange={setQ} placeholder="Login ID or name" label="Search employees" /><ProductFilter value={product} onChange={setProduct} /></>}
      />
      <Loadable state={list}>
        {(d) => (
          <>
            <Card className="mb-4" title="Active role assignments" subtitle="Across all businesses">
              {!d.summary.length ? <p className="text-sm text-slate-500">No staff yet.</p> : (
                <ul className="flex flex-wrap gap-2">
                  {[...d.summary].sort((a, b) => a.product.localeCompare(b.product) || b.count - a.count).map((s) => (
                    <li key={`${s.product}-${s.role}`} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm"><span className="text-slate-500">{productShort(s.product)}</span> <span className="font-medium text-slate-900">{s.role}</span> <span className="tnum font-semibold">{s.count}</span></li>
                  ))}
                </ul>
              )}
            </Card>
            <Card pad={false}>
              <DataTable
                rows={d.items} rowKey={(r) => r.id} empty={<Empty title="No accounts match these filters" />}
                columns={[
                  { key: "u", label: "Login ID", render: (r) => <span className="font-mono text-[13px]">{r.username}</span> },
                  { key: "n", label: "Name", render: (r) => <span>{r.fullName} {r.isTenantOwner && <Badge tone="brand">Manager</Badge>}</span> },
                  { key: "b", label: "Business", render: (r) => r.tenantId ? <Link className={linkCls} href={`/admin/businesses/${r.tenantId}`}>{r.business ?? r.code}</Link> : "-" },
                  { key: "a", label: "Roles", render: (r) => <span className="flex flex-wrap gap-1">{r.access.length ? r.access.map((a: any) => <Badge key={a.product} tone={a.isActive ? "neutral" : "bad"}>{productShort(a.product)}: {a.role}</Badge>) : <span className="text-slate-400">No product access</span>}</span> },
                  { key: "l", label: "Last sign-in", render: (r) => (r.lastLoginAt ? fmtDateTime(r.lastLoginAt) : "Never") },
                  { key: "s", label: "Status", render: (r) => <AccountStatus u={r} /> },
                  { key: "x", label: "", align: "right", render: (r) => <UserActions user={r} onChanged={() => void list.reload()} /> },
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

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

export function AdminSupport() {
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const tickets = useApi<any[]>(`/admin/support/tickets${qs({ status })}`, { refreshMs: 60_000 });
  const [busy, run] = useAction();
  const current = tickets.data?.find((t) => t.id === open);
  const patch = (body: Record<string, string>) => run(async () => { await api(`/admin/support/tickets/${open}`, { method: "PATCH", body }); await tickets.reload(); }, "Ticket updated");
  return (
    <>
      <PageHeader
        title="Support" description="Tickets and activation / upgrade requests raised by businesses."
        actions={<Select aria-label="Status" className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All tickets</option>{["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>}
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_1fr]">
        <Card pad={false} title="Tickets">
          <Loadable state={tickets}>
            {(d) => !d.length ? <Empty title="No tickets" hint="Requests from businesses appear here." /> : (
              <ul className="max-h-[70vh] divide-y divide-slate-100 overflow-y-auto">
                {d.map((t) => (
                  <li key={t.id}>
                    <button onClick={() => setOpen(t.id)} className={`w-full px-4 py-3 text-left hover:bg-slate-50 ${open === t.id ? "bg-brand-soft" : ""}`}>
                      <span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium text-slate-900">#{t.ticketNo} {t.subject}</span><StatusBadge value={t.status} /></span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                        <span>{t.business ?? t.code}</span>{t.productCode && <span>{productShort(t.productCode)}</span>}<span>{humanize(t.category)}</span>
                        {(t.priority === "HIGH" || t.priority === "URGENT") && <StatusBadge value={t.priority} />}
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-400">{fmtDateTime(t.updatedAt)} - {t.messages} message{t.messages === 1 ? "" : "s"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Loadable>
        </Card>
        <Card>
          {!open ? <Empty title="Select a ticket" hint="Choose a ticket to read and reply." /> : (
            <>
              {current && (
                <div className="mb-4 flex flex-wrap items-end gap-3 border-b border-slate-100 pb-3">
                  <p className="min-w-0 flex-1 text-sm text-slate-600">From <Link className={linkCls} href={`/admin/businesses/${current.tenantId}`}>{current.business ?? current.code}</Link></p>
                  <Field label="Status"><Select className="!h-9 w-36" disabled={busy} value={current.status} onChange={(e) => patch({ status: e.target.value })}>{["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></Field>
                  <Field label="Priority"><Select className="!h-9 w-32" disabled={busy} value={current.priority} onChange={(e) => patch({ priority: e.target.value })}>{["LOW", "NORMAL", "HIGH", "URGENT"].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></Field>
                </div>
              )}
              <TicketThread key={`${open}-${current?.status}`} path={`/admin/support/tickets/${open}`} replyPath={`/admin/support/tickets/${open}/messages`} onChanged={() => void tickets.reload()} />
            </>
          )}
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------------

export function AdminAudit() {
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<any | null>(null);
  const dq = useDebounced(q);
  const da = useDebounced(action);
  useEffect(() => setPage(1), [dq, da, from, to]);
  const list = useApi<{ items: any[]; total: number }>(`/admin/audit-logs${qs({ q: dq, action: da, from, to, page, pageSize: 50 })}`);
  return (
    <>
      <PageHeader title="Audit logs" description="Sign-ins, account changes, subscription and billing actions, and every data change made through the API." />
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Actor or record ID" label="Search audit log" />
        <Input aria-label="Action contains" className="w-52" placeholder="Action, e.g. login, subscription" value={action} onChange={(e) => setAction(e.target.value)} />
        <Input aria-label="From date" type="date" className="w-40" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-sm text-slate-500">to</span>
        <Input aria-label="To date" type="date" className="w-40" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
      </div>
      <Card pad={false}>
        <Loadable state={list}>
          {(d) => (
            <>
              <DataTable
                rows={d.items} rowKey={(r) => String(r.id)} dense onRowClick={setDetail} empty={<Empty title="No audit entries match these filters" />}
                columns={[
                  { key: "t", label: "Time", render: (r) => fmtDateTime(r.createdAt) },
                  { key: "a", label: "Actor", render: (r) => r.actorName ?? "System" },
                  { key: "ac", label: "Action", render: (r) => <span className="font-mono text-[12px]">{r.action}</span> },
                  { key: "e", label: "Record", render: (r) => (r.entityType ? <span>{r.entityType}{r.entityId && <span className="ml-1 font-mono text-[11px] text-slate-500">{String(r.entityId).slice(0, 8)}</span>}</span> : "-") },
                  { key: "b", label: "Business", render: (r) => (r.tenantCode ? <span className="font-mono text-[12px]">{r.tenantCode}</span> : "Platform") },
                  { key: "p", label: "Product", render: (r) => (r.productCode ? productShort(r.productCode) : "-") },
                  { key: "ip", label: "IP", render: (r) => <span className="font-mono text-[12px]">{r.ip ?? "-"}</span> },
                ]}
              />
              <Pager page={page} pageSize={50} total={d.total} onPage={setPage} />
            </>
          )}
        </Loadable>
      </Card>
      <Modal open={!!detail} title="Audit entry" onClose={() => setDetail(null)}>
        {detail && (
          <>
            <KeyValue items={[
              ["Time", fmtDateTime(detail.createdAt)], ["Actor", detail.actorName ?? "System"], ["Action", <span key="a" className="font-mono text-[13px]">{detail.action}</span>],
              ["Record", detail.entityType ? `${detail.entityType} ${detail.entityId ?? ""}` : null], ["Business", detail.tenantCode ?? "Platform"],
              ["Product", detail.productCode ? productShort(detail.productCode) : null], ["IP address", detail.ip], ["Device", detail.userAgent],
            ]} />
            {detail.meta && <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-slate-50 p-3 text-xs text-slate-800">{JSON.stringify(detail.meta, null, 2)}</pre>}
          </>
        )}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Global settings
// ---------------------------------------------------------------------------

interface Settings {
  platformName: string; supportPhone: string; supportEmail: string; supportWhatsApp: string; companyAddress: string; companyGstin: string;
  invoicePrefix: string; gstRateBp: number; reminderDays: number[]; invoiceDueDays: number; upiId: string; upiPayeeName: string;
}

function Flag({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className="flex items-center gap-1.5">{ok ? <CheckCircle2 className="h-4 w-4 text-emerald-700" aria-hidden /> : <XCircle className="h-4 w-4 text-slate-400" aria-hidden />}{children}</span>;
}

export function AdminSettings() {
  const data = useApi<{ settings: Settings; integrations: { storage: string; appUrl: string; cronConfigured: boolean } }>("/admin/settings");
  const [form, setForm] = useState<Record<string, string | boolean> | null>(null);
  const [busy, run] = useAction();
  const [jobBusy, runJob] = useAction();

  useEffect(() => {
    if (data.data && !form) {
      const { gstRateBp, reminderDays, invoiceDueDays, ...rest } = data.data.settings;
      setForm({ ...rest, gstRatePct: String(gstRateBp / 100), reminderDays: reminderDays.join(", "), invoiceDueDays: String(invoiceDueDays) });
    }
  }, [data.data, form]);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const reminderDays = String(form.reminderDays).split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 0);
    void run(async () => {
      await api("/admin/settings", {
        method: "PUT",
        body: {
          platformName: form.platformName, supportPhone: form.supportPhone, supportEmail: form.supportEmail, supportWhatsApp: form.supportWhatsApp,
          companyAddress: form.companyAddress, companyGstin: form.companyGstin, invoicePrefix: form.invoicePrefix,
          gstRateBp: Math.round(Number(form.gstRatePct) * 100), reminderDays: [...new Set(reminderDays)].sort((a, b) => b - a),
          invoiceDueDays: Number(form.invoiceDueDays), upiId: String(form.upiId).trim(), upiPayeeName: String(form.upiPayeeName).trim(),
        },
      });
      await data.reload();
    }, "Settings saved");
  };

  const text = (k: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => <Input value={String(form?.[k] ?? "")} onChange={(e) => setForm((s) => ({ ...s!, [k]: e.target.value }))} {...props} />;

  return (
    <>
      <PageHeader title="Global settings" description="Platform identity, SAF invoicing, renewal reminders and integrations." />
      <Loadable state={data}>
        {(d) => !form ? null : (
          <div className="grid gap-4 xl:grid-cols-[1fr_24rem]">
            <form onSubmit={save} className="space-y-4">
              <Card title="Platform & support contact" subtitle="Shown to businesses on their subscription and support pages.">
                <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                  <Field label="Platform name" required>{text("platformName", { required: true, minLength: 2, maxLength: 80 })}</Field>
                  <Field label="Support phone">{text("supportPhone", { type: "tel", maxLength: 30 })}</Field>
                  <Field label="Support email">{text("supportEmail", { type: "email", maxLength: 120 })}</Field>
                  <Field label="Support WhatsApp number" help="With country code, e.g. 919876543210">{text("supportWhatsApp", { maxLength: 30 })}</Field>
                </div>
              </Card>
              <Card title="Invoicing" subtitle="Printed on invoices SAF raises for setup fees and subscriptions.">
                <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                  <Field label="Company address" className="sm:col-span-2"><Textarea rows={2} maxLength={300} value={String(form.companyAddress)} onChange={(e) => setForm((s) => ({ ...s!, companyAddress: e.target.value }))} /></Field>
                  <Field label="Company GSTIN">{text("companyGstin", { maxLength: 20 })}</Field>
                  <Field label="Invoice number prefix" required>{text("invoicePrefix", { required: true, maxLength: 10 })}</Field>
                  <Field label="GST on SAF invoices (%)" required>{text("gstRatePct", { type: "number", required: true, min: 0, max: 50, step: "0.01" })}</Field>
                  <Field label="Payment terms (days)" required help="Days from invoice date to due date.">{text("invoiceDueDays", { type: "number", required: true, min: 0, max: 60, step: 1 })}</Field>
                </div>
              </Card>
              <Card title="Renewals" subtitle="Grace periods are set per plan under Plans and pricing.">
                <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                  <Field label="Renewal reminders (days before expiry)" help="Comma-separated, up to 6. The renewal invoice is raised at the earliest reminder.">{text("reminderDays", { placeholder: "15, 7, 3, 1" })}</Field>
                </div>
              </Card>
              <Card title="UPI payments" subtitle="Businesses scan a QR for this UPI ID, pay, and upload the receipt. You approve it under Payments.">
                <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                  <Field label="UPI ID" help="Leave empty to hide UPI payment from businesses.">{text("upiId", { maxLength: 320, placeholder: "name@okicici", autoComplete: "off" })}</Field>
                  <Field label="Account holder name" help="Shown in the payer's UPI app.">{text("upiPayeeName", { maxLength: 60 })}</Field>
                </div>
              </Card>
              <Button type="submit" variant="primary" loading={busy}>Save settings</Button>
            </form>

            <div className="space-y-4">
              <Card title="Integrations" subtitle="Configured through environment variables on the server.">
                <ul className="space-y-2 text-sm text-slate-800">
                  <li><Flag ok={!!d.settings.upiId}>UPI payments {d.settings.upiId ? <span className="font-mono text-[13px]">{d.settings.upiId}</span> : "off (no UPI ID)"}</Flag></li>
                  <li><Flag ok={d.integrations.cronConfigured}>Scheduled renewal job {d.integrations.cronConfigured ? "secured" : "secret not set"}</Flag></li>
                  <li><Flag ok>File storage: {d.integrations.storage}</Flag></li>
                  <li><Flag ok={!!d.integrations.appUrl}>Public URL: <span className="font-mono text-[13px]">{d.integrations.appUrl || "not set"}</span></Flag></li>
                </ul>
              </Card>
              <Card title="Renewal job" subtitle="Runs automatically every 6 hours in the Docker deployment.">
                <p className="text-sm text-slate-600">Expires lapsed subscriptions after their grace period, applies scheduled plan changes, raises renewal invoices and sends reminders.</p>
                <Button className="mt-3" loading={jobBusy} onClick={() => runJob(async () => { const r = await api<any>("/admin/jobs/renewals", { method: "POST" }); toast(`${r.expired} expired, ${r.invoicesRaised} invoice(s) raised, ${r.reminders} reminder(s)`); })}><RefreshCw className="h-4 w-4" /> Run now</Button>
              </Card>
              <Card title="API documentation">
                <p className="text-sm text-slate-600">OpenAPI 3.1 description generated from the live route registry, including each endpoint&apos;s authorization policy.</p>
                <a className={`mt-2 inline-block text-sm ${linkCls}`} href="/api/docs/openapi.json" target="_blank" rel="noreferrer">Open openapi.json</a>
              </Card>
            </div>
          </div>
        )}
      </Loadable>
    </>
  );
}

type HealthStatus = "ok" | "warn" | "down";
interface Health {
  overall: HealthStatus;
  checkedAt: string;
  checks: Record<string, { status: HealthStatus; detail: string }>;
  identityLatencyMs: number | null;
  lastRenewalAt: string | null;
  migrations: { count: number; latest: string | null; latestAt: string | null } | null;
  runtime: { node: string; env: string; uptimeSec: number; rssMb: number; heapMb: number };
  counts: { tenants: Record<string, number>; pendingInvites: number; expiredInvites: number; lockedUsers: number; liveSessions: number };
}

const CHECK_LABELS: Record<string, string> = {
  database: "Database", identity: "Sign-in service (Supabase Auth)", storage: "File storage", renewals: "Renewal job", payments: "Online payments", appUrl: "Public address",
};
const HEALTH_TONE = { ok: "good", warn: "warn", down: "bad" } as const;
const HEALTH_LABEL = { ok: "Healthy", warn: "Needs attention", down: "Down" } as const;

function uptime(sec: number) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export function AdminSystemHealth() {
  const h = useApi<Health>("/admin/system/health", { refreshMs: 60_000 });
  return (
    <>
      <PageHeader
        title="System health" description="Live status of the services SAF Flow depends on. Refreshes every minute."
        actions={<Button onClick={() => void h.reload()}><RefreshCw className="h-4 w-4" aria-hidden /> Check now</Button>}
      />
      <Loadable state={h}>
        {(d) => (
          <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
            <div className="space-y-4">
              <Notice tone={d.overall === "ok" ? "good" : d.overall === "warn" ? "warn" : "bad"} title={d.overall === "ok" ? "All systems healthy" : d.overall === "warn" ? "Running, with items to fix" : "A service is down"}>
                Checked {fmtDateTime(d.checkedAt)}.
              </Notice>
              <Card pad={false} title="Checks">
                <ul className="divide-y divide-slate-100">
                  {Object.entries(d.checks).map(([k, c]) => (
                    <li key={k} className="flex items-start gap-3 px-4 py-3">
                      {c.status === "ok"
                        ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
                        : <XCircle className={`mt-0.5 h-5 w-5 shrink-0 ${c.status === "warn" ? "text-amber-500" : "text-red-600"}`} aria-hidden />}
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">{CHECK_LABELS[k] ?? humanize(k)} <Badge tone={HEALTH_TONE[c.status]}>{HEALTH_LABEL[c.status]}</Badge></p>
                        <p className="mt-0.5 break-words text-sm text-slate-600">{c.detail}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
            <div className="space-y-4">
              <Card title="Activity">
                <KeyValue items={[
                  ["Active businesses", String(d.counts.tenants.ACTIVE ?? 0)],
                  ["Suspended", String(d.counts.tenants.SUSPENDED ?? 0)],
                  ["Signed-in sessions", String(d.counts.liveSessions)],
                  ["Pending invitations", String(d.counts.pendingInvites)],
                  ["Expired invitations", d.counts.expiredInvites ? <Badge tone="warn">{d.counts.expiredInvites}</Badge> : "0"],
                  ["Locked accounts", d.counts.lockedUsers ? <Badge tone="warn">{d.counts.lockedUsers}</Badge> : "0"],
                  ["Last renewal run", d.lastRenewalAt ? fmtDateTime(d.lastRenewalAt) : "Never"],
                ]} />
              </Card>
              <Card title="Server">
                <KeyValue items={[
                  ["Environment", d.runtime.env],
                  ["Node.js", d.runtime.node],
                  ["Uptime", uptime(d.runtime.uptimeSec)],
                  ["Memory", `${d.runtime.rssMb} MB (heap ${d.runtime.heapMb} MB)`],
                  ...(d.identityLatencyMs !== null ? [["Supabase latency", `${d.identityLatencyMs} ms`] as [string, string]] : []),
                  ...(d.migrations ? [["Migrations", `${d.migrations.count} applied`] as [string, string], ["Latest", <span key="m" className="break-all font-mono text-xs">{d.migrations.latest ?? "-"}</span>] as [string, React.ReactNode]] : []),
                ]} />
              </Card>
            </div>
          </div>
        )}
      </Loadable>
    </>
  );
}
