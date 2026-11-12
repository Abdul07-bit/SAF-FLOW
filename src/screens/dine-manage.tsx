"use client";

import { useState } from "react";
import { Plus, Printer, QrCode, RefreshCw, SlidersHorizontal, Trash2 } from "lucide-react";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { api, useApi } from "@/lib/client";
import { f, humanize } from "@/shared/fields";
import { dineCategories, dineMenuItems, dineStockItems, dineSuppliers, dineTables } from "@/shared/resources";
import { BarList, ChartCard, ColumnChart, fmtCompactINR, Heatmap, heatmapTable, KpiRow, StatTile } from "@/components/charts";
import { FormModal, ResourcePage } from "@/components/forms";
import { useProduct } from "@/components/product-context";
import { emptyLine, LineItemsEditor, linesToWire, RangePicker, useRange, type Line } from "@/components/range";
import { Badge, Button, Card, DataTable, Empty, Field, Input, Loadable, Modal, Notice, PageHeader, Select, StatusBadge, Tabs, toast, useAction } from "@/components/ui";

// ---------------------------------------------------------------------------
// Tables & QR
// ---------------------------------------------------------------------------

export function DineTables() {
  const p = useProduct();
  const [qr, setQr] = useState<any | null>(null);
  return (
    <>
      <ResourcePage def={dineTables} title="Tables & QR codes" description="Print a QR code for each table. Guests scan it to see the menu and order."
        rowActions={(row) => p.has(["qr_menu", "qr_ordering"]) && row.isActive !== false && <Button size="sm" variant="ghost" onClick={() => setQr(row)}><QrCode className="h-3.5 w-3.5" /> QR</Button>} />
      {qr && <TableQr table={qr} onClose={() => setQr(null)} />}
    </>
  );
}

function TableQr({ table, onClose }: { table: any; onClose: () => void }) {
  const p = useProduct();
  const qr = useApi<{ url: string; dataUrl: string; table: string }>(`/dine/tables/${table.id}/qr`);
  const [busy, run] = useAction();
  return (
    <Modal open onClose={onClose} title={`QR code - Table ${table.name}`} size="sm"
      footer={<><Button loading={busy} onClick={() => window.confirm("Generate a new QR code? The printed one will stop working.") && run(async () => { await api(`/dine/tables/${table.id}/regenerate-qr`, { method: "POST" }); await qr.reload(); }, "New QR code generated")}><RefreshCw className="h-4 w-4" /> Regenerate</Button><Button variant="primary" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print</Button></>}>
      <Loadable state={qr}>
        {(d) => (
          <div className="text-center">
            <p className="text-lg font-semibold text-slate-900">{p.settings.restaurantName || p.tenant.name}</p>
            <p className="text-sm text-slate-600">Table {d.table} - scan to view the menu{p.has("qr_ordering") ? " and order" : ""}</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={d.dataUrl} alt={`QR code for table ${d.table}`} className="mx-auto my-3 h-56 w-56" />
            <p className="break-all text-xs text-slate-500">{d.url}</p>
          </div>
        )}
      </Loadable>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

export function DineMenu() {
  const [tab, setTab] = useState<"items" | "categories">("items");
  const [, run] = useAction();
  return (
    <>
      <PageHeader title="Menu" description="Categories, items, prices and GST. Changes show on the QR menu immediately." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "items", label: "Items" }, { key: "categories", label: "Categories" }]} />
      {tab === "categories" ? <ResourcePage def={dineCategories} embedded /> : (
        <ResourcePage def={dineMenuItems} embedded
          rowActions={(row, reload) => row.isActive !== false && (
            <Button size="sm" variant="ghost" onClick={() => run(async () => { await api(`/dine/menu-items/${row.id}/availability`, { body: { isAvailable: !row.isAvailable } }); reload(); })}>{row.isAvailable ? "Mark sold out" : "Mark available"}</Button>
          )} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Stock (Basic) + advanced
// ---------------------------------------------------------------------------

export function DineInventory() {
  const p = useProduct();
  const low = useApi<{ items: any[] }>(p.has("low_stock_alerts") ? "/dine/stock/low" : null);
  const [adjust, setAdjust] = useState<any | null>(null);
  const [version, setVersion] = useState(0);
  return (
    <>
      {!!low.data?.items.length && (
        <div className="mb-4"><Notice tone="warn" title={`${low.data.items.length} item${low.data.items.length > 1 ? "s are" : " is"} low on stock`}>{low.data.items.slice(0, 8).map((i) => `${i.name} (${i.quantity} ${i.unit})`).join(", ")}{low.data.items.length > 8 ? "..." : ""}</Notice></div>
      )}
      <ResourcePage key={version} def={dineStockItems} title="Stock"
        rowActions={(row) => p.can("inventory.manage") && row.isActive !== false && <Button size="sm" variant="ghost" onClick={() => setAdjust(row)}><SlidersHorizontal className="h-3.5 w-3.5" /> Adjust</Button>} />
      <FormModal
        open={!!adjust} title={`Adjust stock - ${adjust?.name ?? ""}`} submitLabel="Update stock" onClose={() => setAdjust(null)}
        intro={adjust && <p className="text-sm text-slate-600">In stock now: <strong>{adjust.quantity} {adjust.unit}</strong></p>}
        fields={{
          type: f.select("What happened", ["PURCHASE", "ADJUSTMENT"], { required: true, default: "PURCHASE", help: "Purchase = stock received. Adjustment = correction (use a minus for a reduction)." }),
          quantity: f.number("Quantity (+ or -)", { required: true }),
          reason: f.text("Note", { max: 200 }),
        }}
        onSubmit={async (v) => { await api(`/dine/stock-items/${adjust.id}/adjust`, { body: { ...v, reason: v.reason ?? undefined } }); toast("Stock updated"); setVersion((x) => x + 1); void low.reload(); }}
      />
    </>
  );
}

export function DineStockLedger() {
  const val = useApi<any>("/dine/stock/valuation");
  const moves = useApi<{ items: any[] }>("/dine/stock/movements");
  const [tab, setTab] = useState<"valuation" | "ledger">("valuation");
  return (
    <>
      <PageHeader title="Advanced stock" description="Stock value, 30-day consumption, days of cover and the full movement ledger." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "valuation", label: "Valuation & consumption" }, { key: "ledger", label: "Movement ledger" }]} />
      {tab === "valuation" ? (
        <Loadable state={val}>
          {(d) => (
            <>
              <KpiRow cols={3}>
                <StatTile label="Stock value at cost" value={formatINR(d.totalValue, { whole: true })} />
                <StatTile label="Items tracked" value={d.items.length} />
                <StatTile label="Items under 7 days of cover" value={d.items.filter((i: any) => i.daysOfCover !== null && i.daysOfCover < 7).length} />
              </KpiRow>
              <Card pad={false}>
                <DataTable rows={d.items} rowKey={(r: any) => r.id} empty={<Empty title="No stock items" />}
                  columns={[
                    { key: "n", label: "Item", render: (r: any) => r.name },
                    { key: "k", label: "Type", render: (r: any) => <Badge>{humanize(r.kind)}</Badge> },
                    { key: "q", label: "In stock", align: "right", render: (r: any) => `${r.quantity} ${r.unit}` },
                    { key: "v", label: "Value", align: "right", render: (r: any) => formatINR(r.value) },
                    { key: "u", label: "Used (30 d)", align: "right", render: (r: any) => r.used30d },
                    { key: "w", label: "Wasted (30 d)", align: "right", render: (r: any) => r.wasted30d },
                    { key: "c", label: "Days of cover", align: "right", render: (r: any) => (r.daysOfCover === null ? "-" : r.daysOfCover) },
                  ]} />
              </Card>
            </>
          )}
        </Loadable>
      ) : (
        <Card pad={false} subtitle="Last 30 days" title="Stock movements">
          <Loadable state={moves}>
            {(d) => (
              <DataTable dense rows={d.items} rowKey={(r) => r.id} empty={<Empty title="No movements yet" />}
                columns={[
                  { key: "t", label: "When", render: (r) => fmtDateTime(r.createdAt) },
                  { key: "i", label: "Item", render: (r) => r.stockItem.name },
                  { key: "ty", label: "Type", render: (r) => <Badge>{humanize(r.type)}</Badge> },
                  { key: "q", label: "Change", align: "right", render: (r) => `${r.quantity > 0 ? "+" : ""}${r.quantity} ${r.stockItem.unit}` },
                  { key: "b", label: "Balance", align: "right", render: (r) => r.balanceAfter },
                  { key: "r", label: "Reference", render: (r) => r.reference ?? r.reason ?? "-" },
                ]} />
            )}
          </Loadable>
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Recipes (ingredient management + automatic deduction)
// ---------------------------------------------------------------------------

export function DineRecipes() {
  const p = useProduct();
  const recipes = useApi<{ items: any[] }>("/dine/recipes");
  const [editing, setEditing] = useState<any | null>(null);
  return (
    <>
      <PageHeader title="Ingredients & recipes" description="Set what each dish uses per portion. Stock is deducted automatically when the bill is settled." />
      {!p.has("auto_deduction") && <div className="mb-4"><Notice tone="info">Automatic ingredient deduction is switched off for your account.</Notice></div>}
      <Card pad={false}>
        <Loadable state={recipes}>
          {(d) => (
            <DataTable rows={d.items} rowKey={(r) => r.id} empty={<Empty title="No menu items" hint="Add menu items first." />}
              columns={[
                { key: "n", label: "Dish", render: (r) => <>{r.name}<span className="block text-xs text-slate-500">{r.category}</span></> },
                { key: "r", label: "Uses per portion", render: (r) => (r.recipe.length ? <span className="block max-w-md whitespace-normal text-slate-700">{r.recipe.map((x: any) => `${x.quantity} ${x.unit} ${x.name}`).join(", ")}</span> : <span className="text-slate-400">No recipe</span>) },
                { key: "p", label: "Price", align: "right", render: (r) => formatINR(r.price) },
                { key: "c", label: "Food cost", align: "right", render: (r) => (r.recipe.length ? formatINR(r.foodCost) : "-") },
                { key: "pc", label: "Food cost %", align: "right", render: (r) => (r.recipe.length ? `${r.foodCostPct}%` : "-") },
                { key: "a", label: "", align: "right", render: (r) => <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>Edit recipe</Button> },
              ]} />
          )}
        </Loadable>
      </Card>
      {editing && <RecipeModal item={editing} onClose={() => setEditing(null)} onSaved={() => void recipes.reload()} />}
    </>
  );
}

function RecipeModal({ item, onClose, onSaved }: { item: any; onClose: () => void; onSaved: () => void }) {
  const stock = useApi<{ items: any[] }>("/dine/stock-items?pageSize=500");
  const [rows, setRows] = useState<{ stockItemId: string; quantity: string }[]>(item.recipe.length ? item.recipe.map((r: any) => ({ stockItemId: r.stockItemId, quantity: String(r.quantity) })) : [{ stockItemId: "", quantity: "" }]);
  const [busy, run] = useAction();
  const set = (i: number, patch: object) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = () => run(async () => {
    const items = rows.filter((r) => r.stockItemId && Number(r.quantity) > 0).map((r) => ({ stockItemId: r.stockItemId, quantity: Number(r.quantity) }));
    await api(`/dine/menu-items/${item.id}/recipe`, { method: "PUT", body: { items } });
    onSaved();
    onClose();
  }, "Recipe saved");
  return (
    <Modal open onClose={onClose} title={`Recipe - ${item.name}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save recipe</Button></>}>
      <p className="mb-3 text-sm text-slate-600">Quantity of each ingredient used for one portion.</p>
      <div className="space-y-2">
        {rows.map((r, i) => {
          const unit = stock.data?.items.find((s) => s.id === r.stockItemId)?.unit;
          return (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_7rem_3rem_2rem] items-center gap-2">
              <Select aria-label={`Ingredient ${i + 1}`} value={r.stockItemId} onChange={(e) => set(i, { stockItemId: e.target.value })}>
                <option value="">Select ingredient...</option>
                {stock.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
              <Input aria-label="Quantity per portion" type="number" min="0" step="any" placeholder="Qty" value={r.quantity} onChange={(e) => set(i, { quantity: e.target.value })} />
              <span className="text-sm text-slate-500">{unit ?? ""}</span>
              <button type="button" aria-label="Remove ingredient" onClick={() => setRows((rs) => (rs.length === 1 ? [{ stockItemId: "", quantity: "" }] : rs.filter((_, j) => j !== i)))} className="rounded p-1 text-slate-500 hover:bg-slate-100"><Trash2 className="h-4 w-4" /></button>
            </div>
          );
        })}
      </div>
      <Button size="sm" className="mt-2" onClick={() => setRows((rs) => [...rs, { stockItemId: "", quantity: "" }])}><Plus className="h-3.5 w-3.5" /> Add ingredient</Button>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Suppliers, purchases, wastage
// ---------------------------------------------------------------------------

export const DineSuppliers = () => <ResourcePage def={dineSuppliers} description="Vendors you buy ingredients and products from." />;

export function DinePurchases() {
  const list = useApi<{ items: any[] }>("/dine/purchases");
  const [creating, setCreating] = useState(false);
  const [busy, run] = useAction();
  return (
    <>
      <PageHeader title="Purchases" description="Purchase orders. Receiving adds stock and updates the item's cost." actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New purchase</Button>} />
      <Card pad={false}>
        <Loadable state={list}>
          {(d) => (
            <DataTable rows={d.items} rowKey={(r) => r.id} empty={<Empty title="No purchases yet" />}
              columns={[
                { key: "no", label: "PO", render: (r) => <span className="font-medium">#{r.purchaseNo}</span> },
                { key: "d", label: "Ordered", render: (r) => fmtDate(r.orderedAt) },
                { key: "s", label: "Supplier", render: (r) => r.supplier.name },
                { key: "i", label: "Items", render: (r) => <span className="block max-w-sm whitespace-normal text-slate-700">{r.items.map((i: any) => `${i.quantity} ${i.stockItem.unit} ${i.stockItem.name}`).join(", ")}</span> },
                { key: "t", label: "Total", align: "right", render: (r) => formatINR(r.total) },
                { key: "st", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
                {
                  key: "a", label: "", align: "right",
                  render: (r) => r.status === "ORDERED" && (
                    <span className="flex justify-end gap-1">
                      <Button size="sm" variant="primary" loading={busy} onClick={() => run(async () => { await api(`/dine/purchases/${r.id}/receive`, { method: "POST" }); await list.reload(); }, "Stock received")}>Receive</Button>
                      <Button size="sm" variant="ghost" onClick={() => window.confirm("Cancel this purchase order?") && run(async () => { await api(`/dine/purchases/${r.id}/cancel`, { method: "POST" }); await list.reload(); })}>Cancel</Button>
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
  const suppliers = useApi<{ items: any[] }>("/dine/suppliers?pageSize=500");
  const stock = useApi<{ items: any[] }>("/dine/stock-items?pageSize=500");
  const [supplierId, setSupplier] = useState("");
  const [invoiceRef, setRef] = useState("");
  const [receiveNow, setReceive] = useState(true);
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [busy, run] = useAction();
  return (
    <Modal open onClose={onClose} title="New purchase" size="lg">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api("/dine/purchases", { body: { supplierId, invoiceRef: invoiceRef || undefined, receiveNow, items: linesToWire(lines, "stockItemId") } }); onSaved(); onClose(); }, receiveNow ? "Purchase recorded and stock received" : "Purchase order created"); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier" required><Select required value={supplierId} onChange={(e) => setSupplier(e.target.value)}><option value="">Select...</option>{suppliers.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Supplier invoice no."><Input value={invoiceRef} maxLength={60} onChange={(e) => setRef(e.target.value)} /></Field>
        </div>
        {suppliers.data && !suppliers.data.items.length && <Notice tone="info">Add a supplier first (Suppliers).</Notice>}
        <LineItemsEditor lines={lines} onChange={setLines} options={(stock.data?.items ?? []).map((s) => ({ id: s.id, label: `${s.name} (${s.unit})` }))} itemLabel="Stock item" />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={receiveNow} onChange={(e) => setReceive(e.target.checked)} /> Goods already received - add to stock now</label>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save purchase</Button></div>
      </form>
    </Modal>
  );
}

export function DineWastage() {
  const range = useRange("30d");
  const list = useApi<{ items: any[]; totalCost: number }>(`/dine/wastage?${range.query}`);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Wastage" description="Record spoiled, spilled or expired stock. It is deducted from stock and valued at cost." actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Record wastage</Button>} />
      <RangePicker state={range} />
      <Loadable state={list}>
        {(d) => (
          <>
            <KpiRow cols={2}><StatTile label="Wastage cost in period" value={formatINR(d.totalCost)} /><StatTile label="Entries" value={d.items.length} /></KpiRow>
            <Card pad={false}>
              <DataTable rows={d.items} rowKey={(r) => r.id} empty={<Empty title="No wastage recorded in this period" />}
                columns={[
                  { key: "t", label: "When", render: (r) => fmtDateTime(r.createdAt) },
                  { key: "i", label: "Item", render: (r) => r.stockItem.name },
                  { key: "q", label: "Quantity", align: "right", render: (r) => `${r.quantity} ${r.stockItem.unit}` },
                  { key: "c", label: "Cost", align: "right", render: (r) => formatINR(r.costValue) },
                  { key: "r", label: "Reason", render: (r) => r.reason },
                ]} />
            </Card>
          </>
        )}
      </Loadable>
      <FormModal open={creating} title="Record wastage" onClose={() => setCreating(false)}
        fields={{ stockItemId: f.ref("Stock item", "/dine/stock-items", "name", { required: true }), quantity: f.number("Quantity wasted", { required: true, min: 0 }), reason: f.text("Reason", { required: true, max: 200, placeholder: "Spoiled, spilled, expired..." }) }}
        onSubmit={async (v) => { await api("/dine/wastage", { body: v }); toast("Wastage recorded"); await list.reload(); }} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Reports & analytics
// ---------------------------------------------------------------------------

export function DineReports() {
  const range = useRange("7d");
  const r = useApi<any>(`/dine/reports/sales?${range.query}`);
  return (
    <>
      <PageHeader title="Sales reports" description="Settled bills for the selected period." />
      <RangePicker state={range} print />
      <Loadable state={r}>
        {(d) => (
          <div className={r.refreshing ? "opacity-60" : ""}>
            <KpiRow cols={6}>
              <StatTile label="Net sales" value={formatINR(d.totals.net, { whole: true })} sub="incl. GST" />
              <StatTile label="Bills" value={d.totals.orders} />
              <StatTile label="Average bill" value={formatINR(d.totals.avgTicket, { whole: true })} />
              <StatTile label="Discounts" value={formatINR(d.totals.discount, { whole: true })} />
              <StatTile label="GST collected" value={formatINR(d.totals.tax, { whole: true })} />
              <StatTile label="Cancelled orders" value={d.totals.cancelled} />
            </KpiRow>
            <div className="grid gap-4 xl:grid-cols-2">
              <ChartCard className="xl:col-span-2" title="Daily sales" table={{ columns: ["Date", "Bills", "Sales"], rows: d.daily.map((x: any) => [fmtDate(x.date), x.orders, formatINR(x.sales)]) }}>
                <ColumnChart data={d.daily.map((x: any) => ({ label: fmtDate(x.date).slice(0, 6), value: x.sales }))} format={(n) => formatINR(n, { whole: true })} axisFormat={fmtCompactINR} />
              </ChartCard>
              <ChartCard title="Top items" subtitle="By revenue" table={{ columns: ["Item", "Qty", "Revenue"], rows: d.topItems.map((i: any) => [i.name, i.qty, formatINR(i.revenue)]) }}>
                <BarList data={d.topItems.map((i: any) => ({ label: i.name, value: i.revenue, sub: `${i.qty} sold` }))} format={(n) => formatINR(n, { whole: true })} />
              </ChartCard>
              <ChartCard title="Payment methods" table={{ columns: ["Method", "Amount"], rows: d.paymentSplit.map((m: any) => [humanize(m.method), formatINR(m.amount)]) }}>
                <BarList data={d.paymentSplit.map((m: any) => ({ label: humanize(m.method), value: m.amount }))} format={(n) => formatINR(n, { whole: true })} />
              </ChartCard>
            </div>
          </div>
        )}
      </Loadable>
    </>
  );
}

export function DineAnalytics() {
  const range = useRange("30d");
  const a = useApi<any>(`/dine/analytics?${range.query}`);
  return (
    <>
      <PageHeader title="Sales analytics" description="Peak hours, category mix, team performance and dish margins." />
      <RangePicker state={range} print />
      <Loadable state={a}>
        {(d) => (
          <div className={a.refreshing ? "opacity-60" : ""}>
            <KpiRow cols={5}>
              <StatTile label="Sales" value={formatINR(d.summary.sales, { whole: true })} delta={{ pct: d.summary.growthPct }} />
              <StatTile label="Bills" value={d.summary.orders} sub={`${d.summary.prevOrders} in the previous period`} />
              <StatTile label="Average bill" value={formatINR(d.summary.avgTicket, { whole: true })} />
              <StatTile label="Average prep time" value={d.summary.avgPrepMinutes === null ? "-" : `${d.summary.avgPrepMinutes} min`} sub="KOT sent to ready" />
              <StatTile label="Average guests per bill" value={d.summary.avgGuests} />
            </KpiRow>
            <div className="grid gap-4 xl:grid-cols-2">
              <ChartCard className="xl:col-span-2" title="When sales happen" subtitle="Sales by weekday and hour" table={heatmapTable(d.heatmap, (n) => formatINR(n))}>
                <Heatmap matrix={d.heatmap} format={(n) => formatINR(n, { whole: true })} />
              </ChartCard>
              <ChartCard title="Category mix" table={{ columns: ["Category", "Revenue"], rows: d.categoryMix.map((c: any) => [c.name, formatINR(c.amount)]) }}>
                <BarList data={d.categoryMix.map((c: any) => ({ label: c.name, value: c.amount }))} format={(n) => formatINR(n, { whole: true })} />
              </ChartCard>
              <ChartCard title="Order types" table={{ columns: ["Type", "Sales"], rows: d.orderTypes.map((c: any) => [humanize(c.type), formatINR(c.amount)]) }}>
                <BarList data={d.orderTypes.map((c: any) => ({ label: humanize(c.type), value: c.amount }))} format={(n) => formatINR(n, { whole: true })} />
                <p className="mt-3 text-xs text-slate-500">Order source: {d.sources.map((s: any) => `${humanize(s.source)} ${s.count}`).join(", ") || "-"}</p>
              </ChartCard>
              <Card pad={false} title="Waiter performance">
                <DataTable dense rows={d.waiters} rowKey={(r: any) => r.name} empty={<Empty title="No waiter-served bills in this period" />}
                  columns={[{ key: "n", label: "Waiter", render: (r: any) => r.name }, { key: "o", label: "Bills", align: "right", render: (r: any) => r.orders }, { key: "s", label: "Sales", align: "right", render: (r: any) => formatINR(r.sales) }]} />
              </Card>
              <Card pad={false} title="Dish performance" subtitle="Food cost uses current ingredient costs">
                <DataTable dense rows={d.items.slice(0, 30)} rowKey={(r: any) => r.name} empty={<Empty title="No sales in this period" />}
                  columns={[
                    { key: "n", label: "Dish", render: (r: any) => r.name },
                    { key: "q", label: "Qty", align: "right", render: (r: any) => r.qty },
                    { key: "r", label: "Revenue", align: "right", render: (r: any) => formatINR(r.revenue) },
                    { key: "c", label: "Food cost", align: "right", render: (r: any) => (r.foodCost ? formatINR(r.foodCost) : "-") },
                    { key: "m", label: "Margin", align: "right", render: (r: any) => (r.foodCost ? formatINR(r.margin) : "-") },
                  ]} />
              </Card>
            </div>
          </div>
        )}
      </Loadable>
    </>
  );
}
