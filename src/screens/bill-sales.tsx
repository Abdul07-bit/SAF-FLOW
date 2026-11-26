"use client";

import { useRef, useState } from "react";
import { Check, ExternalLink, Minus, Plus, Search, Trash2 } from "lucide-react";
import { fmtDate, fmtDateTime, fmtTime } from "@/lib/dates";
import { computeTotals, formatINR, rupeesToPaise } from "@/lib/money";
import { api, ApiError, qs, useApi } from "@/lib/client";
import { humanize } from "@/shared/fields";
import { billCustomers } from "@/shared/resources";
import { BarList, ChartCard, ColumnChart, fmtCompactINR, KpiRow, StatTile } from "@/components/charts";
import { ResourcePage } from "@/components/forms";
import { useProduct } from "@/components/product-context";
import { ShopUpiQr } from "@/components/shop-upi";
import { RangePicker, useRange } from "@/components/range";
import { ScanInput } from "@/components/scanner";
import { Button, Card, DataTable, Empty, Field, Input, Loadable, Modal, Notice, PageHeader, Select, StatusBadge, toast, toastError, useAction } from "@/components/ui";
import { SALE_TENDERS, tenderLabel } from "./dine-service";
import { newSplit, SplitPaymentEditor, splitParts, splitReady, type SplitRow } from "@/components/split-payment";
import { describePayment } from "@/shared/tender";
import { formatDailyNo } from "@/lib/business-day";
import { MobileBillBar } from "@/components/mobile-bill-bar";

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function BillDashboard() {
  const p = useProduct();
  const d = useApi<any>("/bill/dashboard", { refreshMs: 60_000 });
  return (
    <>
      <PageHeader title="Retail dashboard" description={`Today at ${p.tenant.name}`} />
      <Loadable state={d}>
        {(x) => (
          <>
            <KpiRow cols={6}>
              <StatTile label="Sales today" value={formatINR(x.salesToday, { whole: true })} />
              <StatTile label="Bills" value={x.transactions} />
              <StatTile label="Average basket" value={formatINR(x.avgBasket, { whole: true })} />
              <StatTile label="Items sold" value={x.itemsSold} />
              <StatTile label="Gross margin today" value={formatINR(x.grossMarginToday, { whole: true })} sub="selling price less cost" />
              <StatTile label="Low stock products" value={x.lowStockCount} tone={x.lowStockCount ? "warn" : undefined} />
            </KpiRow>
            <div className="grid gap-4 xl:grid-cols-3">
              <ChartCard className="xl:col-span-2" title="Sales in the last 7 days" table={{ columns: ["Date", "Sales"], rows: x.last7Days.map((r: any) => [fmtDate(r.date), formatINR(r.sales)]) }}>
                <ColumnChart data={x.last7Days.map((r: any) => ({ label: fmtDate(r.date).slice(0, 6), value: r.sales }))} format={(n) => formatINR(n, { whole: true })} axisFormat={fmtCompactINR} emptyText="No sales in the last 7 days" />
              </ChartCard>
              <Card title="Low stock" subtitle="At or below the alert level">
                {!x.lowStock.length ? <p className="py-6 text-center text-sm text-slate-500">All stock levels are healthy.</p> : (
                  <ul className="divide-y divide-slate-100 text-sm">{x.lowStock.map((s: any) => <li key={s.id} className="flex justify-between gap-3 py-1.5"><span className="truncate">{s.name}</span><span className="tnum whitespace-nowrap text-amber-800">{s.stock} {s.unit} <span className="text-slate-400">/ {s.reorderLevel}</span></span></li>)}</ul>
                )}
              </Card>
              <ChartCard title="Sales by hour today" table={{ columns: ["Hour", "Sales"], rows: x.hourly.map((h: any) => [`${h.hour}:00`, formatINR(h.sales)]) }}>
                <ColumnChart data={x.hourly.map((h: any) => ({ label: `${h.hour}`, value: h.sales }))} format={(n) => formatINR(n, { whole: true })} axisFormat={fmtCompactINR} height={150} emptyText="No sales yet today" />
              </ChartCard>
              <ChartCard title="Top products today" subtitle="By revenue" table={{ columns: ["Product", "Qty", "Revenue"], rows: x.topProducts.map((t: any) => [t.name, t.qty, formatINR(t.revenue)]) }}>
                <BarList data={x.topProducts.map((t: any) => ({ label: t.name, value: t.revenue, sub: `${t.qty} sold` }))} format={(n) => formatINR(n, { whole: true })} emptyText="Nothing sold yet today" />
              </ChartCard>
              <ChartCard title="Payment methods today" table={{ columns: ["Method", "Amount"], rows: x.paymentSplit.map((m: any) => [humanize(m.method), formatINR(m.amount)]) }}>
                <BarList data={x.paymentSplit.map((m: any) => ({ label: humanize(m.method), value: m.amount }))} format={(n) => formatINR(n, { whole: true })} emptyText="No collections yet" />
              </ChartCard>
            </div>
          </>
        )}
      </Loadable>
    </>
  );
}

// ---------------------------------------------------------------------------
// POS billing
// ---------------------------------------------------------------------------

interface PosLine {
  productId: string;
  name: string;
  unitPrice: number;
  taxRate: number;
  qty: number;
  stock: number;
  unit: string;
}

export function BillPos() {
  const p = useProduct();
  const billRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<PosLine[]>([]);
  const [q, setQ] = useState("");
  const results = useApi<{ items: any[] }>(q.trim().length >= 2 ? `/bill/products${qs({ q: q.trim(), pageSize: 12 })}` : null);
  const counters = useApi<{ items: any[] }>("/bill/counters");
  const [counterId, setCounter] = useState("");
  const [phone, setPhone] = useState("");
  const [custName, setCustName] = useState("");
  const [method, setMethod] = useState("CASH");
  const [discount, setDiscount] = useState("");
  const [received, setReceived] = useState("");
  const [split, setSplit] = useState<SplitRow[]>(newSplit);
  const [done, setDone] = useState<any | null>(null);
  const [busy, run] = useAction();

  const add = (prod: any) => {
    setLines((ls) => (ls.some((l) => l.productId === prod.id)
      ? ls.map((l) => (l.productId === prod.id ? { ...l, qty: l.qty + 1 } : l))
      : [...ls, { productId: prod.id, name: prod.name, unitPrice: prod.price, taxRate: prod.taxRate, qty: 1, stock: prod.stock, unit: prod.unit }]));
  };
  const scan = async (code: string) => {
    try {
      add(await api(`/bill/products/lookup?code=${encodeURIComponent(code)}`));
    } catch (e) {
      toastError(e instanceof ApiError && e.status === 404 ? new Error(`No product with code ${code}`) : e);
    }
  };
  const setQty = (id: string, qty: number) => setLines((ls) => ls.flatMap((l) => (l.productId !== id ? [l] : qty <= 0 ? [] : [{ ...l, qty }])));

  const t = computeTotals(lines, rupeesToPaise(discount || 0));
  const isSplit = method === "SPLIT";
  const parts = isSplit ? splitParts(split) : [];
  const splitCash = parts.filter((x) => x.method === "CASH").reduce((a, x) => a + x.amount, 0);
  const splitUpi = parts.filter((x) => x.method === "UPI").reduce((a, x) => a + x.amount, 0);
  // Cash received applies to a cash bill, or to the cash part of a split (change comes from that part only).
  const cashDue = method === "CASH" ? t.total : splitCash;
  const takesCash = cashDue > 0;
  const paid = takesCash && received ? t.total - cashDue + rupeesToPaise(received) : t.total;
  const change = Math.max(0, paid - t.total);
  const splitOk = !isSplit || splitReady(split, t.total);
  const over = lines.filter((l) => l.qty > l.stock && !p.settings.allowNegativeStock);
  const wantsCustomer = phone.replace(/\D/g, "").length >= 7;
  const canSaveCustomer = p.has("customers") && p.can("customers.manage");

  const complete = () => run(async () => {
    if (method === "CREDIT" && !wantsCustomer) throw new Error("Enter the customer's phone number for a credit sale.");
    const sale = await api<any>("/bill/sales", {
      body: {
        items: lines.map((l) => ({ productId: l.productId, qty: l.qty })), discount: rupeesToPaise(discount || 0), paymentMethod: method,
        ...(isSplit ? { split: parts } : {}),
        ...(takesCash && received ? { amountPaid: paid } : {}),
        ...(wantsCustomer && canSaveCustomer ? { customer: { name: custName.trim() || "Customer", phone: phone.trim() } } : {}),
        ...(counterId ? { counterId } : {}),
      },
    });
    setDone(sale);
    setLines([]); setDiscount(""); setReceived(""); setSplit(newSplit()); setMethod("CASH"); setPhone(""); setCustName(""); setQ("");
  });

  return (
    <>
      <PageHeader title="POS billing" description="Scan a barcode or search for a product. Prices and stock are confirmed by the server when you complete the sale." />
      <div className="grid gap-4 lg:grid-cols-[1fr_23rem]">
        <div className="space-y-4">
          <Card>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-[13px] font-medium text-slate-700">{p.has("barcode") ? "Scan barcode or type SKU" : "Type SKU"}</p>
                <ScanInput label="Scan barcode" placeholder="Scan or type a code, then Enter" formats={["ean_13", "ean_8", "code_128", "code_39", "upc_a", "upc_e"]} autoFocus onScan={scan} />
              </div>
              <div>
                <p className="mb-1 text-[13px] font-medium text-slate-700">Search by name</p>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" aria-hidden />
                  <Input aria-label="Search products" className="pl-9" placeholder="Product name..." value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
              </div>
            </div>
            {results.data && q.trim().length >= 2 && (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {results.data.items.map((r) => (
                  <li key={r.id}>
                    <button onClick={() => add(r)} disabled={r.stock <= 0 && !p.settings.allowNegativeStock} className="w-full rounded-lg border border-slate-200 p-2.5 text-left hover:border-brand disabled:opacity-50">
                      <span className="block truncate text-sm font-medium text-slate-900">{r.name}</span>
                      <span className="flex justify-between text-sm text-slate-600"><span>{formatINR(r.price)}</span><span className={r.stock <= 0 ? "text-red-700" : ""}>{r.stock <= 0 ? "Out of stock" : `${r.stock} ${r.unit}`}</span></span>
                    </button>
                  </li>
                ))}
                {!results.data.items.length && <li className="text-sm text-slate-500">No products match.</li>}
              </ul>
            )}
          </Card>
          <Card pad={false} title={`Bill items (${lines.length})`} actions={lines.length ? <Button size="sm" variant="ghost" onClick={() => setLines([])}>Clear</Button> : undefined}>
            <DataTable rows={lines} rowKey={(l) => l.productId} empty={<Empty title="No items yet" hint="Scan a barcode to start the bill." />}
              columns={[
                { key: "n", label: "Product", render: (l) => <>{l.name}{l.qty > l.stock && <span className="block text-xs text-red-700">Only {l.stock} {l.unit} in stock</span>}</> },
                { key: "p", label: "Price", align: "right", render: (l) => formatINR(l.unitPrice) },
                {
                  key: "q", label: "Qty", align: "center",
                  render: (l) => (
                    <span className="inline-flex items-center gap-1">
                      <button aria-label={`One less ${l.name}`} onClick={() => setQty(l.productId, l.qty - 1)} className="rounded-md border border-slate-300 p-1 hover:bg-slate-100"><Minus className="h-3.5 w-3.5" /></button>
                      <input aria-label={`Quantity of ${l.name}`} type="number" min="0" step="any" value={l.qty} onChange={(e) => setQty(l.productId, Number(e.target.value))} className="tnum h-8 w-14 rounded-md border border-slate-300 text-center text-sm" />
                      <button aria-label={`One more ${l.name}`} onClick={() => setQty(l.productId, l.qty + 1)} className="rounded-md border border-slate-300 p-1 hover:bg-slate-100"><Plus className="h-3.5 w-3.5" /></button>
                    </span>
                  ),
                },
                { key: "g", label: "GST", align: "right", render: (l) => `${l.taxRate / 100}%` },
                { key: "a", label: "Amount", align: "right", render: (l) => formatINR(Math.round(l.unitPrice * l.qty)) },
                { key: "x", label: "", align: "right", render: (l) => <button aria-label={`Remove ${l.name}`} onClick={() => setQty(l.productId, 0)} className="rounded p-1 text-slate-500 hover:bg-slate-100"><Trash2 className="h-4 w-4" /></button> },
              ]} />
          </Card>
        </div>

        <div ref={billRef} className="scroll-mt-20 lg:sticky lg:top-20 lg:self-start">
        <Card title="Payment">
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-slate-600">Subtotal</dt><dd className="tnum">{formatINR(t.subtotal)}</dd></div>
            {t.discount > 0 && <div className="flex justify-between"><dt className="text-slate-600">Discount</dt><dd className="tnum">- {formatINR(t.discount)}</dd></div>}
            <div className="flex justify-between"><dt className="text-slate-600">GST</dt><dd className="tnum">{formatINR(t.taxTotal)}</dd></div>
            <div className="flex justify-between border-t border-slate-200 pt-2 text-xl font-semibold"><dt>Total</dt><dd className="tnum">{formatINR(t.total)}</dd></div>
          </dl>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Field label="Payment"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{SALE_TENDERS.map((m) => <option key={m} value={m}>{tenderLabel(m)}</option>)}</Select></Field>
            <Field label="Discount (Rs)"><Input type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>
            {isSplit && <div className="col-span-2"><SplitPaymentEditor total={t.total} rows={split} onChange={setSplit} /></div>}
            {takesCash && <Field label={isSplit ? "Cash note received (Rs)" : "Cash received (Rs)"} className="col-span-2"><Input type="number" min="0" step="0.01" value={received} onChange={(e) => setReceived(e.target.value)} placeholder={String(cashDue / 100)} /></Field>}
            {takesCash && change > 0 && <p className="col-span-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">Return change: {formatINR(change)}</p>}
            {method === "UPI" && lines.length > 0 && <div className="col-span-2"><ShopUpiQr base={p.base} amount={t.total} /></div>}
            {isSplit && splitUpi > 0 && lines.length > 0 && <div className="col-span-2"><ShopUpiQr base={p.base} amount={splitUpi} /></div>}
            <Field label="Customer phone"><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional" /></Field>
            <Field label="Customer name"><Input value={custName} onChange={(e) => setCustName(e.target.value)} placeholder="Optional" /></Field>
            {(counters.data?.items.length ?? 0) > 1 && (
              <Field label="Counter" className="col-span-2"><Select value={counterId} onChange={(e) => setCounter(e.target.value)}><option value="">Not set</option>{counters.data!.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            )}
          </div>
          {over.length > 0 && <div className="mt-3"><Notice tone="bad">Reduce the quantity of {over.map((l) => l.name).join(", ")} - not enough stock.</Notice></div>}
          <Button variant="primary" size="lg" className="mt-3 w-full" loading={busy} disabled={!lines.length || over.length > 0 || !splitOk || (takesCash && !!received && paid < t.total)} onClick={complete}>
            Complete sale {formatINR(t.total)}
          </Button>
        </Card>
        </div>
      </div>
      <MobileBillBar count={lines.length} total={t.total} target={billRef} />

      <Modal open={!!done} onClose={() => setDone(null)} title="Sale completed" size="sm">
        {done && (
          <div className="space-y-4 text-center">
            <Check className="mx-auto h-10 w-10 rounded-full bg-emerald-100 p-2 text-emerald-700" aria-hidden />
            <div>
              <p className="text-lg font-semibold text-slate-900">{formatINR(done.total)} - {describePayment(done)}</p>
              <p className="text-sm text-slate-600">Bill #{formatDailyNo(done.dailyNo)} - Invoice {done.invoiceNo}</p>
              {done.changeDue > 0 && <p className="mt-1 text-base font-semibold text-emerald-800">Return change {formatINR(done.changeDue)}</p>}
            </div>
            <a href={done.invoiceUrl} target="_blank" rel="noreferrer"><Button className="w-full"><ExternalLink className="h-4 w-4" /> Open / print invoice</Button></a>
            <Button variant="primary" className="w-full" onClick={() => setDone(null)}>New sale</Button>
          </div>
        )}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Cashier dashboard, invoices, customers
// ---------------------------------------------------------------------------

export function BillCashier() {
  const p = useProduct();
  const c = useApi<any>("/bill/cashier", { refreshMs: 30_000 });
  return (
    <>
      <PageHeader title="My counter" description={`${p.user.fullName} - today's billing`} actions={<a href={`${p.base}/pos`}><Button variant="primary">Open POS</Button></a>} />
      <Loadable state={c}>
        {(d) => (
          <>
            <KpiRow cols={4}>
              <StatTile label="My sales today" value={formatINR(d.totals.amount, { whole: true })} sub={`${d.totals.count} bills`} />
              <StatTile label="Cash to hand over" value={formatINR(d.totals.cashInDrawer, { whole: true })} sub="cash sales today" />
              <StatTile label="UPI and card" value={formatINR((d.totals.byMethod.UPI ?? 0) + (d.totals.byMethod.CARD ?? 0), { whole: true })} />
              <StatTile label="Voided bills" value={d.totals.voided} tone={d.totals.voided ? "warn" : undefined} />
            </KpiRow>
            <Card pad={false} title="My bills today">
              <DataTable rows={d.recent} rowKey={(r: any) => r.id} empty={<Empty title="No bills yet today" />}
                columns={[
                  { key: "n", label: "Bill", render: (r: any) => <span className="font-medium">#{formatDailyNo(r.dailyNo)}</span> },
                  { key: "i", label: "Invoice", render: (r: any) => <span className="font-mono text-[13px]">{r.invoiceNo}</span> },
                  { key: "t", label: "Time", render: (r: any) => fmtTime(r.createdAt) },
                  { key: "c", label: "Customer", render: (r: any) => r.customer?.name ?? "-" },
                  { key: "m", label: "Method", render: (r: any) => describePayment(r) },
                  { key: "a", label: "Total", align: "right", render: (r: any) => formatINR(r.total) },
                  { key: "s", label: "Status", render: (r: any) => <StatusBadge value={r.status} /> },
                  { key: "x", label: "", align: "right", render: (r: any) => <a href={`/invoice/bill/${r.publicToken}`} target="_blank" rel="noreferrer" className="text-sm font-medium text-brand underline">Invoice</a> },
                ]} />
            </Card>
          </>
        )}
      </Loadable>
    </>
  );
}

export function BillSales() {
  const p = useProduct();
  const range = useRange("today", p.settings);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const list = useApi<{ items: any[]; total: number }>(`/bill/sales?${range.query}${q ? `&q=${encodeURIComponent(q)}` : ""}${status ? `&status=${status}` : ""}`);
  const [busy, run] = useAction();
  const canVoid = p.can("sales.void");
  return (
    <>
      <PageHeader title="Invoices" description="Every bill raised at the counter."
        actions={<>
          <Input aria-label="Search invoices" placeholder="Invoice no. or customer" className="w-52" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select aria-label="Status" className="w-32" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="COMPLETED">Completed</option><option value="VOID">Void</option></Select>
        </>} />
      <RangePicker state={range} />
      <Loadable state={list}>
        {(d) => (
          <Card pad={false} title={`${d.items.length} invoices`} subtitle={`Completed sales total ${formatINR(d.total)}`}>
            <DataTable rows={d.items} rowKey={(r) => r.id} empty={<Empty title="No invoices in this period" />}
              columns={[
                { key: "n", label: "Bill", render: (r) => <span className="font-medium" title={`Business day ${fmtDate(r.businessDate)}`}>#{formatDailyNo(r.dailyNo)}</span> },
                { key: "i", label: "Invoice", render: (r) => <span className="font-mono text-[13px]">{r.invoiceNo}</span> },
                { key: "t", label: "When", render: (r) => fmtDateTime(r.createdAt) },
                { key: "c", label: "Customer", render: (r) => (r.customer ? <>{r.customer.name}<span className="block text-xs text-slate-500">{r.customer.phone}</span></> : "-") },
                { key: "u", label: "Cashier", render: (r) => r.cashier?.fullName ?? "-" },
                { key: "n", label: "Items", align: "right", render: (r) => r.items.length },
                { key: "m", label: "Method", render: (r) => describePayment(r) },
                { key: "a", label: "Total", align: "right", render: (r) => formatINR(r.total) },
                { key: "s", label: "Status", render: (r) => <>{<StatusBadge value={r.status} />}{r.voidReason && <span className="block text-xs text-slate-500">{r.voidReason}</span>}</> },
                {
                  key: "x", label: "", align: "right",
                  render: (r) => (
                    <span className="flex items-center justify-end gap-2">
                      <a href={`/invoice/bill/${r.publicToken}`} target="_blank" rel="noreferrer" className="text-sm font-medium text-brand underline">Open</a>
                      {canVoid && r.status === "COMPLETED" && <Button size="sm" variant="ghost" loading={busy} onClick={() => { const reason = window.prompt("Reason for voiding this invoice? Items return to stock."); if (reason && reason.trim().length >= 3) void run(async () => { await api(`/bill/sales/${r.id}/void`, { body: { reason } }); await list.reload(); }, "Invoice voided"); }}>Void</Button>}
                    </span>
                  ),
                },
              ]} />
          </Card>
        )}
      </Loadable>
    </>
  );
}

export function BillCustomers() {
  const [history, setHistory] = useState<any | null>(null);
  return (
    <>
      <ResourcePage def={billCustomers} description="Customers are saved automatically when a phone number is entered at the POS."
        rowActions={(row) => <Button size="sm" variant="ghost" onClick={() => setHistory(row)}>History</Button>} />
      {history && <CustomerHistory customer={history} onClose={() => setHistory(null)} />}
    </>
  );
}

function CustomerHistory({ customer, onClose }: { customer: any; onClose: () => void }) {
  const h = useApi<any>(`/bill/customers/${customer.id}/history`);
  return (
    <Modal open onClose={onClose} title={`${customer.name} - purchase history`} size="lg">
      <Loadable state={h}>
        {(d) => (
          <>
            <KpiRow cols={3}>
              <StatTile label="Lifetime purchases" value={formatINR(d.lifetimeValue, { whole: true })} />
              <StatTile label="Visits" value={d.visits} />
              <StatTile label="Bought on credit" value={formatINR(d.creditOutstanding, { whole: true })} tone={d.creditOutstanding ? "warn" : undefined} />
            </KpiRow>
            <DataTable dense rows={d.sales} rowKey={(r: any) => r.id} empty={<Empty title="No purchases yet" />}
              columns={[
                { key: "i", label: "Invoice", render: (r: any) => <a className="font-mono text-[13px] text-brand underline" href={`/invoice/bill/${r.publicToken}`} target="_blank" rel="noreferrer">{r.invoiceNo}</a> },
                { key: "t", label: "Date", render: (r: any) => fmtDateTime(r.createdAt) },
                { key: "m", label: "Method", render: (r: any) => describePayment(r) },
                { key: "a", label: "Total", align: "right", render: (r: any) => formatINR(r.total) },
              ]} />
          </>
        )}
      </Loadable>
    </Modal>
  );
}

export { toast };
