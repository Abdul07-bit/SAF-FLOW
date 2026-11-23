"use client";

import { useMemo, useState } from "react";
import { BellRing, Check, ChefHat, ExternalLink, MessageCircle, Minus, Plus, QrCode, Search, Utensils } from "lucide-react";
import { fmtDateTime, fmtTime, todayIST } from "@/lib/dates";
import { computeTotals, formatINR, rupeesToPaise } from "@/lib/money";
import { api, qs, useApi } from "@/lib/client";
import { humanize } from "@/shared/fields";
import { BarList, ChartCard, ColumnChart, fmtCompactINR, KpiRow, StatTile } from "@/components/charts";
import { useProduct } from "@/components/product-context";
import { ShopUpiQr } from "@/components/shop-upi";
import { Badge, Button, Card, DataTable, Empty, Field, Input, Loadable, Modal, Notice, PageHeader, Select, StatusBadge, toast, useAction, cx } from "@/components/ui";
import { newSplit, SplitPaymentEditor, splitParts, splitReady, type SplitRow } from "@/components/split-payment";
import { describePayment } from "@/shared/tender";

export const TENDERS = ["CASH", "UPI", "CARD", "WALLET", "CREDIT", "OTHER"] as const;
/** Tenders for a sale or bill: the above plus "SPLIT" (e.g. Rs 400 UPI + Rs 300 cash). Not for stay payments. */
export const SALE_TENDERS = [...TENDERS, "SPLIT"] as const;
export const tenderLabel = (m: string) => (m === "SPLIT" ? "Split (UPI + Cash...)" : humanize(m));

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function DineDashboard() {
  const d = useApi<any>("/dine/dashboard", { refreshMs: 30_000 });
  const p = useProduct();
  return (
    <>
      <PageHeader title="Restaurant dashboard" description={`Today at ${p.tenant.name}`} />
      <Loadable state={d}>
        {(x) => (
          <>
            <KpiRow cols={6}>
              <StatTile label="Sales today" value={formatINR(x.salesToday, { whole: true })} />
              <StatTile label="Bills settled" value={x.ordersToday} />
              <StatTile label="Average bill" value={formatINR(x.avgTicket, { whole: true })} />
              <StatTile label="Open orders" value={x.openOrders} />
              <StatTile label="Kitchen queue" value={x.kitchenQueue} sub="tickets cooking" />
              <StatTile label="Low stock items" value={x.lowStockCount} tone={x.lowStockCount ? "warn" : undefined} />
            </KpiRow>
            <div className="grid gap-4 xl:grid-cols-3">
              <ChartCard className="xl:col-span-2" title="Sales by hour" subtitle="Settled bills today" table={{ columns: ["Hour", "Sales"], rows: x.hourly.map((h: any) => [`${h.hour}:00`, formatINR(h.sales)]) }}>
                <ColumnChart data={x.hourly.map((h: any) => ({ label: `${h.hour}`, value: h.sales }))} format={(n) => formatINR(n, { whole: true })} axisFormat={fmtCompactINR} emptyText="No bills settled yet today" />
              </ChartCard>
              <Card title="Tables">
                <ul className="space-y-2 text-sm">
                  {(["FREE", "OCCUPIED", "RESERVED", "CLEANING"] as const).map((s) => (
                    <li key={s} className="flex items-center justify-between"><StatusBadge value={s} /><span className="tnum font-semibold">{x.tables[s] ?? 0}</span></li>
                  ))}
                </ul>
              </Card>
              <ChartCard title="Top items today" subtitle="By quantity sold" table={{ columns: ["Item", "Qty", "Revenue"], rows: x.topItems.map((i: any) => [i.name, i.qty, formatINR(i.revenue)]) }}>
                <BarList data={x.topItems.map((i: any) => ({ label: i.name, value: i.qty, sub: formatINR(i.revenue, { whole: true }) }))} format={(n) => `${n}`} emptyText="Nothing sold yet today" />
              </ChartCard>
              <ChartCard title="Collections by payment method" table={{ columns: ["Method", "Amount"], rows: x.paymentSplit.map((m: any) => [humanize(m.method), formatINR(m.amount)]) }}>
                <BarList data={x.paymentSplit.map((m: any) => ({ label: humanize(m.method), value: m.amount }))} format={(n) => formatINR(n, { whole: true })} emptyText="No collections yet" />
              </ChartCard>
              <Card title="Low stock" subtitle={p.has("low_stock_alerts") ? "At or below the alert level" : undefined}>
                {!x.lowStock.length ? <p className="py-6 text-center text-sm text-slate-500">All stock levels are healthy.</p> : (
                  <ul className="divide-y divide-slate-100 text-sm">
                    {x.lowStock.map((s: any) => <li key={s.id} className="flex justify-between py-1.5"><span>{s.name}</span><span className="tnum text-amber-800">{s.quantity} {s.unit} <span className="text-slate-400">/ {s.reorderLevel}</span></span></li>)}
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
// Menu picker + cart (POS, waiter)
// ---------------------------------------------------------------------------

export interface CartLine {
  menuItemId: string;
  name: string;
  unitPrice: number;
  taxRate: number;
  qty: number;
}

export function useCart() {
  const [lines, setLines] = useState<CartLine[]>([]);
  const add = (m: any) => setLines((ls) => (ls.some((l) => l.menuItemId === m.id) ? ls.map((l) => (l.menuItemId === m.id ? { ...l, qty: l.qty + 1 } : l)) : [...ls, { menuItemId: m.id, name: m.name, unitPrice: m.price, taxRate: m.taxRate, qty: 1 }]));
  const bump = (id: string, by: number) => setLines((ls) => ls.flatMap((l) => (l.menuItemId !== id ? [l] : l.qty + by <= 0 ? [] : [{ ...l, qty: l.qty + by }])));
  return { lines, add, bump, clear: () => setLines([]), wire: lines.map((l) => ({ menuItemId: l.menuItemId, qty: l.qty })) };
}

function VegMark({ veg }: { veg: boolean }) {
  return <span title={veg ? "Vegetarian" : "Non-vegetarian"} className={cx("inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border text-[9px] font-bold", veg ? "border-emerald-700 text-emerald-700" : "border-red-700 text-red-700")}>{veg ? "V" : "N"}<span className="sr-only">{veg ? "Vegetarian" : "Non-vegetarian"}</span></span>;
}

export function MenuPicker({ onAdd, counts }: { onAdd: (item: any) => void; counts?: Record<string, number> }) {
  const menu = useApi<{ items: any[] }>("/dine/menu-items?pageSize=500");
  const [cat, setCat] = useState("ALL");
  const [q, setQ] = useState("");
  const cats = useMemo(() => [...new Set((menu.data?.items ?? []).map((i) => i.category?.name as string))], [menu.data]);
  const items = (menu.data?.items ?? []).filter((i) => (cat === "ALL" || i.category?.name === cat) && (!q || i.name.toLowerCase().includes(q.toLowerCase())));
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-3 h-4 w-4 text-slate-400" aria-hidden />
          <Input aria-label="Search menu" className="pl-8" placeholder="Search menu..." value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
        {["ALL", ...cats].map((c) => (
          <button key={c} onClick={() => setCat(c)} aria-pressed={cat === c} className={cx("whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium", cat === c ? "bg-brand text-brand-ink" : "bg-slate-100 text-slate-700 hover:bg-slate-200")}>{c === "ALL" ? "All" : c}</button>
        ))}
      </div>
      {!menu.data ? <p className="py-6 text-center text-sm text-slate-500">Loading menu...</p> : !items.length ? <Empty title="No menu items" hint="Add items under Menu first." /> : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {items.map((i) => (
            <button key={i.id} disabled={!i.isAvailable} onClick={() => onAdd(i)} className="relative rounded-lg border border-slate-200 bg-white p-2.5 text-left hover:border-brand disabled:opacity-50">
              <span className="flex items-start gap-1.5"><VegMark veg={i.isVeg} /><span className="min-w-0 flex-1 text-sm font-medium leading-tight text-slate-900">{i.name}</span></span>
              <span className="mt-1 block text-sm text-slate-600">{i.isAvailable ? formatINR(i.price, { whole: true }) : "Sold out"}</span>
              {!!counts?.[i.id] && <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1 text-xs font-semibold text-brand-ink">{counts[i.id]}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CartList({ cart }: { cart: ReturnType<typeof useCart> }) {
  if (!cart.lines.length) return <p className="py-6 text-center text-sm text-slate-500">Tap menu items to add them.</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {cart.lines.map((l) => (
        <li key={l.menuItemId} className="flex items-center gap-2 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate">{l.name}</span>
          <button aria-label={`One less ${l.name}`} onClick={() => cart.bump(l.menuItemId, -1)} className="rounded-md border border-slate-300 p-1 hover:bg-slate-100"><Minus className="h-3.5 w-3.5" /></button>
          <span className="tnum w-6 text-center font-semibold">{l.qty}</span>
          <button aria-label={`One more ${l.name}`} onClick={() => cart.bump(l.menuItemId, 1)} className="rounded-md border border-slate-300 p-1 hover:bg-slate-100"><Plus className="h-3.5 w-3.5" /></button>
          <span className="tnum w-20 text-right">{formatINR(l.unitPrice * l.qty)}</span>
        </li>
      ))}
    </ul>
  );
}

function Totals({ subtotal, discount, tax, total }: { subtotal: number; discount: number; tax: number; total: number }) {
  return (
    <dl className="space-y-1 border-t border-slate-200 pt-2 text-sm">
      <div className="flex justify-between"><dt className="text-slate-600">Subtotal</dt><dd className="tnum">{formatINR(subtotal)}</dd></div>
      {discount > 0 && <div className="flex justify-between"><dt className="text-slate-600">Discount</dt><dd className="tnum">- {formatINR(discount)}</dd></div>}
      <div className="flex justify-between"><dt className="text-slate-600">GST</dt><dd className="tnum">{formatINR(tax)}</dd></div>
      <div className="flex justify-between text-base font-semibold"><dt>Total</dt><dd className="tnum">{formatINR(total)}</dd></div>
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Settle panel + receipt (cashier, POS, order modal)
// ---------------------------------------------------------------------------

export function Receipt({ result, onClose }: { result: { order: any; invoiceUrl: string; whatsappUrl?: string }; onClose: () => void }) {
  const [phone, setPhone] = useState(result.order.customerPhone ?? "");
  const p = useProduct();
  const share = async () => {
    const r = await api<{ whatsappUrl: string }>(`/dine/orders/${result.order.id}/share${qs({ phone })}`);
    window.open(r.whatsappUrl, "_blank", "noopener");
  };
  return (
    <div className="space-y-4 text-center">
      <Check className="mx-auto h-10 w-10 rounded-full bg-emerald-100 p-2 text-emerald-700" aria-hidden />
      <div>
        <p className="text-lg font-semibold text-slate-900">Paid {formatINR(result.order.total)}</p>
        <p className="text-sm text-slate-600">Invoice {result.order.invoiceNo} - {describePayment(result.order)}</p>
      </div>
      <a href={result.invoiceUrl} target="_blank" rel="noreferrer"><Button className="w-full"><ExternalLink className="h-4 w-4" /> Open / print invoice</Button></a>
      {p.has("whatsapp_invoice") && (
        <div className="flex gap-2">
          <Input aria-label="Customer WhatsApp number" type="tel" placeholder="Customer WhatsApp number" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <Button onClick={share} disabled={phone.replace(/\D/g, "").length < 10}><MessageCircle className="h-4 w-4" /> Share</Button>
        </div>
      )}
      <Button variant="primary" className="w-full" onClick={onClose}>Done</Button>
    </div>
  );
}

export function SettleForm({ order, onSettled }: { order: any; onSettled: (r: any) => void }) {
  const p = useProduct();
  const [method, setMethod] = useState<string>("CASH");
  const [discount, setDiscount] = useState(order.discount ? String(order.discount / 100) : "");
  const [phone, setPhone] = useState(order.customerPhone ?? "");
  const [split, setSplit] = useState<SplitRow[]>(newSplit);
  const [busy, run] = useAction();
  const live = order.items.filter((i: any) => i.status !== "CANCELLED");
  const t = computeTotals(live.map((i: any) => ({ unitPrice: i.unitPrice, qty: i.qty, taxRate: i.taxRate })), rupeesToPaise(discount || 0));
  const isSplit = method === "SPLIT";
  const splitUpi = isSplit ? splitParts(split).filter((x) => x.method === "UPI").reduce((a, x) => a + x.amount, 0) : 0;
  return (
    <div className="space-y-3 rounded-lg bg-slate-50 p-3">
      <Totals subtotal={t.subtotal} discount={t.discount} tax={t.taxTotal} total={t.total} />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Payment"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{SALE_TENDERS.map((m) => <option key={m} value={m}>{tenderLabel(m)}</option>)}</Select></Field>
        {p.can("billing.discount") && <Field label="Discount (Rs)"><Input type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>}
        <Field label="Customer phone" className="col-span-2"><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="For the WhatsApp invoice" /></Field>
      </div>
      {isSplit && <SplitPaymentEditor total={t.total} rows={split} onChange={setSplit} />}
      {method === "UPI" && <ShopUpiQr base={p.base} amount={t.total} note={`Order ${order.orderNo}`} />}
      {isSplit && splitUpi > 0 && <ShopUpiQr base={p.base} amount={splitUpi} note={`Order ${order.orderNo}`} />}
      {order.publicToken && (
        <a href={`/invoice/dine/${order.publicToken}`} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-1.5 text-sm font-medium text-brand underline-offset-2 hover:underline">
          <ExternalLink className="h-4 w-4" /> Print / share bill (with UPI QR)
        </a>
      )}
      <Button variant="primary" size="lg" className="w-full" loading={busy} disabled={!live.length || (isSplit && !splitReady(split, t.total))}
        onClick={() => run(async () => onSettled(await api(`/dine/orders/${order.id}/settle`, { body: { paymentMethod: method, ...(isSplit ? { split: splitParts(split) } : {}), discount: rupeesToPaise(discount || 0), customerPhone: phone || undefined } })))}>
        Settle {formatINR(t.total)}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Order modal (waiter, cashier, orders)
// ---------------------------------------------------------------------------

export function OrderModal({ orderId, onClose, onChanged }: { orderId: string; onClose: () => void; onChanged: () => void }) {
  const p = useProduct();
  const o = useApi<any>(`/dine/orders/${orderId}`);
  const cart = useCart();
  const [adding, setAdding] = useState(false);
  const [receipt, setReceipt] = useState<any | null>(null);
  const [busy, run] = useAction();
  const act = (fn: () => Promise<unknown>, msg?: string) => run(async () => { await fn(); await o.reload(); onChanged(); }, msg);
  const canManage = p.can("orders.manage") && p.has(["orders", "waiter", "pos"]);
  const canSettle = p.can("billing.settle") && p.has(["cashier", "pos"]);

  return (
    <Modal open onClose={onClose} title={o.data ? `Order #${o.data.orderNo}${o.data.table ? ` - Table ${o.data.table.name}` : ` - ${humanize(o.data.type)}`}` : "Order"} size="lg">
      {receipt ? <Receipt result={receipt} onClose={onClose} /> : (
        <Loadable state={o}>
          {(d) => {
            const pending = d.items.filter((i: any) => i.status === "PENDING_ACCEPT");
            const open = d.status === "OPEN";
            return (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
                  <StatusBadge value={d.status} /><Badge>{humanize(d.source)}</Badge>
                  <span>{fmtDateTime(d.createdAt)}</span>
                  {d.waiter && <span>Waiter: {d.waiter.fullName}</span>}
                  {d.customerName && <span>Customer: {d.customerName}</span>}
                  {d.invoiceNo && <span>Invoice {d.invoiceNo}</span>}
                </div>
                {pending.length > 0 && p.has("qr_ordering") && canManage && (
                  <Notice tone="warn" title={`${pending.length} item${pending.length > 1 ? "s" : ""} ordered by the customer via QR`}
                    action={<span className="flex gap-1"><Button size="sm" variant="primary" loading={busy} onClick={() => act(() => api(`/dine/orders/${d.id}/accept`, { body: {} }), "Sent to kitchen")}>Accept</Button><Button size="sm" onClick={() => act(() => api(`/dine/orders/${d.id}/accept`, { body: { reject: true } }))}>Reject</Button></span>}>
                    Accept to send them to the kitchen.
                  </Notice>
                )}
                <DataTable
                  dense rows={d.items} rowKey={(r: any) => r.id} empty={<Empty title="No items yet" />}
                  columns={[
                    { key: "n", label: "Item", render: (r: any) => <span className={r.status === "CANCELLED" ? "text-slate-400 line-through" : ""}>{r.name}{r.notes && <span className="block text-xs text-slate-500">{r.notes}</span>}</span> },
                    { key: "q", label: "Qty", align: "right", render: (r: any) => r.qty },
                    { key: "a", label: "Amount", align: "right", render: (r: any) => formatINR(r.unitPrice * r.qty) },
                    { key: "s", label: "Status", render: (r: any) => <StatusBadge value={r.status} label={r.status === "PENDING_ACCEPT" ? "Awaiting accept" : r.status === "SENT" ? "In kitchen" : undefined} /> },
                    {
                      key: "act", label: "", align: "right",
                      render: (r: any) => open && canManage && r.status !== "CANCELLED" && r.status !== "SERVED" && (
                        <span className="flex justify-end gap-1">
                          {r.status === "READY" && <Button size="sm" variant="ghost" onClick={() => act(() => api(`/dine/order-items/${r.id}`, { method: "PATCH", body: { status: "SERVED" } }))}>Served</Button>}
                          <Button size="sm" variant="ghost" onClick={() => window.confirm(`Cancel ${r.name}?`) && act(() => api(`/dine/order-items/${r.id}`, { method: "PATCH", body: { status: "CANCELLED" } }))}>Cancel</Button>
                        </span>
                      ),
                    },
                  ]}
                />
                {open && canManage && (
                  adding ? (
                    <div className="rounded-lg border border-slate-200 p-3">
                      <MenuPicker onAdd={cart.add} counts={Object.fromEntries(cart.lines.map((l) => [l.menuItemId, l.qty]))} />
                      <div className="mt-3 border-t border-slate-100 pt-2"><CartList cart={cart} /></div>
                      <div className="mt-2 flex justify-end gap-2">
                        <Button onClick={() => { cart.clear(); setAdding(false); }}>Cancel</Button>
                        <Button variant="primary" disabled={!cart.lines.length} loading={busy} onClick={() => act(async () => { await api(`/dine/orders/${d.id}/items`, { body: { items: cart.wire } }); cart.clear(); setAdding(false); }, "Sent to kitchen")}><ChefHat className="h-4 w-4" /> Send to kitchen</Button>
                      </div>
                    </div>
                  ) : <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add items</Button>
                )}
                {open && canSettle ? <SettleForm order={d} onSettled={(r) => { setReceipt(r); onChanged(); }} /> : <Totals subtotal={d.subtotal} discount={d.discount} tax={d.taxTotal} total={d.total} />}
                {d.status === "PAID" && <a href={`/invoice/dine/${d.publicToken}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-brand underline"><ExternalLink className="h-4 w-4" /> Open invoice</a>}
                {open && p.can("billing.discount") && (
                  <Button variant="ghost" className="text-red-700" onClick={() => { const reason = window.prompt("Reason for cancelling this order?"); if (reason && reason.trim().length >= 3) void run(async () => { await api(`/dine/orders/${d.id}/cancel`, { body: { reason } }); onChanged(); onClose(); }, "Order cancelled"); }}>Cancel order</Button>
                )}
              </div>
            );
          }}
        </Loadable>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// POS billing
// ---------------------------------------------------------------------------

export function DinePos() {
  const p = useProduct();
  const cart = useCart();
  const tables = useApi<{ items: any[] }>("/dine/tables?pageSize=300");
  const [type, setType] = useState("TAKEAWAY");
  const [tableId, setTableId] = useState("");
  const [customerName, setName] = useState("");
  const [method, setMethod] = useState("CASH");
  const [discount, setDiscount] = useState("");
  const [split, setSplit] = useState<SplitRow[]>(newSplit);
  const [receipt, setReceipt] = useState<any | null>(null);
  const [busy, run] = useAction();
  const t = computeTotals(cart.lines, rupeesToPaise(discount || 0));
  const canSettle = p.can("billing.settle");
  const isSplit = method === "SPLIT";
  const splitUpi = isSplit ? splitParts(split).filter((x) => x.method === "UPI").reduce((a, x) => a + x.amount, 0) : 0;

  const create = () => api<any>("/dine/orders", { body: { type, tableId: type === "DINE_IN" ? tableId || null : null, source: "POS", customerName: customerName || undefined, items: cart.wire, sendToKitchen: true } });
  const reset = () => { cart.clear(); setName(""); setDiscount(""); setTableId(""); setMethod("CASH"); setSplit(newSplit()); void tables.reload(); };

  return (
    <>
      <PageHeader title="POS billing" description="Quick counter billing. Items go to the kitchen display as soon as the order is placed." />
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <Card><MenuPicker onAdd={cart.add} counts={Object.fromEntries(cart.lines.map((l) => [l.menuItemId, l.qty]))} /></Card>
        <Card title="Current bill" className="lg:sticky lg:top-20 lg:self-start">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Order type"><Select value={type} onChange={(e) => setType(e.target.value)}><option value="TAKEAWAY">Takeaway</option><option value="DINE_IN">Dine-in</option><option value="DELIVERY">Delivery</option></Select></Field>
            {type === "DINE_IN" ? (
              <Field label="Table" required><Select value={tableId} onChange={(e) => setTableId(e.target.value)}><option value="">Select...</option>{tables.data?.items.filter((x) => x.status === "FREE" || x.status === "RESERVED").map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
            ) : (
              <Field label="Customer"><Input value={customerName} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" /></Field>
            )}
          </div>
          <div className="mt-2"><CartList cart={cart} /></div>
          <Totals subtotal={t.subtotal} discount={t.discount} tax={t.taxTotal} total={t.total} />
          {canSettle && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Field label="Payment"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{SALE_TENDERS.map((m) => <option key={m} value={m}>{tenderLabel(m)}</option>)}</Select></Field>
              {p.can("billing.discount") && <Field label="Discount (Rs)"><Input type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>}
            </div>
          )}
          {canSettle && isSplit && <div className="mt-3"><SplitPaymentEditor total={t.total} rows={split} onChange={setSplit} /></div>}
          {canSettle && method === "UPI" && cart.lines.length > 0 && <div className="mt-3"><ShopUpiQr base={p.base} amount={t.total} /></div>}
          {canSettle && isSplit && splitUpi > 0 && cart.lines.length > 0 && <div className="mt-3"><ShopUpiQr base={p.base} amount={splitUpi} /></div>}
          <div className="mt-3 space-y-2">
            {canSettle && (
              <Button variant="primary" size="lg" className="w-full" loading={busy} disabled={!cart.lines.length || (type === "DINE_IN" && !tableId) || (isSplit && !splitReady(split, t.total))}
                onClick={() => run(async () => { const o = await create(); setReceipt(await api(`/dine/orders/${o.id}/settle`, { body: { paymentMethod: method, ...(isSplit ? { split: splitParts(split) } : {}), discount: rupeesToPaise(discount || 0) } })); reset(); })}>
                Bill & settle {formatINR(t.total)}
              </Button>
            )}
            <Button className="w-full" loading={busy} disabled={!cart.lines.length || (type === "DINE_IN" && !tableId)} onClick={() => run(async () => { const o = await create(); toast(`Order #${o.orderNo} sent to kitchen`); reset(); })}>
              <ChefHat className="h-4 w-4" /> Send to kitchen, pay later
            </Button>
          </div>
        </Card>
      </div>
      <Modal open={!!receipt} onClose={() => setReceipt(null)} title="Bill settled" size="sm">{receipt && <Receipt result={receipt} onClose={() => setReceipt(null)} />}</Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Waiter dashboard
// ---------------------------------------------------------------------------

const TABLE_TONE: Record<string, string> = { FREE: "border-emerald-300 bg-emerald-50", OCCUPIED: "border-sky-300 bg-sky-50", RESERVED: "border-amber-300 bg-amber-50", CLEANING: "border-slate-300 bg-slate-100" };

export function DineWaiter() {
  const p = useProduct();
  const board = useApi<any>("/dine/waiter/board", { refreshMs: 8_000 });
  const [openOrder, setOpenOrder] = useState<string | null>(null);
  const [newFor, setNewFor] = useState<any | null>(null);
  const [, run] = useAction();
  return (
    <>
      <PageHeader title="Waiter" description="Tap a table to take an order. Ready dishes appear at the top." />
      <Loadable state={board}>
        {(d) => (
          <div className="space-y-4">
            {d.pendingQr > 0 && <Notice tone="warn" title={`${d.pendingQr} table${d.pendingQr > 1 ? "s have" : " has"} a QR order waiting`}>Open the table to accept it.</Notice>}
            {d.ready.length > 0 && (
              <Card title={<span className="flex items-center gap-2"><BellRing className="h-4 w-4 text-brand" /> Ready to serve</span>}>
                <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {d.ready.map((k: any) => (
                    <li key={k.id} className="rounded-lg border border-emerald-300 bg-emerald-50 p-3">
                      <p className="text-sm font-semibold text-slate-900">{k.label} <span className="font-normal text-slate-500">KOT {k.kotNo}</span></p>
                      <p className="mt-0.5 text-sm text-slate-700">{k.items.map((i: any) => `${i.qty} x ${i.name}`).join(", ")}</p>
                      <Button size="sm" variant="primary" className="mt-2" onClick={() => run(async () => { await api(`/dine/kitchen/tickets/${k.id}/status`, { body: { status: "SERVED" } }); await board.reload(); }, "Marked served")}><Utensils className="h-3.5 w-3.5" /> Served</Button>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            <Card title="Tables">
              {!d.tables.length ? <Empty title="No tables set up" hint="A manager can add tables under Tables & QR." /> : (
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                  {d.tables.map((t: any) => (
                    <li key={t.id}>
                      <button onClick={() => (t.order ? setOpenOrder(t.order.id) : setNewFor(t))} className={cx("h-full w-full rounded-xl border-2 p-3 text-left transition hover:shadow", TABLE_TONE[t.status])}>
                        <span className="flex items-center justify-between"><span className="text-base font-semibold text-slate-900">{t.name}</span><span className="text-xs text-slate-600">{t.seats} seats</span></span>
                        <span className="mt-1 block"><StatusBadge value={t.status} /></span>
                        {t.order && (
                          <span className="mt-2 block text-xs text-slate-700">
                            #{t.order.orderNo} - {t.order.items} items - {formatINR(t.order.total, { whole: true })}
                            {t.order.pendingQr > 0 && <span className="mt-1 flex items-center gap-1 font-semibold text-amber-900"><QrCode className="h-3.5 w-3.5" /> {t.order.pendingQr} to accept</span>}
                            {t.order.ready > 0 && <span className="mt-1 block font-semibold text-emerald-800">{t.order.ready} ready</span>}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {d.takeaway.length > 0 && (
              <Card title="Takeaway / delivery orders" pad={false}>
                <ul className="divide-y divide-slate-100">{d.takeaway.map((o: any) => <li key={o.id}><button className="flex w-full justify-between px-4 py-2.5 text-left text-sm hover:bg-slate-50" onClick={() => setOpenOrder(o.id)}><span>#{o.orderNo} {humanize(o.type)}{o.customerName ? ` - ${o.customerName}` : ""}</span><span className="tnum font-medium">{formatINR(o.total)}</span></button></li>)}</ul>
              </Card>
            )}
          </div>
        )}
      </Loadable>
      {newFor && <NewTableOrder table={newFor} onClose={() => setNewFor(null)} onCreated={() => { setNewFor(null); void board.reload(); }} />}
      {openOrder && <OrderModal orderId={openOrder} onClose={() => { setOpenOrder(null); void board.reload(); }} onChanged={() => void board.reload()} />}
    </>
  );
}

function NewTableOrder({ table, onClose, onCreated }: { table: any; onClose: () => void; onCreated: () => void }) {
  const cart = useCart();
  const [guests, setGuests] = useState("2");
  const [busy, run] = useAction();
  return (
    <Modal open onClose={onClose} title={`New order - Table ${table.name}`} size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!cart.lines.length} onClick={() => run(async () => { await api("/dine/orders", { body: { tableId: table.id, type: "DINE_IN", source: "WAITER", guests: Math.max(1, Number(guests) || 1), items: cart.wire } }); onCreated(); }, "Order sent to kitchen")}><ChefHat className="h-4 w-4" /> Send to kitchen</Button></>}>
      <div className="grid gap-4 md:grid-cols-[1fr_16rem]">
        <MenuPicker onAdd={cart.add} counts={Object.fromEntries(cart.lines.map((l) => [l.menuItemId, l.qty]))} />
        <div>
          <Field label="Guests"><Input type="number" min="1" max="50" value={guests} onChange={(e) => setGuests(e.target.value)} /></Field>
          <div className="mt-2"><CartList cart={cart} /></div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Kitchen Display System
// ---------------------------------------------------------------------------

export function DineKds() {
  const p = useProduct();
  const k = useApi<{ items: any[]; serverTime: string }>("/dine/kitchen/tickets", { refreshMs: 5_000 });
  const [avail, setAvail] = useState(false);
  const [, run] = useAction();
  const move = (id: string, status: string) => run(async () => { await api(`/dine/kitchen/tickets/${id}/status`, { body: { status } }); await k.reload(); });
  const canUpdate = p.can("kitchen.update");
  const age = (iso: string) => Math.max(0, Math.round(((k.data ? new Date(k.data.serverTime).getTime() : Date.now()) - new Date(iso).getTime()) / 60_000));

  const column = (title: string, status: string, next?: { label: string; to: string }) => {
    const list = (k.data?.items ?? []).filter((t) => t.status === status);
    return (
      <section className="min-w-0 rounded-xl bg-slate-200/60 p-2.5">
        <h2 className="mb-2 flex items-center justify-between px-1 text-sm font-semibold text-slate-800">{title}<span className="rounded-full bg-white px-2 py-0.5 text-xs">{list.length}</span></h2>
        <ul className="space-y-2">
          {list.map((t) => {
            const mins = age(t.createdAt);
            return (
              <li key={t.id} className={cx("rounded-lg border-2 bg-white p-3 shadow-sm", status !== "READY" && mins >= 20 ? "border-red-400" : status !== "READY" && mins >= 10 ? "border-amber-400" : "border-transparent")}>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-base font-semibold text-slate-900">{t.label}</p>
                  <span className="whitespace-nowrap text-xs text-slate-600">KOT {t.kotNo} - {fmtTime(t.createdAt)}</span>
                </div>
                <p className={cx("text-xs font-medium", mins >= 20 ? "text-red-700" : mins >= 10 ? "text-amber-800" : "text-slate-500")}>{status === "READY" ? `Ready ${fmtTime(t.readyAt)}` : `${mins} min waiting${mins >= 20 ? " - overdue" : ""}`}</p>
                <ul className="mt-2 space-y-1">
                  {t.items.map((i: any) => <li key={i.id} className="text-[15px] text-slate-900"><span className="tnum font-semibold">{i.qty} x</span> {i.name}{i.notes && <span className="block text-xs text-amber-900">Note: {i.notes}</span>}</li>)}
                </ul>
                {t.order?.notes && <p className="mt-1 text-xs text-amber-900">Order note: {t.order.notes}</p>}
                {next && canUpdate && <Button variant="primary" className="mt-3 w-full" onClick={() => move(t.id, next.to)}>{next.label}</Button>}
              </li>
            );
          })}
          {!list.length && <li className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500">Nothing here</li>}
        </ul>
      </section>
    );
  };

  return (
    <>
      <PageHeader title="Kitchen display" description="New tickets appear automatically." actions={p.can(["menu.availability", "menu.manage"]) ? <Button onClick={() => setAvail(true)}>Item availability</Button> : undefined} />
      {k.error && !k.data ? <Notice tone="bad">{k.error.message}</Notice> : (
        <div className="grid gap-3 md:grid-cols-3">
          {column("New", "NEW", { label: "Start cooking", to: "PREPARING" })}
          {column("Preparing", "PREPARING", { label: "Mark ready", to: "READY" })}
          {column("Ready for pickup", "READY")}
        </div>
      )}
      {avail && <AvailabilityModal onClose={() => setAvail(false)} />}
    </>
  );
}

function AvailabilityModal({ onClose }: { onClose: () => void }) {
  const menu = useApi<{ items: any[] }>("/dine/menu-items?pageSize=500");
  const [, run] = useAction();
  return (
    <Modal open onClose={onClose} title="Item availability">
      <Loadable state={menu}>
        {(d) => (
          <ul className="divide-y divide-slate-100">
            {d.items.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>{i.name} <span className="text-slate-500">- {i.category?.name}</span></span>
                <Button size="sm" variant={i.isAvailable ? "secondary" : "danger"} onClick={() => run(async () => { await api(`/dine/menu-items/${i.id}/availability`, { body: { isAvailable: !i.isAvailable } }); await menu.reload(); })}>{i.isAvailable ? "Available" : "Sold out"}</Button>
              </li>
            ))}
          </ul>
        )}
      </Loadable>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Cashier dashboard
// ---------------------------------------------------------------------------

export function DineCashier() {
  const board = useApi<any>("/dine/cashier/board", { refreshMs: 10_000 });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Cashier" description="Settle bills and track today's collections." />
      <Loadable state={board}>
        {(d) => (
          <>
            <KpiRow cols={4}>
              <StatTile label="Collected today" value={formatINR(d.collections.total, { whole: true })} sub={`${d.collections.count} bills`} />
              <StatTile label="Cash" value={formatINR(d.collections.byMethod.CASH ?? 0, { whole: true })} />
              <StatTile label="UPI" value={formatINR(d.collections.byMethod.UPI ?? 0, { whole: true })} />
              <StatTile label="Card" value={formatINR(d.collections.byMethod.CARD ?? 0, { whole: true })} />
            </KpiRow>
            <div className="grid gap-4 xl:grid-cols-2">
              <Card pad={false} title="Bills to settle" subtitle={`${d.open.length} open`}>
                <DataTable rows={d.open} rowKey={(r: any) => r.id} onRowClick={(r: any) => setOpen(r.id)} empty={<Empty title="No open bills" />}
                  columns={[
                    { key: "o", label: "Order", render: (r: any) => <span className="font-medium">#{r.orderNo}</span> },
                    { key: "t", label: "Table / type", render: (r: any) => (r.table ? `Table ${r.table.name}` : humanize(r.type)) },
                    { key: "i", label: "Items", align: "right", render: (r: any) => r.items.filter((i: any) => i.status !== "CANCELLED").length },
                    { key: "a", label: "Amount", align: "right", render: (r: any) => formatINR(r.total) },
                    { key: "b", label: "", align: "right", render: () => <span className="text-sm font-medium text-brand">Settle</span> },
                  ]} />
              </Card>
              <Card pad={false} title="Settled today">
                <DataTable dense rows={d.settled} rowKey={(r: any) => r.id} onRowClick={(r: any) => setOpen(r.id)} empty={<Empty title="No bills settled yet" />}
                  columns={[
                    { key: "inv", label: "Invoice", render: (r: any) => <span className="font-mono text-[13px]">{r.invoiceNo}</span> },
                    { key: "t", label: "Table", render: (r: any) => r.table?.name ?? "-" },
                    { key: "time", label: "Time", render: (r: any) => fmtTime(r.paidAt) },
                    { key: "m", label: "Method", render: (r: any) => describePayment(r) },
                    { key: "a", label: "Amount", align: "right", render: (r: any) => formatINR(r.total) },
                  ]} />
              </Card>
            </div>
          </>
        )}
      </Loadable>
      {open && <OrderModal orderId={open} onClose={() => { setOpen(null); void board.reload(); }} onChanged={() => void board.reload()} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export function DineOrders() {
  const [status, setStatus] = useState("");
  const [date, setDate] = useState(todayIST());
  const [q, setQ] = useState("");
  const list = useApi<{ items: any[] }>(`/dine/orders${qs({ status, date, q })}`, { refreshMs: 20_000 });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Orders" description="Every order, with its items and status."
        actions={<>
          <Input aria-label="Search orders" placeholder="Order no., name, phone" className="w-48" value={q} onChange={(e) => setQ(e.target.value)} />
          <Input aria-label="Date" type="date" className="w-40" value={date} onChange={(e) => setDate(e.target.value)} />
          <Select aria-label="Status" className="w-32" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="OPEN">Open</option><option value="PAID">Paid</option><option value="CANCELLED">Cancelled</option></Select>
        </>} />
      <Card pad={false}>
        <Loadable state={list}>
          {(d) => (
            <DataTable rows={d.items} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r.id)} empty={<Empty title="No orders for this day" />}
              columns={[
                { key: "o", label: "Order", render: (r) => <span className="font-medium">#{r.orderNo}</span> },
                { key: "time", label: "Time", render: (r) => fmtTime(r.createdAt) },
                { key: "t", label: "Table / type", render: (r) => (r.table ? `Table ${r.table.name}` : humanize(r.type)) },
                { key: "src", label: "Source", render: (r) => <Badge>{humanize(r.source)}</Badge> },
                { key: "w", label: "Waiter", render: (r) => r.waiter?.fullName ?? "-" },
                { key: "i", label: "Items", align: "right", render: (r) => r.items.filter((i: any) => i.status !== "CANCELLED").length },
                { key: "a", label: "Amount", align: "right", render: (r) => formatINR(r.total) },
                { key: "s", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
              ]} />
          )}
        </Loadable>
      </Card>
      {open && <OrderModal orderId={open} onClose={() => { setOpen(null); void list.reload(); }} onChanged={() => void list.reload()} />}
    </>
  );
}
