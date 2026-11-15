"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, ImageUp, Pencil, Plus, PlusCircle, RefreshCw, XCircle } from "lucide-react";
import { BUSINESS_CATEGORIES, BUSINESS_TYPES, PRODUCTS, PRODUCT_CODES, businessType, type ProductCode } from "@/config/catalog";
import { addDays, addMonths, fmtDate, fmtDateTime } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { api, errorMessage, qs, useApi } from "@/lib/client";
import { f, humanize } from "@/shared/fields";
import { FormModal } from "@/components/forms";
import { KpiRow, StatTile } from "@/components/charts";
import { Badge, Button, Card, DataTable, Empty, Field, Input, KeyValue, Loadable, Notice, PageHeader, Select, StatusBadge, Tabs, Textarea, toast, useAction } from "@/components/ui";
import { BusinessTeamCard, useMyPlatform } from "./admin-team";
import {
  CopyButton, Credentials, EventList, InvoiceStatus, PAYMENT_METHODS, Pager, ProductChips, ProductFilter, RecordPaymentModal, SearchBox, SubscriptionActions,
  SubscriptionState, UserActions, clean, cycleLabel, productName, productShort, useDebounced, type AdminSub,
} from "./admin-shared";

const linkCls = "font-medium text-brand underline-offset-2 hover:underline";

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function AdminOverview() {
  const o = useApi<any>("/admin/overview", { refreshMs: 120_000 });
  const mine = useMyPlatform();
  const has = (k: string) => !!mine.data?.permissions.includes(k);
  const scoped = mine.data?.role && !mine.data.role.allTenants;
  const [busy, run] = useAction();
  const runJob = () => run(async () => {
    const r = await api<{ expired: number; invoicesRaised: number; reminders: number }>("/admin/jobs/renewals", { method: "POST" });
    toast(`Renewal job done: ${r.expired} expired, ${r.invoicesRaised} invoice(s) raised, ${r.reminders} reminder(s)`);
    await o.reload();
  });
  return (
    <>
      <PageHeader
        title="Overview" description={scoped ? "Your assigned businesses at a glance." : "Every business, product and subscription on SAF Flow."}
        actions={<>
          {has("platform.jobs.run") && <Button loading={busy} onClick={runJob}><RefreshCw className="h-4 w-4" /> Run renewal job</Button>}
          {has("platform.business.create") && <Link href="/admin/businesses/new"><Button variant="primary"><PlusCircle className="h-4 w-4" /> Add new business</Button></Link>}
        </>}
      />
      <Loadable state={o}>
        {(d) => (
          <>
            <KpiRow cols={4}>
              <StatTile label="Registered businesses" value={d.totalBusinesses} sub={d.suspendedBusinesses ? `${d.suspendedBusinesses} suspended` : "All in good standing"} />
              <StatTile label="Active subscriptions" value={d.activeSubscriptions} sub={d.graceSubscriptions ? `${d.graceSubscriptions} in grace period` : undefined} />
              <StatTile label="Basic customers" value={d.basicCustomers} />
              <StatTile label="Growth customers" value={d.growthCustomers} />
            </KpiRow>
            <KpiRow cols={3}>
              {PRODUCT_CODES.map((c) => <StatTile key={c} label={`${PRODUCTS[c].name} customers`} value={d.productCustomers[c] ?? 0} />)}
            </KpiRow>
            <KpiRow cols={4}>
              <StatTile label="Monthly recurring revenue" value={formatINR(d.mrr, { whole: true })} sub="Annual plans counted at 1/12" />
              <StatTile label="Annual prepaid revenue" value={formatINR(d.annualPrepaidRevenue, { whole: true })} sub={`Paid, FY ${d.financialYear}, excl. GST`} />
              <StatTile label="Setup revenue" value={formatINR(d.setupRevenue, { whole: true })} sub={`Paid, FY ${d.financialYear}, excl. GST`} />
              <StatTile label="Outstanding invoices" value={formatINR(d.outstandingAmount, { whole: true })} sub={`${d.outstandingInvoices} unpaid`} tone={d.outstandingInvoices ? "warn" : undefined} />
            </KpiRow>
            <KpiRow cols={3}>
              <StatTile label="Expired subscriptions" value={d.expiredSubscriptions} tone={d.expiredSubscriptions ? "bad" : undefined} sub={<Link className={linkCls} href="/admin/subscriptions?state=EXPIRED">View expired</Link>} />
              <StatTile label="Upcoming renewals (30 days)" value={d.upcomingRenewals.length} sub={<Link className={linkCls} href="/admin/subscriptions?state=EXPIRING">View all</Link>} />
              <StatTile label="Suspended subscriptions" value={d.suspendedSubscriptions} />
            </KpiRow>

            <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
              <Card pad={false} title="Upcoming renewals" subtitle="Active subscriptions expiring in the next 30 days">
                <DataTable
                  rows={d.upcomingRenewals} rowKey={(r: any) => r.subscriptionId} dense
                  empty={<Empty title="No renewals due in the next 30 days" />}
                  columns={[
                    { key: "b", label: "Business", render: (r: any) => <Link className={linkCls} href={`/admin/businesses/${r.tenantId}`}>{r.business}</Link> },
                    { key: "p", label: "Product", render: (r: any) => <span>{productShort(r.product)} <Badge tone={r.tier === "GROWTH" ? "brand" : "neutral"}>{humanize(r.tier)}</Badge></span> },
                    { key: "c", label: "Billing", render: (r: any) => cycleLabel(r.billingCycle) },
                    { key: "e", label: "Expires", render: (r: any) => <span>{fmtDate(r.expiresAt)} <span className="text-xs text-slate-500">({Math.max(0, r.daysLeft)}d)</span></span> },
                    { key: "a", label: "Renewal", align: "right", render: (r: any) => formatINR(r.renewalPrice, { whole: true }) },
                    { key: "ph", label: "Phone", render: (r: any) => r.phone ?? "-" },
                  ]}
                />
              </Card>
              <Card pad={false} title="Recently added businesses" actions={<Link className={`text-xs ${linkCls}`} href="/admin/businesses">All businesses</Link>}>
                {!d.recentBusinesses.length ? <Empty title="No businesses yet" hint="Add the first business to get started." /> : (
                  <ul className="divide-y divide-slate-100">
                    {d.recentBusinesses.map((b: any) => (
                      <li key={b.id} className="px-4 py-2.5">
                        <Link href={`/admin/businesses/${b.id}`} className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-medium text-slate-900">{b.name} <span className="font-mono text-xs font-normal text-slate-500">{b.code}</span></span>
                          <span className="shrink-0 text-xs text-slate-500">{fmtDate(b.createdAt)}</span>
                        </Link>
                        <div className="mt-1"><ProductChips products={b.products} /></div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </>
        )}
      </Loadable>
    </>
  );
}

// ---------------------------------------------------------------------------
// Business management (list)
// ---------------------------------------------------------------------------

export function AdminBusinesses() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [product, setProduct] = useState("");
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, status, product]);
  const list = useApi<{ items: any[]; total: number }>(`/admin/businesses${qs({ q: dq, status, product, page, pageSize: 25 })}`);
  const mine = useMyPlatform();
  const canCreate = !!mine.data?.permissions.includes("platform.business.create");
  const scoped = mine.data?.role && !mine.data.role.allTenants;
  return (
    <>
      <PageHeader
        title="Businesses" description={scoped ? "The businesses assigned to you. Open one to manage it." : "Every business on SAF Flow. Open a business to manage its products, plans, users and billing."}
        actions={<>
          <SearchBox value={q} onChange={setQ} placeholder="Name, code, owner, phone" label="Search businesses" />
          <ProductFilter value={product} onChange={setProduct} />
          <Select aria-label="Status" className="w-36" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option><option value="CLOSED">Closed</option>
          </Select>
          {canCreate && <Link href="/admin/businesses/new"><Button variant="primary"><Plus className="h-4 w-4" /> Add business</Button></Link>}
        </>}
      />
      <Card pad={false}>
        <Loadable state={list}>
          {(d) => (
            <>
              <DataTable
                rows={d.items} rowKey={(r) => r.id}
                empty={<Empty title={dq || status || product ? "No businesses match these filters" : scoped ? "No businesses assigned to you yet" : "No businesses yet"} hint={scoped ? "Ask an administrator to assign you to a client." : undefined} action={canCreate ? <Link className={linkCls} href="/admin/businesses/new">Add new business</Link> : undefined} />}
                columns={[
                  { key: "n", label: "Business", render: (r) => <Link href={`/admin/businesses/${r.id}`} className="block"><span className={`block ${linkCls}`}>{r.name ?? r.code}</span><span className="text-xs text-slate-500">{businessType(r.category).label}{r.city ? ` - ${r.city}` : ""}</span></Link> },
                  { key: "c", label: "Code", render: (r) => <span className="font-mono text-[13px]">{r.code}</span> },
                  { key: "o", label: "Owner", render: (r) => <span className="block">{r.ownerName}<span className="block text-xs text-slate-500">{r.phone}</span></span> },
                  { key: "p", label: "Products & plans", render: (r) => <ProductChips products={r.products} /> },
                  { key: "u", label: "Users", align: "right", render: (r) => r.users },
                  { key: "s", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
                  { key: "d", label: "Added", render: (r) => fmtDate(r.createdAt) },
                ]}
              />
              <Pager page={page} pageSize={25} total={d.total} onPage={setPage} />
            </>
          )}
        </Loadable>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Add new business
// ---------------------------------------------------------------------------

interface Plan { id: string; productCode: ProductCode; tier: "BASIC" | "GROWTH"; name: string; monthlyPrice: number; annualPrice: number; setupFee: number; graceDays: number; isActive: boolean }
interface Selection { on: boolean; tier: "BASIC" | "GROWTH"; billingCycle: "MONTHLY" | "ANNUAL"; setupFee: string; startDate: string; expiryDate: string; markSetupPaid: boolean; markSubscriptionPaid: boolean }

const EMPTY_PROFILE = { name: "", category: "RESTAURANT", ownerName: "", phone: "", email: "", address: "", city: "", state: "", pincode: "", gstin: "", upiId: "", upiPayeeName: "" };
const defaultExpiry = (start: string, cycle: string) => (start ? addDays(addMonths(start, cycle === "ANNUAL" ? 12 : 1), -1) : "");

/** Picks a PNG/JPEG before the business exists; uploaded right after it is created. */
function ImagePick({ file, onChange, label }: { file: File | null; onChange: (f: File | null) => void; label: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) { setUrl(null); return; }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <div className="flex items-center gap-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url ? <img src={url} alt={`Selected ${label}`} className="h-14 w-14 rounded-lg border border-slate-200 object-contain" /> : <span className="flex h-14 w-14 items-center justify-center rounded-lg border border-dashed border-slate-300 text-[10px] text-slate-400">None</span>}
      <input type="file" accept="image/png,image/jpeg" aria-label={`Choose ${label}`}
        onChange={(e) => { const f = e.target.files?.[0] ?? null; if (f && f.size > 2 * 1024 * 1024) { toast("Image must be 2 MB or smaller", "bad"); e.target.value = ""; return; } onChange(f); }}
        className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium" />
      {file && <Button size="sm" variant="ghost" onClick={() => onChange(null)}>Clear</Button>}
    </div>
  );
}

export function AdminNewBusiness() {
  const defaults = useApi<{ today: string; plans: Plan[] }>("/admin/defaults");
  const [profile, setProfile] = useState(EMPTY_PROFILE);
  const [code, setCode] = useState("");
  const [sel, setSel] = useState<Record<ProductCode, Selection> | null>(null);
  const [payment, setPayment] = useState({ method: "UPI", reference: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{
    tenantId: string; code: string; managerUsername: string; temporaryPassword: string | null; name: string;
    invitation: { delivery: "email" | "link"; link: string | null } | null;
  } | null>(null);
  const [branches, setBranches] = useState<{ name: string; code: string; address: string; phone: string }[]>([]);
  const [owner, setOwner] = useState<{ method: "invite" | "login_id"; delivery: "email" | "link" }>({ method: "invite", delivery: "email" });
  const [assignIds, setAssignIds] = useState<string[]>([]);
  const [logo, setLogo] = useState<File | null>(null);
  const [upiQr, setUpiQr] = useState<File | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const team = useApi<{ items: { id: string; fullName: string; isActive: boolean; invitation: { status: string } | null; role: { name: string; allTenants: boolean } | null }[] }>("/admin/team");
  // Active members and members whose invitation is still pending (invite, then assign).
  const assignable = (team.data?.items ?? []).filter((m) => (m.isActive || m.invitation?.status === "PENDING") && m.role && !m.role.allTenants);

  const planOf = (c: ProductCode, tier: string) => defaults.data?.plans.find((p) => p.productCode === c && p.tier === tier);
  const blank = (c: ProductCode, today: string, plans: Plan[]): Selection => {
    const p = plans.find((x) => x.productCode === c && x.tier === "BASIC");
    return { on: false, tier: "BASIC", billingCycle: "MONTHLY", setupFee: p ? String(p.setupFee / 100) : "0", startDate: today, expiryDate: "", markSetupPaid: false, markSubscriptionPaid: false };
  };
  // Recommended products follow the business type until the admin picks products by hand.
  const productsTouched = useRef(false);
  const kind = businessType(profile.category);
  useEffect(() => {
    if (defaults.data && !sel) {
      productsTouched.current = false;
      setSel(Object.fromEntries(PRODUCT_CODES.map((c) => [c, { ...blank(c, defaults.data!.today, defaults.data!.plans), on: kind.recommended.includes(c) }])) as Record<ProductCode, Selection>);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults.data]);

  const dcode = useDebounced(code.trim().toUpperCase());
  const avail = useApi<{ available: boolean; reason: string | null; managerUsername?: string }>(dcode.length >= 2 ? `/admin/businesses/code-available${qs({ code: dcode })}` : null);

  const patch = (c: ProductCode, p: Partial<Selection>) => setSel((s) => {
    if (!s) return s;
    const next = { ...s[c], ...p };
    // Changing the plan resets the setup fee to that plan's configured fee.
    if (p.tier && p.tier !== s[c].tier) next.setupFee = String((planOf(c, p.tier)?.setupFee ?? 0) / 100);
    return { ...s, [c]: next };
  });

  const chosen = sel ? PRODUCT_CODES.filter((c) => sel[c].on) : [];
  const totals = useMemo(() => {
    if (!sel) return { setup: 0, subscription: 0, paidNow: 0 };
    let setup = 0, subscription = 0, paidNow = 0;
    for (const c of chosen) {
      const s = sel[c];
      const plan = planOf(c, s.tier);
      const fee = Math.round(Number(s.setupFee || 0) * 100);
      const price = plan ? (s.billingCycle === "MONTHLY" ? plan.monthlyPrice : plan.annualPrice) : 0;
      setup += fee; subscription += price;
      if (s.markSetupPaid) paidNow += fee;
      if (s.markSubscriptionPaid) paidNow += price;
    }
    return { setup, subscription, paidNow };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, defaults.data]);
  const anyPaid = chosen.some((c) => sel![c].markSetupPaid || sel![c].markSubscriptionPaid);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sel) return;
    if (!chosen.length) return setError("Select at least one SAF product.");
    if (owner.method === "invite" && !profile.email.trim()) return setError("Enter the owner's email (step 1) to send the invitation, or choose a login ID instead.");
    setBusy(true);
    setError(null);
    try {
      const r = await api<any>("/admin/businesses", {
        body: {
          ...clean(profile), name: profile.name, category: profile.category, ownerName: profile.ownerName, phone: profile.phone,
          code: code.trim().toUpperCase(),
          products: chosen.map((c) => {
            const s = sel[c];
            return clean({
              productCode: c, tier: s.tier, billingCycle: s.billingCycle, setupFee: Math.round(Number(s.setupFee || 0) * 100),
              startDate: s.startDate, expiryDate: s.expiryDate, markSetupPaid: s.markSetupPaid, markSubscriptionPaid: s.markSubscriptionPaid,
            });
          }),
          ...(anyPaid ? clean({ paymentMethod: payment.method, paymentReference: payment.reference }) : {}),
          branches: branches.filter((b) => b.name.trim()).map((b) => clean({ ...b, code: b.code.toUpperCase() })),
          owner,
          assignStaffIds: assignIds,
        },
      });
      // The business exists now; images go up separately. A failed upload is
      // reported but never undoes the business (it can be retried from its page).
      const failed: string[] = [];
      for (const [file, path, label] of [[logo, "logo", "logo"], [upiQr, "upi-qr", "UPI QR"]] as const) {
        if (!file) continue;
        const form = new FormData();
        form.append("file", file);
        try { await api(`/admin/businesses/${r.tenantId}/${path}`, { form }); } catch (e) { failed.push(`${label}: ${errorMessage(e)}`); }
      }
      setUploadNote(failed.length ? failed.join(" ") : null);
      setCreated({ ...r, name: profile.name });
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <>
        <PageHeader title="Business created" description={`${created.name} (${created.code}) is ready.`} />
        <div className="max-w-xl space-y-4">
          {uploadNote && <Notice tone="warn" title="Business created, but an image was not saved">{uploadNote} Upload it again from the business page.</Notice>}
          {created.temporaryPassword && <Credentials username={created.managerUsername} password={created.temporaryPassword} title="Owner login - hand these to the owner" />}
          {created.invitation?.delivery === "email" && (
            <Notice tone="good" title="Invitation sent to the owner">{created.managerUsername} will receive an email to set their password and open the workspace.</Notice>
          )}
          {created.invitation?.link && (
            <Notice tone="info" title="Owner invitation link">
              <p className="break-all font-mono text-xs">{created.invitation.link}</p>
              <p className="mt-2">Send this to the owner. They choose their own password and sign in with {created.managerUsername}.</p>
              <div className="mt-2"><CopyButton text={created.invitation.link} label="Copy link" /></div>
            </Notice>
          )}
          <p className="text-sm text-slate-600">The owner account opens every product activated for this business. The owner then adds staff from Team &gt; Staff logins, by email invitation or with login IDs like <span className="font-mono">{created.code}@name</span>.</p>
          <div className="flex flex-wrap gap-2">
            <Link href={`/admin/businesses/${created.tenantId}`}><Button variant="primary">Open business</Button></Link>
            <Button onClick={() => { setCreated(null); setProfile(EMPTY_PROFILE); setCode(""); setSel(null); setBranches([]); setAssignIds([]); setLogo(null); setUpiQr(null); setUploadNote(null); void defaults.reload(); }}>Add another business</Button>
          </div>
        </div>
      </>
    );
  }

  const pickCategory = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const category = e.target.value;
    setProfile((p) => ({ ...p, category }));
    if (productsTouched.current) return;
    const rec = businessType(category).recommended;
    setSel((s) => s && (Object.fromEntries(PRODUCT_CODES.map((c) => [c, { ...s[c], on: rec.includes(c) }])) as Record<ProductCode, Selection>));
  };
  const set = (k: keyof typeof EMPTY_PROFILE) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setProfile((p) => ({ ...p, [k]: e.target.value }));

  return (
    <>
      <PageHeader title="Add new business" description="Creates the workspace, activates the selected SAF products, sets up branches and invites the owner. Everything is created together or not at all." />
      <Loadable state={defaults}>
        {(d) => !sel ? null : (
          <form onSubmit={submit} className="grid gap-4 xl:grid-cols-[1fr_22rem]">
            <div className="space-y-4">
              <Card title="1. Business information">
                <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                  <Field label="Business name" required><Input required minLength={2} maxLength={120} value={profile.name} onChange={set("name")} /></Field>
                  <Field label="Business type" required help={kind.recommended.length ? `Recommended: ${kind.recommended.map((c) => PRODUCTS[c].name).join(" + ")}` : undefined}>
                    <Select value={profile.category} onChange={pickCategory}>
                      {[...new Set(Object.values(BUSINESS_TYPES).map((t) => t.group))].map((g) => (
                        <optgroup key={g} label={g}>
                          {BUSINESS_CATEGORIES.filter((c) => BUSINESS_TYPES[c].group === g).map((c) => <option key={c} value={c}>{BUSINESS_TYPES[c].label}</option>)}
                        </optgroup>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Owner name" required><Input required minLength={2} maxLength={100} value={profile.ownerName} onChange={set("ownerName")} /></Field>
                  <Field label="Phone" required><Input required type="tel" inputMode="tel" value={profile.phone} onChange={set("phone")} /></Field>
                  <Field label="Owner email" required={owner.method === "invite"} help={owner.method === "invite" ? "The owner signs in with this email." : undefined}><Input type="email" maxLength={120} required={owner.method === "invite"} value={profile.email} onChange={set("email")} /></Field>
                  <Field label="GSTIN"><Input maxLength={20} value={profile.gstin} onChange={set("gstin")} /></Field>
                  <Field label="Address" className="sm:col-span-2"><Textarea rows={2} maxLength={300} value={profile.address} onChange={set("address")} /></Field>
                  <Field label="City"><Input maxLength={80} value={profile.city} onChange={set("city")} /></Field>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="State"><Input maxLength={80} value={profile.state} onChange={set("state")} /></Field>
                    <Field label="PIN code"><Input maxLength={10} inputMode="numeric" value={profile.pincode} onChange={set("pincode")} /></Field>
                  </div>
                  <Field label="Business code" required help="2-12 letters/digits, starts with a letter. It prefixes every login ID and cannot be changed later.">
                    <Input required maxLength={12} className="font-mono uppercase" value={code} onChange={(e) => setCode(e.target.value.replace(/[^a-zA-Z0-9]/g, ""))} placeholder="SGV" />
                  </Field>
                  <Field label="Logo" help="Shown on the QR menu, bills and staff ID cards. PNG or JPEG, up to 2 MB.">
                    <ImagePick file={logo} onChange={setLogo} label="business logo" />
                  </Field>
                  <div className="self-center text-sm" aria-live="polite">
                    {dcode.length >= 2 && avail.data && (avail.data.available
                      ? <span className="flex items-center gap-1.5 text-emerald-800"><CheckCircle2 className="h-4 w-4" aria-hidden /> Available.{owner.method === "login_id" && <> Owner login: <span className="font-mono font-semibold">{avail.data.managerUsername}</span></>}</span>
                      : <span className="flex items-center gap-1.5 text-red-700"><XCircle className="h-4 w-4" aria-hidden /> {avail.data.reason}</span>)}
                  </div>
                </div>
              </Card>

              <Card title="Customer payments (UPI)" subtitle="Optional. The business's own UPI: its customers scan a QR with the bill amount at the counter and on unpaid bills.">
                <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                  <Field label="UPI ID" help="e.g. shopname@okaxis"><Input maxLength={320} autoComplete="off" value={profile.upiId} onChange={set("upiId")} placeholder="shopname@okaxis" /></Field>
                  <Field label="Name shown in the UPI app"><Input maxLength={60} value={profile.upiPayeeName} onChange={set("upiPayeeName")} placeholder={profile.name} /></Field>
                  <Field label="UPI QR image (optional)" className="sm:col-span-2" help="Only used when no UPI ID is entered.">
                    <ImagePick file={upiQr} onChange={setUpiQr} label="UPI QR image" />
                  </Field>
                </div>
              </Card>

              <Card title="2-3. Products and subscription" subtitle="Select one or more. Each product has its own plan, billing cycle and renewal date.">
                <div className="space-y-3">
                  {PRODUCT_CODES.map((c) => {
                    const s = sel[c];
                    const plan = planOf(c, s.tier);
                    return (
                      <fieldset key={c} className={`rounded-xl border p-3 ${s.on ? "border-brand bg-brand-soft/40" : "border-slate-200"}`}>
                        <label className="flex items-start gap-3">
                          <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--brand)]" checked={s.on} onChange={(e) => { productsTouched.current = true; patch(c, { on: e.target.checked }); }} />
                          <span><span className="block text-sm font-semibold text-slate-900">{PRODUCTS[c].name}{kind.recommended.includes(c) && <Badge tone="info" className="ml-2 align-middle">Recommended</Badge>}</span><span className="block text-xs text-slate-600">{PRODUCTS[c].tagline}</span></span>
                        </label>
                        {s.on && (
                          <div className="mt-3 grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                            <Field label="Plan">
                              <Select value={s.tier} onChange={(e) => patch(c, { tier: e.target.value as Selection["tier"] })}>
                                {d.plans.filter((p) => p.productCode === c && p.isActive).map((p) => <option key={p.id} value={p.tier}>{p.name}</option>)}
                              </Select>
                            </Field>
                            <Field label="Billing" help={plan ? `${formatINR(s.billingCycle === "MONTHLY" ? plan.monthlyPrice : plan.annualPrice, { whole: true })} ${s.billingCycle === "MONTHLY" ? "per month" : "per year"} + GST` : undefined}>
                              <Select value={s.billingCycle} onChange={(e) => patch(c, { billingCycle: e.target.value as Selection["billingCycle"] })}>
                                <option value="MONTHLY">Monthly maintenance</option><option value="ANNUAL">Annual advance payment</option>
                              </Select>
                            </Field>
                            <Field label="Setup fee (Rs)" help={plan ? `Plan default ${formatINR(plan.setupFee, { whole: true })}` : undefined}>
                              <Input type="number" min={0} step="1" inputMode="decimal" value={s.setupFee} onChange={(e) => patch(c, { setupFee: e.target.value })} />
                            </Field>
                            <Field label="Activation date"><Input type="date" required value={s.startDate} onChange={(e) => patch(c, { startDate: e.target.value })} /></Field>
                            <Field label="Subscription expiry" help={`Empty = ${fmtDate(defaultExpiry(s.startDate, s.billingCycle))} (one ${s.billingCycle === "MONTHLY" ? "month" : "year"})`}>
                              <Input type="date" min={s.startDate} value={s.expiryDate} onChange={(e) => patch(c, { expiryDate: e.target.value })} />
                            </Field>
                            <div className="space-y-1 self-end text-sm text-slate-800">
                              <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={s.markSetupPaid} onChange={(e) => patch(c, { markSetupPaid: e.target.checked })} /> Setup fee received</label>
                              <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={s.markSubscriptionPaid} onChange={(e) => patch(c, { markSubscriptionPaid: e.target.checked })} /> First {s.billingCycle === "MONTHLY" ? "month" : "year"} received</label>
                            </div>
                          </div>
                        )}
                      </fieldset>
                    );
                  })}
                </div>
              </Card>

              <Card title="4. Branches" subtitle={`A main ${kind.branchNoun} is always created. Add more if the business runs several.`}
                actions={<Button size="sm" onClick={() => setBranches((b) => [...b, { name: "", code: "", address: "", phone: "" }])}><Plus className="h-4 w-4" aria-hidden /> Add {kind.branchNoun}</Button>}>
                <p className="text-sm text-slate-700"><span className="font-medium">Main Branch</span> <span className="font-mono text-xs text-slate-500">MAIN</span> - uses the business address.</p>
                {branches.map((b, i) => (
                  <div key={i} className="mt-3 grid gap-x-3 gap-y-2 rounded-xl border border-slate-200 p-3 sm:grid-cols-[1fr_7rem_1fr_9rem_auto]">
                    <Field label="Branch name" required><Input required minLength={2} maxLength={80} value={b.name} onChange={(e) => setBranches((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} /></Field>
                    <Field label="Code" required><Input required maxLength={12} className="font-mono uppercase" value={b.code} onChange={(e) => setBranches((x) => x.map((y, j) => (j === i ? { ...y, code: e.target.value.replace(/[^a-zA-Z0-9]/g, "") } : y)))} /></Field>
                    <Field label="Address"><Input maxLength={300} value={b.address} onChange={(e) => setBranches((x) => x.map((y, j) => (j === i ? { ...y, address: e.target.value } : y)))} /></Field>
                    <Field label="Phone"><Input maxLength={20} value={b.phone} onChange={(e) => setBranches((x) => x.map((y, j) => (j === i ? { ...y, phone: e.target.value } : y)))} /></Field>
                    <div className="self-end"><Button size="sm" variant="ghost" onClick={() => setBranches((x) => x.filter((_, j) => j !== i))}>Remove</Button></div>
                  </div>
                ))}
                {branches.length > 0 && <p className="mt-2 text-xs text-slate-500">Staff can switch between branches when the plan includes multi-branch management.</p>}
              </Card>

              <Card title="5. Owner account" subtitle="How the business owner gets into their workspace.">
                <div className="space-y-2 text-sm">
                  <label className="flex items-start gap-2"><input type="radio" name="owner" className="mt-1 accent-[var(--brand)]" checked={owner.method === "invite"} onChange={() => setOwner((o) => ({ ...o, method: "invite" }))} />
                    <span><span className="font-medium text-slate-900">Email invitation (recommended)</span><span className="block text-slate-600">The owner receives a secure link and chooses their own password. Nobody else ever knows it.</span></span></label>
                  {owner.method === "invite" && (
                    <div className="ml-6">
                      <Select value={owner.delivery} onChange={(e) => setOwner((o) => ({ ...o, delivery: e.target.value as "email" | "link" }))}>
                        <option value="email">Email the invitation</option>
                        <option value="link">Give me a link to share (WhatsApp etc.)</option>
                      </Select>
                    </div>
                  )}
                  <label className="flex items-start gap-2"><input type="radio" name="owner" className="mt-1 accent-[var(--brand)]" checked={owner.method === "login_id"} onChange={() => setOwner((o) => ({ ...o, method: "login_id" }))} />
                    <span><span className="font-medium text-slate-900">Login ID with temporary password</span><span className="block text-slate-600">For owners without email: <span className="font-mono">{(code || "CODE").toUpperCase()}@manager</span>, password changed at first sign-in.</span></span></label>
                </div>
              </Card>

              {assignable.length > 0 && (
                <Card title="SAF Team assignment (optional)" subtitle="Members who will manage this client. Admins and auditors already see every business.">
                  <div className="grid gap-2 sm:grid-cols-2">
                    {assignable.map((m) => (
                      <label key={m.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={assignIds.includes(m.id)} onChange={() => setAssignIds((x) => (x.includes(m.id) ? x.filter((y) => y !== m.id) : [...x, m.id]))} />
                        {m.fullName} <span className="text-xs text-slate-500">{m.role?.name}</span>
                      </label>
                    ))}
                  </div>
                </Card>
              )}
            </div>

            <div className="space-y-4">
              <Card title="6. Summary">
                {!chosen.length ? <p className="text-sm text-slate-500">No product selected yet.</p> : (
                  <>
                    <ul className="space-y-2 text-sm">
                      {chosen.map((c) => <li key={c} className="flex justify-between gap-2"><span>{PRODUCTS[c].shortName}</span><span className="text-slate-600">{humanize(sel[c].tier)}, {cycleLabel(sel[c].billingCycle).toLowerCase()}</span></li>)}
                    </ul>
                    <dl className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-sm">
                      <div className="flex justify-between"><dt className="text-slate-600">Setup fees</dt><dd className="tnum">{formatINR(totals.setup)}</dd></div>
                      <div className="flex justify-between"><dt className="text-slate-600">First period</dt><dd className="tnum">{formatINR(totals.subscription)}</dd></div>
                      <div className="flex justify-between font-semibold"><dt>Total (excl. GST)</dt><dd className="tnum">{formatINR(totals.setup + totals.subscription)}</dd></div>
                      <div className="flex justify-between text-slate-600"><dt>Marked as received</dt><dd className="tnum">{formatINR(totals.paidNow)}</dd></div>
                    </dl>
                    <p className="mt-2 text-xs text-slate-500">Invoices are raised for every amount, with GST added. Anything not marked as received stays as an unpaid invoice.</p>
                  </>
                )}
              </Card>
              {anyPaid && (
                <Card title="Payment received">
                  <div className="space-y-3">
                    <Field label="Method"><Select value={payment.method} onChange={(e) => setPayment((p) => ({ ...p, method: e.target.value }))}>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{humanize(m)}</option>)}</Select></Field>
                    <Field label="Reference"><Input maxLength={100} value={payment.reference} onChange={(e) => setPayment((p) => ({ ...p, reference: e.target.value }))} placeholder="UPI ref / cheque no." /></Field>
                  </div>
                </Card>
              )}
              {error && <Notice tone="bad">{error}</Notice>}
              {chosen.length > 0 && (
                <Card title="Workspace">
                  <ul className="space-y-1 text-sm text-slate-700">
                    <li>{1 + branches.filter((b) => b.name.trim()).length} branch(es)</li>
                    <li>Owner: {owner.method === "invite" ? (profile.email || "email required") + (owner.delivery === "link" ? " (link)" : " (email invite)") : `${(code || "CODE").toUpperCase()}@manager`}</li>
                    {assignIds.length > 0 && <li>{assignIds.length} SAF Team member(s) assigned</li>}
                  </ul>
                </Card>
              )}
              <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!!avail.data && !avail.data.available}>Create business &amp; activate workspace</Button>
            </div>
          </form>
        )}
      </Loadable>
    </>
  );
}

// ---------------------------------------------------------------------------
// Business detail
// ---------------------------------------------------------------------------

type DetailTab = "overview" | "subscriptions" | "features" | "users" | "billing" | "history";

const PROFILE_FIELDS = {
  name: f.text("Business name", { required: true, max: 120 }),
  category: f.select("Category", BUSINESS_CATEGORIES, { required: true }),
  ownerName: f.text("Owner name", { required: true, max: 100 }),
  phone: f.phone("Phone", { required: true }),
  email: f.email("Email"),
  gstin: f.text("GSTIN", { max: 20 }),
  address: f.textarea("Address", { max: 300 }),
  city: f.text("City", { max: 80 }),
  state: f.text("State", { max: 80 }),
  pincode: f.text("PIN code", { max: 10 }),
  upiId: f.text("UPI ID (customer payments)", { max: 320 }),
  upiPayeeName: f.text("Name shown in the UPI app", { max: 60 }),
};

export function AdminBusinessDetail({ id }: { id: string }) {
  const b = useApi<any>(`/admin/businesses/${id}`);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [editing, setEditing] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const [adding, setAdding] = useState(false);
  const [invoicing, setInvoicing] = useState(false);
  const [paying, setPaying] = useState<any | null>(null);
  const [busy, run] = useAction();
  const file = useRef<HTMLInputElement>(null);
  const reload = () => void b.reload();

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked) return;
    const form = new FormData();
    form.append("file", picked);
    await run(async () => { await api(`/admin/businesses/${id}/logo`, { form }); await b.reload(); }, "Logo updated");
  };
  const qrFile = useRef<HTMLInputElement>(null);
  const uploadQr = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked) return;
    const form = new FormData();
    form.append("file", picked);
    await run(async () => { await api(`/admin/businesses/${id}/upi-qr`, { form }); await b.reload(); }, "UPI QR saved");
  };

  return (
    <>
      <Link href="/admin/businesses" className="no-print mb-3 inline-flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900"><ArrowLeft className="h-4 w-4" /> All businesses</Link>
      <Loadable state={b}>
        {(d) => {
          const biz = d.business ?? {};
          const subscribed = new Set(d.subscriptions.map((s: any) => s.productCode));
          const available = PRODUCT_CODES.filter((c) => !subscribed.has(c));
          const unpaid = d.invoices.filter((i: any) => i.status === "ISSUED");
          return (
            <>
              <PageHeader
                title={biz.name ?? d.code}
                description={<span className="flex flex-wrap items-center gap-2"><span className="font-mono">{d.code}</span><StatusBadge value={d.status} />{businessType(biz.category).label}<span>- added {fmtDate(d.createdAt)}</span></span>}
                actions={d.status === "ACTIVE"
                  ? <Button variant="danger" onClick={() => setSuspending(true)}>Suspend business</Button>
                  : <Button variant="primary" loading={busy} onClick={() => run(async () => { await api(`/admin/businesses/${id}/status`, { body: { status: "ACTIVE" } }); await b.reload(); }, "Business activated")}>Activate business</Button>}
              />
              {d.status === "SUSPENDED" && <div className="mb-4"><Notice tone="bad" title="This business is suspended">{d.suspendedReason || "No reason recorded."} Nobody from this business can sign in to any SAF product.</Notice></div>}

              <Tabs value={tab} onChange={setTab} tabs={[
                { key: "overview", label: "Overview" },
                { key: "subscriptions", label: "Products & subscriptions", count: d.subscriptions.length },
                { key: "features", label: "Feature access" },
                { key: "users", label: "Users", count: d.users.length },
                { key: "billing", label: "Billing", count: unpaid.length || undefined },
                { key: "history", label: "History" },
              ]} />

              {tab === "overview" && (
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="xl:col-span-2"><BusinessTeamCard id={d.id} /></div>
                  <Card title="Business profile" actions={<Button size="sm" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /> Edit</Button>}>
                    <KeyValue items={[
                      ["Owner", biz.ownerName], ["Phone", biz.phone], ["Email", biz.email], ["GSTIN", biz.gstin],
                      ["Address", [biz.address, biz.city, biz.state, biz.pincode].filter(Boolean).join(", ") || null],
                      ["Tenant ID", <span key="t" className="font-mono text-xs">{d.id}</span>],
                    ]} />
                  </Card>
                  <div className="space-y-4">
                    <Card title="Logo" subtitle="Printed on invoices and staff ID cards. PNG or JPEG, up to 2 MB.">
                      <div className="flex items-center gap-4">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {biz.logoUrl ? <img src={biz.logoUrl} alt="Business logo" className="h-16 w-16 rounded-lg border border-slate-200 object-contain" /> : <span className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-slate-300 text-xs text-slate-400">No logo</span>}
                        <input ref={file} type="file" accept="image/png,image/jpeg" className="hidden" onChange={upload} />
                        <Button loading={busy} onClick={() => file.current?.click()}><ImageUp className="h-4 w-4" /> Upload logo</Button>
                      </div>
                    </Card>
                    <Card title="Customer payments (UPI)" subtitle="Change the UPI ID under Edit. The QR image is used only without a UPI ID.">
                      <div className="flex items-center gap-4">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {biz.upiQrUrl ? <img src={biz.upiQrUrl} alt="UPI QR" className="h-16 w-16 rounded-lg border border-slate-200 object-contain" /> : <span className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-slate-300 text-xs text-slate-400">No QR</span>}
                        <div className="min-w-0 text-sm">
                          <p className="truncate font-mono text-slate-800">{biz.upiId ?? "No UPI ID"}</p>
                          {biz.upiPayeeName && <p className="text-xs text-slate-500">{biz.upiPayeeName}</p>}
                          <input ref={qrFile} type="file" accept="image/png,image/jpeg" className="hidden" onChange={uploadQr} />
                          <div className="mt-2 flex gap-2">
                            <Button size="sm" loading={busy} onClick={() => qrFile.current?.click()}><ImageUp className="h-4 w-4" /> QR image</Button>
                            {biz.upiQrUrl && <Button size="sm" variant="ghost" loading={busy} onClick={() => run(async () => { await api(`/admin/businesses/${id}/upi-qr`, { method: "DELETE" }); await b.reload(); }, "QR image removed")}>Remove</Button>}
                          </div>
                        </div>
                      </div>
                    </Card>
                    <Card title="Products"><ProductChips products={d.subscriptions.map((s: any) => ({ code: s.productCode, tier: s.tier, state: s.state }))} /></Card>
                    <Card title="Branches">
                      <ul className="space-y-1 text-sm">{d.branches.map((br: any) => <li key={br.id} className="flex items-center gap-2">{br.name} <span className="font-mono text-xs text-slate-500">{br.code}</span>{br.isMain && <Badge>Main</Badge>}{!br.isActive && <Badge tone="bad">Inactive</Badge>}</li>)}</ul>
                    </Card>
                  </div>
                </div>
              )}

              {tab === "subscriptions" && (
                <div className="space-y-4">
                  {d.subscriptions.map((s: AdminSub & { setupFee: number; suspendedReason?: string }) => (
                    <Card key={s.id} title={productName(s.productCode)} subtitle={`${s.planName} plan - ${cycleLabel(s.billingCycle).toLowerCase()} billing`} actions={<SubscriptionState sub={s} />}>
                      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
                        <KeyValue items={[
                          ["Started", fmtDate(s.startDate)],
                          [s.state === "ACTIVE" ? "Expires / renews" : "Expired", fmtDate(s.currentPeriodEnd)],
                          ["Grace ends", fmtDate(s.graceEndsAt)],
                          ["Renewal price", `${formatINR(s.price)} + GST`],
                          ["Setup fee charged", formatINR(s.setupFee)],
                          ["Auto renewal invoices", s.autoRenew ? "On" : "Off"],
                          ...(s.pendingTier || s.pendingBillingCycle ? [["Scheduled change", `${s.pendingTier ? humanize(s.pendingTier) : s.planName}${s.pendingBillingCycle ? `, ${cycleLabel(s.pendingBillingCycle).toLowerCase()}` : ""} from next renewal`] as [string, string]] : []),
                          ...(s.suspendedReason ? [["Suspension reason", s.suspendedReason] as [string, string]] : []),
                        ]} />
                        <div className="lg:max-w-xs"><SubscriptionActions sub={s} onChanged={reload} /></div>
                      </div>
                    </Card>
                  ))}
                  {!d.subscriptions.length && <Card><Empty title="No products activated" /></Card>}
                  {available.length > 0 && <Button variant="primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Activate another product</Button>}
                </div>
              )}

              {tab === "features" && <FeatureOverrides id={id} />}

              {tab === "users" && (
                <Card pad={false} title="Accounts" subtitle="The manager account opens every subscribed product. Staff logins are created by the manager.">
                  <DataTable
                    rows={d.users} rowKey={(r: any) => r.id}
                    columns={[
                      { key: "u", label: "Login ID", render: (r: any) => <span className="font-mono text-[13px]">{r.username}</span> },
                      { key: "n", label: "Name", render: (r: any) => <span>{r.fullName} {r.isTenantOwner && <Badge tone="brand">Manager</Badge>}</span> },
                      { key: "a", label: "Product access", render: (r: any) => <span className="flex flex-wrap gap-1">{r.access.map((a: any) => <Badge key={a.product} tone={a.isActive ? "neutral" : "bad"}>{productShort(a.product)}: {a.role}</Badge>)}</span> },
                      { key: "l", label: "Last sign-in", render: (r: any) => r.lastLoginAt ? fmtDateTime(r.lastLoginAt) : "Never" },
                      { key: "s", label: "Status", render: (r: any) => <span className="flex flex-wrap gap-1"><StatusBadge value={r.isActive ? "ACTIVE" : "INACTIVE"} label={r.isActive ? "Active" : "Disabled"} />{r.mustChangePassword && <Badge tone="warn">Temp password</Badge>}{r.lockedUntil && new Date(r.lockedUntil) > new Date() && <Badge tone="bad">Locked</Badge>}</span> },
                      { key: "x", label: "", align: "right", render: (r: any) => <UserActions user={r} onChanged={reload} /> },
                    ]}
                  />
                </Card>
              )}

              {tab === "billing" && (
                <div className="space-y-4">
                  <Card pad={false} title="Invoices" subtitle={unpaid.length ? `${unpaid.length} unpaid - ${formatINR(unpaid.reduce((a: number, i: any) => a + i.total - i.paidAmount, 0))} outstanding` : "Nothing outstanding"} actions={<Button size="sm" onClick={() => setInvoicing(true)}><Plus className="h-3.5 w-3.5" /> Raise invoice</Button>}>
                    <DataTable
                      rows={d.invoices} rowKey={(r: any) => r.id} empty={<Empty title="No invoices yet" />}
                      columns={[
                        { key: "no", label: "Invoice", render: (r: any) => <Link className={`font-mono text-[13px] ${linkCls}`} href={`/admin/invoices/${r.id}`}>{r.invoiceNo}</Link> },
                        { key: "d", label: "Date", render: (r: any) => fmtDate(r.createdAt) },
                        { key: "desc", label: "Description", render: (r: any) => <span className="block max-w-sm whitespace-normal">{r.description}</span> },
                        { key: "t", label: "Total", align: "right", render: (r: any) => formatINR(r.total) },
                        { key: "p", label: "Paid", align: "right", render: (r: any) => formatINR(r.paidAmount) },
                        { key: "s", label: "Status", render: (r: any) => <InvoiceStatus inv={r} /> },
                        { key: "x", label: "", align: "right", render: (r: any) => r.status === "ISSUED" && (
                          <span className="flex justify-end gap-1">
                            <Button size="sm" variant="primary" onClick={() => setPaying(r)}>Record payment</Button>
                            <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`Void invoice ${r.invoiceNo}?`)) void run(async () => { await api(`/admin/invoices/${r.id}/void`, { body: {} }); await b.reload(); }, "Invoice voided"); }}>Void</Button>
                          </span>
                        ) },
                      ]}
                    />
                  </Card>
                  <Card pad={false} title="Payment history">
                    <DataTable
                      rows={d.payments} rowKey={(r: any) => r.id} empty={<Empty title="No payments yet" />} dense
                      columns={[
                        { key: "d", label: "Date", render: (r: any) => fmtDate(r.paidAt ?? r.createdAt) },
                        { key: "a", label: "Amount", align: "right", render: (r: any) => formatINR(r.amount) },
                        { key: "m", label: "Method", render: (r: any) => humanize(r.method) },
                        { key: "r", label: "Reference", render: (r: any) => r.reference ?? "-" },
                        { key: "s", label: "Status", render: (r: any) => <StatusBadge value={r.status} /> },
                        { key: "n", label: "Notes", render: (r: any) => r.notes ?? "-" },
                      ]}
                    />
                  </Card>
                </div>
              )}

              {tab === "history" && <Card title="Subscription history"><EventList events={d.events} /></Card>}

              <FormModal open={editing} title="Edit business profile" fields={PROFILE_FIELDS} initial={biz} size="lg" onClose={() => setEditing(false)}
                onSubmit={async (v) => { await api(`/admin/businesses/${id}`, { method: "PATCH", body: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x ?? ""])) }); toast("Profile saved"); await b.reload(); }} />

              <FormModal open={suspending} title={`Suspend ${biz.name ?? d.code}`} submitLabel="Suspend business" danger onClose={() => setSuspending(false)}
                intro={<Notice tone="warn">All users of this business are signed out and cannot sign in to any SAF product until it is activated again. No data is deleted.</Notice>}
                fields={{ reason: f.textarea("Reason", { max: 300 }) }}
                onSubmit={async (v) => { await api(`/admin/businesses/${id}/status`, { body: clean({ status: "SUSPENDED", reason: v.reason }) }); toast("Business suspended"); await b.reload(); }} />

              <FormModal open={adding} title="Activate another product" submitLabel="Activate" size="lg" onClose={() => setAdding(false)}
                intro={<p className="text-sm text-slate-600">The manager account gets access automatically. Leave the setup fee and expiry empty to use the plan defaults.</p>}
                fields={{
                  productCode: f.select("Product", available, { required: true }),
                  tier: f.select("Plan", ["BASIC", "GROWTH"], { required: true }),
                  billingCycle: f.select("Billing", ["MONTHLY", "ANNUAL"], { required: true }),
                  setupFee: f.money("Setup fee", { help: "Empty = plan default" }),
                  startDate: f.date("Activation date"),
                  expiryDate: f.date("Subscription expiry"),
                  markSetupPaid: f.bool("Setup fee received"),
                  markSubscriptionPaid: f.bool("First period received"),
                  paymentMethod: f.select("Payment method", PAYMENT_METHODS),
                  paymentReference: f.text("Payment reference", { max: 100 }),
                }}
                initial={{ productCode: available[0] ?? "", tier: "BASIC", billingCycle: "MONTHLY", setupFee: null, startDate: "", expiryDate: "", markSetupPaid: false, markSubscriptionPaid: false, paymentMethod: "", paymentReference: "" }}
                onSubmit={async (v) => { await api(`/admin/businesses/${id}/products`, { body: clean(v) }); toast(`${productName(v.productCode)} activated`); await b.reload(); }} />

              <FormModal open={invoicing} title="Raise a custom invoice" submitLabel="Raise invoice" onClose={() => setInvoicing(false)}
                intro={<p className="text-sm text-slate-600">For one-off charges (training, hardware, customisation). GST is added automatically.</p>}
                fields={{
                  description: f.text("Description", { required: true, max: 300 }),
                  subtotal: f.money("Amount (excl. GST)", { required: true }),
                  productCode: f.select("Related product", PRODUCT_CODES),
                }}
                onSubmit={async (v) => { await api("/admin/invoices", { body: clean({ tenantId: id, ...v }) }); toast("Invoice raised"); await b.reload(); }} />

              <RecordPaymentModal invoice={paying} onClose={() => setPaying(null)} onDone={reload} />
            </>
          );
        }}
      </Loadable>
    </>
  );
}

function FeatureOverrides({ id }: { id: string }) {
  const data = useApi<any[]>(`/admin/businesses/${id}/features`);
  const [busy, run] = useAction();
  const setMode = (key: string, mode: string) => run(async () => { await api(`/admin/businesses/${id}/features/${encodeURIComponent(key)}`, { method: "PUT", body: { mode } }); await data.reload(); }, "Feature access updated");
  return (
    <Loadable state={data}>
      {(products) => !products.length ? <Card><Empty title="No products activated" /></Card> : (
        <div className="space-y-4">
          <Notice tone="info">Features normally follow the plan. An override grants a single Growth module to a Basic customer (or blocks one) for this business only. It is enforced by the API, not just hidden in the menu.</Notice>
          {products.map((p) => (
            <Card key={p.product} pad={false} title={productName(p.product)} subtitle={`${humanize(p.tier)} plan - ${p.features.filter((x: any) => x.effective).length} of ${p.features.length} features enabled`}>
              <DataTable
                rows={p.features} rowKey={(r: any) => r.key} dense
                columns={[
                  { key: "n", label: "Feature", render: (r: any) => <span>{r.name} <span className="text-xs text-slate-500">{r.group}</span></span> },
                  { key: "p", label: "In plan", render: (r: any) => (r.inPlan ? "Yes" : "No") },
                  { key: "e", label: "Effective", render: (r: any) => <StatusBadge value={r.effective ? "ACTIVE" : "INACTIVE"} label={r.effective ? "Enabled" : "Not enabled"} /> },
                  { key: "o", label: "Override", render: (r: any) => (
                    <Select aria-label={`Override for ${r.name}`} className="!h-8 w-40" disabled={busy} value={r.override} onChange={(e) => setMode(r.key, e.target.value)}>
                      <option value="inherit">Follow plan</option><option value="grant">Always allow</option><option value="revoke">Always block</option>
                    </Select>
                  ) },
                ]}
              />
            </Card>
          ))}
        </div>
      )}
    </Loadable>
  );
}
