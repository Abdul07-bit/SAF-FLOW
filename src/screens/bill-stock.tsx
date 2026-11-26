"use client";

import { useState } from "react";
import { ArrowRightLeft, PackagePlus, Plus } from "lucide-react";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { api, qs, useApi } from "@/lib/client";
import { f, humanize } from "@/shared/fields";
import { billCategories, billCounters, billProducts, billSuppliers } from "@/shared/resources";
import { BarList, ChartCard, ColumnChart, fmtCompactINR, Heatmap, heatmapTable, KpiRow, StatTile } from "@/components/charts";
import { FormModal, ResourcePage } from "@/components/forms";
import { useProduct } from "@/components/product-context";
import { emptyLine, LineItemsEditor, linesToWire, RangePicker, useRange, type Line } from "@/components/range";
import { Badge, Button, Card, DataTable, Empty, Field, Input, Loadable, Modal, Notice, PageHeader, Select, StatusBadge, Tabs, toast, useAction } from "@/components/ui";

const ADJUSTMENT_REASONS = ["DAMAGED", "EXPIRED", "THEFT_LOSS", "COUNT_CORRECTION", "RETURN_TO_SUPPLIER", "INTERNAL_USE", "OTHER"] as const;

export function BillProducts() {
  const [tab, setTab] = useState<"products" | "categories">("products");
  return (
    <>
      <PageHeader title="Products" description="Your catalog: prices, GST, barcodes and low-stock alert levels." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "products", label: "Products" }, { key: "categories", label: "Categories" }]} />
      {tab === "products" ? <ResourcePage def={billProducts} embedded /> : <ResourcePage def={billCategories} embedded />}
    </>
  );
}

export const BillSuppliers = () => <ResourcePage def={billSuppliers} description="Vendors you buy stock from." />;
export const BillCounters = () => <ResourcePage def={billCounters} description="Billing counters at this branch. Cashiers pick their counter at the POS; analytics compare them." />;

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

export function BillInventory() {
  const p = useProduct();
  const [q, setQ] = useState("");
  const [low, setLow] = useState(false);
  const stock = useApi<{ items: any[]; totals: any }>(`/bill/stock${qs({ q, low: low ? 1 : undefined })}`);
  const [stockIn, setStockIn] = useState<any | null>(null);
  const canStockIn = p.has("stock") && p.can("inventory.manage");
  return (
    <>
      <PageHeader title="Stock" description={`Stock on hand at ${p.branches.find((b) => b.id === p.branchId)?.name ?? "this branch"}.`}
        actions={<>
          <Input aria-label="Search stock" placeholder="Name, SKU or barcode" className="w-52" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="flex items-center gap-1.5 text-sm text-slate-700"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> Low stock only</label>
        </>} />
      <Loadable state={stock}>
        {(d) => (
          <>
            <KpiRow cols={3}>
              <StatTile label="Stock value at cost" value={formatINR(d.totals.costValue, { whole: true })} />
              <StatTile label="Stock value at selling price" value={formatINR(d.totals.retailValue, { whole: true })} />
              <StatTile label="Low stock products" value={d.totals.lowCount} tone={d.totals.lowCount ? "warn" : undefined} />
            </KpiRow>
            <Card pad={false}>
              <DataTable rows={d.items} rowKey={(r) => r.id} empty={<Empty title={low ? "Nothing is low on stock" : "No products yet"} />}
                columns={[
                  { key: "n", label: "Product", render: (r) => <>{r.name}<span className="block text-xs text-slate-500">{r.sku}{r.barcode ? ` - ${r.barcode}` : ""}</span></> },
                  { key: "c", label: "Category", render: (r) => r.category ?? "-" },
                  { key: "s", label: "In stock", align: "right", render: (r) => <span className={r.low ? "font-semibold text-amber-800" : ""}>{r.stock} {r.unit}</span> },
                  { key: "a", label: "Alert at", align: "right", render: (r) => r.reorderLevel },
                  { key: "l", label: "Level", render: (r) => (r.stock <= 0 ? <Badge tone="bad">Out of stock</Badge> : r.low ? <Badge tone="warn">Low</Badge> : <Badge tone="good">OK</Badge>) },
                  { key: "v", label: "Value at cost", align: "right", render: (r) => formatINR(r.costValue) },
                  { key: "x", label: "", align: "right", render: (r) => canStockIn && <Button size="sm" variant="ghost" onClick={() => setStockIn(r)}><PackagePlus className="h-3.5 w-3.5" /> Stock in</Button> },
                ]} />
            </Card>
          </>
        )}
      </Loadable>
      <FormModal open={!!stockIn} title={`Stock in - ${stockIn?.name ?? ""}`} submitLabel="Add stock" onClose={() => setStockIn(null)}
        intro={stockIn && <p className="text-sm text-slate-600">In stock now: <strong>{stockIn.stock} {stockIn.unit}</strong></p>}
        fields={{ quantity: f.number("Quantity received", { required: true, min: 0 }), reason: f.text("Note", { max: 200 }) }}
        onSubmit={async (v) => { await api(`/bill/stock/${stockIn.id}/stock-in`, { body: { quantity: v.quantity, reason: v.reason ?? undefined } }); toast("Stock added"); await stock.reload(); }} />
    </>
  );
}

export function BillAdjustments() {
  const p = useProduct();
  const range = useRange("30d");
  const list = useApi<{ items: any[] }>(`/bill/stock/adjustments?${range.query}`);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Stock adjustments" description="A permanent record of every correction: damage, expiry, loss or recount."
        actions={p.can("inventory.manage") ? <Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New adjustment</Button> : undefined} />
      <RangePicker state={range} />
      <Card pad={false}>
        <Loadable state={list}>
          {(d) => (
            <DataTable rows={d.items} rowKey={(r) => r.id} empty={<Empty title="No adjustments in this period" />}
              columns={[
                { key: "t", label: "When", render: (r) => fmtDateTime(r.createdAt) },
                { key: "p", label: "Product", render: (r) => <>{r.product.name}<span className="block text-xs text-slate-500">{r.product.sku}</span></> },
                { key: "q", label: "Change", align: "right", render: (r) => <span className={r.quantity < 0 ? "text-red-700" : "text-emerald-800"}>{r.quantity > 0 ? "+" : ""}{r.quantity} {r.product.unit}</span> },
                { key: "b", label: "Balance after", align: "right", render: (r) => r.balanceAfter },
                { key: "v", label: "Value at cost", align: "right", render: (r) => formatINR(Math.round(Math.abs(r.quantity) * r.product.costPrice)) },
                { key: "r", label: "Reason", render: (r) => humanize((r.reason ?? "").split(":")[0]) + ((r.reason ?? "").includes(":") ? ` -${(r.reason as string).split(":").slice(1).join(":")}` : "") },
              ]} />
          )}
        </Loadable>
      </Card>
      <FormModal open={creating} title="New stock adjustment" submitLabel="Record adjustment" onClose={() => setCreating(false)} base={p.base}
        fields={{
          productId: f.ref("Product", "/bill/products", "name", { required: true }),
          quantity: f.number("Quantity change (use a minus to reduce)", { required: true }),
          reason: f.select("Reason", ADJUSTMENT_REASONS, { required: true, default: "DAMAGED" }),
          note: f.text("Note", { max: 200 }),
        }}
        onSubmit={async (v) => { await api("/bill/stock/adjust", { body: { ...v, note: v.note ?? undefined } }); toast("Adjustment recorded"); await list.reload(); }} />
    </>
  );
}

export function BillValuation() {
  const p = useProduct();
  const [tab, setTab] = useState<"valuation" | "ledger" | "transfer">("valuation");
  const canTransfer = p.multiBranch && p.branches.length > 1 && p.can("inventory.manage");
  return (
    <>
      <PageHeader title="Advanced inventory" description="Valuation, fast and slow movers, the full stock ledger and branch transfers." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "valuation", label: "Valuation" }, { key: "ledger", label: "Stock ledger" }, ...(canTransfer ? [{ key: "transfer" as const, label: "Branch transfer" }] : [])]} />
      {tab === "valuation" ? <Valuation /> : tab === "ledger" ? <Ledger /> : <Transfer />}
    </>
  );
}

function Valuation() {
  const v = useApi<any>("/bill/stock/valuation");
  return (
    <Loadable state={v}>
      {(d) => (
        <>
          <KpiRow cols={4}>
            <StatTile label="Stock value at cost" value={formatINR(d.totals.costValue, { whole: true })} />
            <StatTile label="Value at selling price" value={formatINR(d.totals.retailValue, { whole: true })} />
            <StatTile label="Dead stock value" value={formatINR(d.totals.deadStockValue, { whole: true })} sub="no sales in 60 days" tone={d.totals.deadStockValue ? "warn" : undefined} />
            <StatTile label="Products" value={d.totals.skus} />
          </KpiRow>
          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard title="Fast movers" subtitle="Units sold in the last 60 days" table={{ columns: ["Product", "Sold", "In stock", "Days of cover"], rows: d.fastMovers.filter((x: any) => x.sold60d > 0).map((x: any) => [x.name, x.sold60d, x.stock, x.daysOfCover ?? "-"]) }}>
              <BarList data={d.fastMovers.map((x: any) => ({ label: x.name, value: x.sold60d, sub: x.daysOfCover === null ? undefined : `${x.daysOfCover} days of cover` }))} format={(n) => `${n}`} emptyText="No sales in the last 60 days" />
            </ChartCard>
            <Card pad={false} title="Dead stock" subtitle="In stock, but nothing sold in 60 days">
              <DataTable dense rows={d.deadStock} rowKey={(r: any) => r.id} empty={<Empty title="No dead stock" />}
                columns={[{ key: "n", label: "Product", render: (r: any) => r.name }, { key: "s", label: "In stock", align: "right", render: (r: any) => r.stock }, { key: "v", label: "Value at cost", align: "right", render: (r: any) => formatINR(r.costValue) }]} />
            </Card>
          </div>
        </>
      )}
    </Loadable>
  );
}

function Ledger() {
  const range = useRange("7d");
  const m = useApi<{ items: any[] }>(`/bill/stock/movements?${range.query}`);
  return (
    <>
      <RangePicker state={range} />
      <Card pad={false}>
        <Loadable state={m}>
          {(d) => (
            <DataTable dense rows={d.items} rowKey={(r) => r.id} empty={<Empty title="No stock movements in this period" />}
              columns={[
                { key: "t", label: "When", render: (r) => fmtDateTime(r.createdAt) },
                { key: "p", label: "Product", render: (r) => r.product.name },
                { key: "ty", label: "Type", render: (r) => <Badge>{humanize(r.type)}</Badge> },
                { key: "q", label: "Change", align: "right", render: (r) => `${r.quantity > 0 ? "+" : ""}${r.quantity} ${r.product.unit}` },
                { key: "b", label: "Balance", align: "right", render: (r) => r.balanceAfter },
                { key: "r", label: "Reference", render: (r) => r.reference ?? r.reason ?? "-" },
              ]} />
          )}
        </Loadable>
      </Card>
    </>
  );
}

function Transfer() {
  const p = useProduct();
  const products = useApi<{ items: any[] }>("/bill/products?pageSize=500");
  const [to, setTo] = useState("");
  const [lines, setLines] = useState<{ productId: string; quantity: string }[]>([{ productId: "", quantity: "" }]);
  const [busy, run] = useAction();
  const set = (i: number, patch: object) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const from = p.branches.find((b) => b.id === p.branchId);
  return (
    <Card title="Transfer stock to another branch" subtitle={`From ${from?.name ?? "this branch"}`} className="max-w-2xl">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await api<{ reference: string }>("/bill/stock/transfer", { body: { toBranchId: to, items: lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })) } }); toast(`Transferred - ${r.reference}`); setLines([{ productId: "", quantity: "" }]); await products.reload(); }); }}>
        <Field label="Destination branch" required><Select required value={to} onChange={(e) => setTo(e.target.value)}><option value="">Select...</option>{p.branches.filter((b) => b.id !== p.branchId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <div className="space-y-2">
          {lines.map((l, i) => {
            const prod = products.data?.items.find((x) => x.id === l.productId);
            return (
              <div key={i} className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2">
                <Select aria-label={`Product ${i + 1}`} required value={l.productId} onChange={(e) => set(i, { productId: e.target.value })}>
                  <option value="">Select product...</option>
                  {products.data?.items.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.stock} {x.unit} here)</option>)}
                </Select>
                <Input aria-label="Quantity" required type="number" min="0.001" max={prod?.stock} step="any" placeholder="Qty" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} />
              </div>
            );
          })}
        </div>
        <div className="flex justify-between">
          <Button size="sm" onClick={() => setLines((ls) => [...ls, { productId: "", quantity: "" }])}><Plus className="h-3.5 w-3.5" /> Add product</Button>
          <Button type="submit" variant="primary" loading={busy}><ArrowRightLeft className="h-4 w-4" /> Transfer</Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

export function BillPurchases() {
  const p = useProduct();
  const list = useApi<{ items: any[] }>("/bill/purchases");
  const [creating, setCreating] = useState(false);
  const [busy, run] = useAction();
  const canWrite = p.has("purchase_records") && p.can("purchases.manage");
  const canPo = p.has("purchase_management") && p.can("purchases.manage");
  return (
    <>
      <PageHeader title="Purchases" description={p.has("purchase_management") ? "Purchase orders and received stock." : "Stock you have bought. Recording a purchase adds it to stock."}
        actions={canWrite ? <Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Record purchase</Button> : undefined} />
      <Card pad={false}>
        <Loadable state={list}>
          {(d) => (
            <DataTable rows={d.items} rowKey={(r) => r.id} empty={<Empty title="No purchases yet" />}
              columns={[
                { key: "n", label: "No.", render: (r) => <span className="font-medium">#{r.purchaseNo}</span> },
                { key: "d", label: "Date", render: (r) => fmtDate(r.orderedAt) },
                { key: "s", label: "Supplier", render: (r) => r.supplier?.name ?? r.supplierName ?? "-" },
                { key: "ref", label: "Bill no.", render: (r) => r.invoiceRef ?? "-" },
                { key: "i", label: "Items", render: (r) => <span className="block max-w-sm whitespace-normal text-slate-700">{r.items.map((i: any) => `${i.quantity} ${i.product.unit} ${i.product.name}`).join(", ")}</span> },
                { key: "t", label: "Total", align: "right", render: (r) => formatINR(r.total) },
                { key: "st", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
                {
                  key: "x", label: "", align: "right",
                  render: (r) => r.status === "ORDERED" && canPo && (
                    <span className="flex justify-end gap-1">
                      <Button size="sm" variant="primary" loading={busy} onClick={() => run(async () => { await api(`/bill/purchases/${r.id}/receive`, { method: "POST" }); await list.reload(); }, "Stock received")}>Receive</Button>
                      <Button size="sm" variant="ghost" onClick={() => window.confirm("Cancel this purchase order?") && run(async () => { await api(`/bill/purchases/${r.id}/cancel`, { method: "POST" }); await list.reload(); })}>Cancel</Button>
                    </span>
                  ),
                },
              ]} />
          )}
        </Loadable>
      </Card>
      {creating && <PurchaseModal onClose={() => setCreating(false)} onSaved={() => void list.reload()} />}
    </>
  );
}

function PurchaseModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const p = useProduct();
  const hasSuppliers = p.has("suppliers");
  const suppliers = useApi<{ items: any[] }>(hasSuppliers ? "/bill/suppliers?pageSize=500" : null);
  const products = useApi<{ items: any[] }>("/bill/products?pageSize=500");
  const [supplierId, setSupplier] = useState("");
  const [supplierName, setName] = useState("");
  const [invoiceRef, setRef] = useState("");
  const [later, setLater] = useState(false);
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [busy, run] = useAction();
  return (
    <Modal open onClose={onClose} title="Record purchase" size="lg">
      <form className="space-y-4" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api("/bill/purchases", { body: { ...(supplierId ? { supplierId } : {}), supplierName: supplierName || undefined, invoiceRef: invoiceRef || undefined, status: later ? "ORDERED" : "RECEIVED", items: linesToWire(lines, "productId") } });
          onSaved();
          onClose();
        }, later ? "Purchase order created" : "Purchase recorded and stock added");
      }}>
        <div className="grid gap-3 sm:grid-cols-2">
          {hasSuppliers ? (
            <Field label="Supplier"><Select value={supplierId} onChange={(e) => setSupplier(e.target.value)}><option value="">Select...</option>{suppliers.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          ) : (
            <Field label="Supplier name"><Input value={supplierName} maxLength={100} onChange={(e) => setName(e.target.value)} /></Field>
          )}
          <Field label="Supplier bill no."><Input value={invoiceRef} maxLength={60} onChange={(e) => setRef(e.target.value)} /></Field>
        </div>
        <LineItemsEditor lines={lines} onChange={setLines} options={(products.data?.items ?? []).map((x) => ({ id: x.id, label: `${x.name} (${x.sku})` }))} itemLabel="Product" />
        {p.has("purchase_management") && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} /> Create as a purchase order - receive the stock later</label>}
        {!later && <Notice tone="info">Stock is added immediately and each product's cost price is updated.</Notice>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Reports & analytics
// ---------------------------------------------------------------------------

export function BillReports() {
  const range = useRange("7d", useProduct().settings);
  const r = useApi<any>(`/bill/reports/sales?${range.query}`);
  return (
    <>
      <PageHeader title="Sales reports" description="Completed bills for the selected period." />
      <RangePicker state={range} print />
      <Loadable state={r}>
        {(d) => (
          <div className={r.refreshing ? "opacity-60" : ""}>
            <KpiRow cols={6}>
              <StatTile label="Net sales" value={formatINR(d.totals.net, { whole: true })} sub="incl. GST" />
              <StatTile label="Bills" value={d.totals.bills} />
              <StatTile label="Average basket" value={formatINR(d.totals.avgBasket, { whole: true })} />
              <StatTile label="Discounts" value={formatINR(d.totals.discount, { whole: true })} />
              <StatTile label="GST collected" value={formatINR(d.totals.tax, { whole: true })} />
              <StatTile label="Voided" value={d.totals.voided} sub={d.totals.voided ? formatINR(d.totals.voidedAmount, { whole: true }) : undefined} />
            </KpiRow>
            <div className="grid gap-4 xl:grid-cols-3">
              <ChartCard className="xl:col-span-3" title="Daily sales" table={{ columns: ["Date", "Bills", "Sales"], rows: d.daily.map((x: any) => [fmtDate(x.date), x.bills, formatINR(x.sales)]) }}>
                <ColumnChart data={d.daily.map((x: any) => ({ label: fmtDate(x.date).slice(0, 6), value: x.sales }))} format={(n) => formatINR(n, { whole: true })} axisFormat={fmtCompactINR} />
              </ChartCard>
              <ChartCard title="Top products" subtitle="By revenue" table={{ columns: ["Product", "Qty", "Revenue"], rows: d.topProducts.map((x: any) => [x.name, x.qty, formatINR(x.revenue)]) }}>
                <BarList data={d.topProducts.map((x: any) => ({ label: x.name, value: x.revenue, sub: `${x.qty} sold` }))} format={(n) => formatINR(n, { whole: true })} />
              </ChartCard>
              <ChartCard title="Sales by category" table={{ columns: ["Category", "Revenue"], rows: d.byCategory.map((x: any) => [x.name, formatINR(x.amount)]) }}>
                <BarList data={d.byCategory.map((x: any) => ({ label: x.name, value: x.amount }))} format={(n) => formatINR(n, { whole: true })} />
              </ChartCard>
              <ChartCard title="Payment methods" table={{ columns: ["Method", "Amount"], rows: d.paymentSplit.map((x: any) => [humanize(x.method), formatINR(x.amount)]) }}>
                <BarList data={d.paymentSplit.map((x: any) => ({ label: humanize(x.method), value: x.amount }))} format={(n) => formatINR(n, { whole: true })} />
              </ChartCard>
            </div>
          </div>
        )}
      </Loadable>
    </>
  );
}

export function BillAnalytics() {
  const range = useRange("30d");
  const a = useApi<any>(`/bill/analytics?${range.query}`);
  return (
    <>
      <PageHeader title="Analytics" description="Margins, peak hours, counter and cashier performance, and your best customers." />
      <RangePicker state={range} print />
      <Loadable state={a}>
        {(d) => (
          <div className={a.refreshing ? "opacity-60" : ""}>
            <KpiRow cols={6}>
              <StatTile label="Sales" value={formatINR(d.summary.sales, { whole: true })} delta={{ pct: d.summary.growthPct }} />
              <StatTile label="Bills" value={d.summary.bills} />
              <StatTile label="Average basket" value={formatINR(d.summary.avgBasket, { whole: true })} />
              <StatTile label="Gross margin" value={formatINR(d.summary.grossMargin, { whole: true })} sub={`${d.summary.marginPct}% of sales before GST`} />
              <StatTile label="Bills with a customer" value={`${d.summary.identifiedCustomerPct}%`} />
              <StatTile label="Repeat customers" value={d.summary.repeatCustomers} />
            </KpiRow>
            <div className="grid gap-4 xl:grid-cols-2">
              <ChartCard className="xl:col-span-2" title="When sales happen" subtitle="Sales by weekday and hour" table={heatmapTable(d.heatmap, (n) => formatINR(n))}>
                <Heatmap matrix={d.heatmap} format={(n) => formatINR(n, { whole: true })} />
              </ChartCard>
              <Card pad={false} title="Margin by category">
                <DataTable dense rows={d.categoryMargin} rowKey={(r: any) => r.name} empty={<Empty title="No sales in this period" />}
                  columns={[
                    { key: "n", label: "Category", render: (r: any) => r.name },
                    { key: "r", label: "Revenue", align: "right", render: (r: any) => formatINR(r.revenue) },
                    { key: "c", label: "Cost", align: "right", render: (r: any) => formatINR(r.cost) },
                    { key: "m", label: "Margin", align: "right", render: (r: any) => formatINR(r.margin) },
                    { key: "p", label: "Margin %", align: "right", render: (r: any) => `${r.marginPct}%` },
                  ]} />
              </Card>
              <ChartCard title="Items per bill" subtitle="Number of bills by basket size" table={{ columns: ["Items in bill", "Bills"], rows: d.basketSize.map((b: any) => [b.bucket, b.count]) }}>
                <ColumnChart data={d.basketSize.map((b: any) => ({ label: b.bucket, value: b.count }))} format={(n) => `${n} bills`} axisFormat={(n) => `${n}`} height={150} />
              </ChartCard>
              <ChartCard title="Sales by counter" table={{ columns: ["Counter", "Bills", "Sales"], rows: d.counters.map((c: any) => [c.name, c.bills, formatINR(c.sales)]) }}>
                <BarList data={d.counters.map((c: any) => ({ label: c.name, value: c.sales, sub: `${c.bills} bills` }))} format={(n) => formatINR(n, { whole: true })} />
              </ChartCard>
              <ChartCard title="Sales by cashier" table={{ columns: ["Cashier", "Bills", "Sales"], rows: d.cashiers.map((c: any) => [c.name, c.bills, formatINR(c.sales)]) }}>
                <BarList data={d.cashiers.map((c: any) => ({ label: c.name, value: c.sales, sub: `${c.bills} bills` }))} format={(n) => formatINR(n, { whole: true })} />
              </ChartCard>
              <Card pad={false} title="Top customers" className="xl:col-span-2">
                <DataTable dense rows={d.topCustomers} rowKey={(r: any) => r.id ?? r.name} empty={<Empty title="No customer-linked bills in this period" />}
                  columns={[{ key: "n", label: "Customer", render: (r: any) => r.name ?? "-" }, { key: "p", label: "Phone", render: (r: any) => r.phone ?? "-" }, { key: "b", label: "Bills", align: "right", render: (r: any) => r.bills }, { key: "s", label: "Spent", align: "right", render: (r: any) => formatINR(r.sales) }]} />
              </Card>
            </div>
          </div>
        )}
      </Loadable>
    </>
  );
}
