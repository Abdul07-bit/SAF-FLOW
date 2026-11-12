"use client";

/**
 * Public QR menu and table ordering (SAF Dine Flow). Opened by scanning the QR
 * code on a table - no sign-in. The server decides whether the restaurant's
 * plan includes the QR menu and QR ordering; this page only reflects that.
 */
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock, Minus, Plus, ShoppingBag } from "lucide-react";
import { PRODUCTS } from "@/config/catalog";
import { formatINR } from "@/lib/money";
import { api, errorMessage, useApi } from "@/lib/client";
import { humanize } from "@/shared/fields";
import { themeVars } from "@/components/shell";
import { Button, Field, Input, Modal, Notice, Spinner, StatusBadge, Textarea } from "@/components/ui";

interface MenuItem { id: string; name: string; description: string | null; price: number; taxRate: number; isVeg: boolean | null; isAvailable: boolean }
interface MenuData {
  restaurant: { name: string; logoUrl: string | null; phone: string | null };
  table: string;
  orderingEnabled: boolean;
  categories: { id: string; name: string; items: MenuItem[] }[];
}
interface Tracking { restaurant: string; orderNo: number; status: string; table: string | null; items: { name: string; qty: number; status: string; amount: number }[]; total: number; invoiceReady: boolean }

const ITEM_STATUS: Record<string, string> = { PENDING_ACCEPT: "Waiting for confirmation", NEW: "Sent to kitchen", PREPARING: "Being prepared", READY: "Ready", SERVED: "Served", CANCELLED: "Cancelled" };

function VegMark({ veg }: { veg: boolean | null }) {
  if (veg === null || veg === undefined) return null;
  return (
    <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border-2 ${veg ? "border-emerald-700" : "border-red-700"}`} title={veg ? "Vegetarian" : "Non-vegetarian"}>
      <span className={`h-1.5 w-1.5 rounded-full ${veg ? "bg-emerald-700" : "bg-red-700"}`} aria-hidden />
      <span className="sr-only">{veg ? "Vegetarian" : "Non-vegetarian"}</span>
    </span>
  );
}

function OrderStatus({ token, onOrderMore }: { token: string; onOrderMore: () => void }) {
  const t = useApi<Tracking>(`/public/dine/orders/${token}`, { refreshMs: 15_000 });
  if (!t.data) return t.error ? <Notice tone="bad">{t.error.message}</Notice> : <Spinner label="Loading your order" />;
  const d = t.data;
  const waiting = d.items.some((i) => i.status === "PENDING_ACCEPT");
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">Your order #{d.orderNo}</h2>
        <StatusBadge value={d.status} />
      </div>
      {waiting && <p className="mt-2 flex items-center gap-1.5 text-sm text-amber-900"><Clock className="h-4 w-4" aria-hidden /> A waiter will confirm your order shortly.</p>}
      <ul className="mt-3 divide-y divide-slate-100">
        {d.items.map((i, n) => (
          <li key={n} className="flex items-start justify-between gap-3 py-2 text-sm">
            <span className={i.status === "CANCELLED" ? "text-slate-400 line-through" : "text-slate-900"}>{i.qty} x {i.name}<span className="block text-xs text-slate-500">{ITEM_STATUS[i.status] ?? humanize(i.status)}</span></span>
            <span className="tnum shrink-0 text-slate-700">{formatINR(i.amount)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 flex justify-between border-t border-slate-200 pt-2 text-sm font-semibold text-slate-900"><span>Total (incl. taxes)</span><span className="tnum">{formatINR(d.total)}</span></p>
      <div className="mt-3 flex flex-wrap gap-2">
        {d.invoiceReady
          ? <a href={`/invoice/dine/${token}`} className="inline-flex h-10 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink">View bill</a>
          : <Button onClick={onOrderMore}><Plus className="h-4 w-4" /> Order more</Button>}
      </div>
      {d.invoiceReady && <p className="mt-2 flex items-center gap-1.5 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" aria-hidden /> Paid. Thank you!</p>}
    </section>
  );
}

export default function QrMenuPage() {
  const { token } = useParams<{ token: string }>();
  const menu = useApi<MenuData>(`/public/dine/menu/${token}`);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [checkout, setCheckout] = useState(false);
  const [details, setDetails] = useState({ customerName: "", customerPhone: "", notes: "" });
  const [orderToken, setOrderToken] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const storageKey = `saf.qr.${token}`;

  useEffect(() => {
    const saved = window.sessionStorage.getItem(storageKey);
    if (saved) {
      setOrderToken(saved);
      setShowMenu(false);
    }
  }, [storageKey]);

  const items = useMemo(() => new Map((menu.data?.categories ?? []).flatMap((c) => c.items).map((i) => [i.id, i])), [menu.data]);
  const lines = Object.entries(cart).filter(([id, q]) => q > 0 && items.has(id)).map(([id, qty]) => ({ item: items.get(id)!, qty }));
  const count = lines.reduce((a, l) => a + l.qty, 0);
  const subtotal = lines.reduce((a, l) => a + l.item.price * l.qty, 0);
  const add = (id: string, delta: number) => setCart((c) => ({ ...c, [id]: Math.max(0, Math.min(50, (c[id] ?? 0) + delta)) }));

  const place = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ orderToken: string }>(`/public/dine/menu/${token}/order`, {
        noRedirect: true,
        body: {
          items: lines.map((l) => ({ menuItemId: l.item.id, qty: l.qty })),
          ...(details.customerName.trim() ? { customerName: details.customerName.trim() } : {}),
          ...(details.customerPhone.trim() ? { customerPhone: details.customerPhone.trim() } : {}),
          ...(details.notes.trim() ? { notes: details.notes.trim() } : {}),
        },
      });
      window.sessionStorage.setItem(storageKey, r.orderToken);
      setOrderToken(r.orderToken);
      setCart({});
      setCheckout(false);
      setShowMenu(false);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const theme = themeVars(PRODUCTS.dine.theme);
  if (menu.error && !menu.data) {
    return (
      <main style={theme} className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <h1 className="text-lg font-semibold text-slate-900">Menu not available</h1>
        <p className="mt-1 text-sm text-slate-600">{menu.error.status === 404 ? "This QR code is no longer active. Please ask a member of staff." : menu.error.message}</p>
      </main>
    );
  }
  if (!menu.data) return <div style={theme}><Spinner label="Loading menu" /></div>;
  const d = menu.data;
  const taxed = d.categories.some((c) => c.items.some((i) => i.taxRate > 0));

  return (
    <div style={theme} className="min-h-screen pb-28">
      <header className="bg-sidebar px-4 py-5 text-white">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {d.restaurant.logoUrl && <img src={d.restaurant.logoUrl} alt="" className="h-12 w-12 rounded-lg bg-white object-contain p-1" />}
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">{d.restaurant.name}</h1>
            <p className="text-sm text-sidebar-muted">Table {d.table}</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4">
        {orderToken && <OrderStatus token={orderToken} onOrderMore={() => setShowMenu(true)} />}
        {!d.orderingEnabled && <Notice tone="info">Browse the menu here and place your order with a waiter.</Notice>}

        {showMenu && (
          <>
            {d.categories.length > 1 && (
              <nav aria-label="Menu sections" className="sticky top-0 z-10 -mx-4 flex gap-2 overflow-x-auto bg-[#f4f5f7]/95 px-4 py-2 backdrop-blur">
                {d.categories.map((c) => <a key={c.id} href={`#c-${c.id}`} className="whitespace-nowrap rounded-full border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700">{c.name}</a>)}
              </nav>
            )}
            {!d.categories.length && <p className="py-10 text-center text-sm text-slate-500">The menu is being updated. Please ask a member of staff.</p>}
            {d.categories.map((c) => (
              <section key={c.id} id={`c-${c.id}`} className="scroll-mt-14">
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-600">{c.name}</h2>
                <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white">
                  {c.items.map((i) => {
                    const qty = cart[i.id] ?? 0;
                    return (
                      <li key={i.id} className="flex items-start gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className={`flex items-center gap-2 text-sm font-medium ${i.isAvailable ? "text-slate-900" : "text-slate-400"}`}><VegMark veg={i.isVeg} /> {i.name}</p>
                          {i.description && <p className="mt-0.5 text-xs text-slate-500">{i.description}</p>}
                          <p className="tnum mt-1 text-sm text-slate-800">{formatINR(i.price)}</p>
                        </div>
                        {!i.isAvailable ? <span className="self-center text-xs font-medium text-slate-500">Sold out</span> : d.orderingEnabled && (
                          qty === 0
                            ? <Button size="sm" className="self-center" onClick={() => add(i.id, 1)} aria-label={`Add ${i.name}`}><Plus className="h-3.5 w-3.5" /> Add</Button>
                            : (
                              <span className="flex items-center gap-1 self-center rounded-lg border border-brand">
                                <button className="p-2 text-brand" onClick={() => add(i.id, -1)} aria-label={`Remove one ${i.name}`}><Minus className="h-4 w-4" /></button>
                                <span className="tnum w-5 text-center text-sm font-semibold" aria-live="polite">{qty}</span>
                                <button className="p-2 text-brand" onClick={() => add(i.id, 1)} aria-label={`Add one more ${i.name}`}><Plus className="h-4 w-4" /></button>
                              </span>
                            )
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {taxed && <p className="text-center text-xs text-slate-500">Prices exclude applicable taxes.</p>}
          </>
        )}
        <p className="pt-4 text-center text-[11px] text-slate-400">Powered by SAF Dine Flow</p>
      </main>

      {d.orderingEnabled && showMenu && count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white p-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)]">
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
            <p className="text-sm text-slate-700"><span className="font-semibold text-slate-900">{count} item{count === 1 ? "" : "s"}</span> - <span className="tnum">{formatINR(subtotal)}</span></p>
            <Button variant="primary" size="lg" onClick={() => { setError(null); setCheckout(true); }}><ShoppingBag className="h-4 w-4" /> Review order</Button>
          </div>
        </div>
      )}

      <Modal open={checkout} title={`Your order - Table ${d.table}`} onClose={() => setCheckout(false)} footer={<><Button onClick={() => setCheckout(false)}>Back to menu</Button><Button variant="primary" loading={busy} disabled={!count} onClick={place}>Place order</Button></>}>
        <ul className="divide-y divide-slate-100">
          {lines.map((l) => (
            <li key={l.item.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-slate-900">{l.item.name}</span>
              <span className="flex items-center gap-1 rounded-lg border border-slate-300">
                <button className="p-1.5" onClick={() => add(l.item.id, -1)} aria-label={`Remove one ${l.item.name}`}><Minus className="h-3.5 w-3.5" /></button>
                <span className="tnum w-5 text-center font-semibold">{l.qty}</span>
                <button className="p-1.5" onClick={() => add(l.item.id, 1)} aria-label={`Add one more ${l.item.name}`}><Plus className="h-3.5 w-3.5" /></button>
              </span>
              <span className="tnum w-20 text-right text-slate-700">{formatINR(l.item.price * l.qty)}</span>
            </li>
          ))}
        </ul>
        <p className="flex justify-between border-t border-slate-200 pt-2 text-sm font-semibold"><span>Subtotal{taxed ? " (before taxes)" : ""}</span><span className="tnum">{formatINR(subtotal)}</span></p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Your name (optional)"><Input maxLength={60} autoComplete="name" value={details.customerName} onChange={(e) => setDetails((s) => ({ ...s, customerName: e.target.value }))} /></Field>
          <Field label="Phone (optional)" help="To receive your bill on WhatsApp."><Input type="tel" inputMode="tel" maxLength={20} autoComplete="tel" value={details.customerPhone} onChange={(e) => setDetails((s) => ({ ...s, customerPhone: e.target.value }))} /></Field>
          <Field label="Note for the kitchen (optional)" className="sm:col-span-2"><Textarea rows={2} maxLength={200} value={details.notes} onChange={(e) => setDetails((s) => ({ ...s, notes: e.target.value }))} /></Field>
        </div>
        {error && <div className="mt-3"><Notice tone="bad">{error}</Notice></div>}
      </Modal>
    </div>
  );
}
