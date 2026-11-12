"use client";

import { useState } from "react";
import { ExternalLink, LogIn, LogOut, Plus, Star } from "lucide-react";
import { addDays, daysBetween, fmtDate, fmtDateTime, todayIST } from "@/lib/dates";
import { formatINR, rupeesToPaise } from "@/lib/money";
import { api, qs, useApi } from "@/lib/client";
import { f, humanize } from "@/shared/fields";
import { ID_TYPES } from "@/shared/resources";
import { KpiRow, Meter, StatTile } from "@/components/charts";
import { FormModal } from "@/components/forms";
import { useProduct } from "@/components/product-context";
import { RangePicker, useRange } from "@/components/range";
import { Badge, Button, Card, DataTable, Empty, Field, Input, KeyValue, Loadable, Modal, Notice, PageHeader, Select, StatusBadge, Tabs, Textarea, toast, useAction, cx } from "@/components/ui";
import { TENDERS } from "./dine-service";

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function StayDashboard() {
  const p = useProduct();
  const d = useApi<any>("/stay/dashboard", { refreshMs: 60_000 });
  return (
    <>
      <PageHeader title="Hotel dashboard" description={`${p.tenant.name} - ${fmtDate(todayIST())}`} />
      <Loadable state={d}>
        {(x) => (
          <>
            <KpiRow cols={4}>
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-[13px] text-slate-600">Occupancy tonight</p>
                <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{x.occupancyPct}%</p>
                <div className="mt-2"><Meter value={x.occupied} max={x.sellable} label="Occupancy" /></div>
                <p className="mt-1.5 text-xs text-slate-500">{x.occupied} of {x.sellable} rooms{x.outOfOrder ? `, ${x.outOfOrder} out of order` : ""}</p>
              </div>
              <StatTile label="Guests in house" value={x.inHouse} sub="checked-in stays" />
              <StatTile label="Arrivals due" value={x.arrivals} sub={`${x.upcomingArrivals7d} more in the next 7 days`} />
              <StatTile label="Departures due" value={x.departures} tone={x.departures ? "warn" : undefined} />
              <StatTile label="Collected today" value={formatINR(x.collectedToday, { whole: true })} />
              <StatTile label="Collected this month" value={formatINR(x.collectedMtd, { whole: true })} />
              <StatTile label="Room revenue this month" value={formatINR(x.roomRevenueMtd, { whole: true })} sub={`Average rate ${formatINR(x.adrMtd, { whole: true })}`} />
              <StatTile label="Expenses this month" value={formatINR(x.expensesMtd, { whole: true })} />
            </KpiRow>
            <Card title="Housekeeping status" className="max-w-xl">
              <ul className="space-y-2 text-sm">
                {(["CLEAN", "INSPECTED", "IN_PROGRESS", "DIRTY"] as const).map((s) => (
                  <li key={s} className="flex items-center justify-between"><StatusBadge value={s} label={s === "IN_PROGRESS" ? "Being cleaned" : undefined} /><span className="tnum font-semibold">{x.housekeeping[s]} rooms</span></li>
                ))}
              </ul>
            </Card>
          </>
        )}
      </Loadable>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reservation detail + folio
// ---------------------------------------------------------------------------

export function ReservationModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const p = useProduct();
  const r = useApi<any>(`/stay/reservations/${id}`);
  const [panel, setPanel] = useState<null | "charge" | "payment" | "checkin" | "checkout">(null);
  const [busy, run] = useAction();
  const done = async () => { await r.reload(); onChanged(); };
  const canBill = p.has("room_billing") && p.can("billing.manage");
  const canCheck = p.has("checkin_checkout") && p.can("checkin.perform");

  return (
    <Modal open onClose={onClose} title={r.data ? `Reservation #${r.data.reservationNo} - ${r.data.guest.fullName}` : "Reservation"} size="lg">
      <Loadable state={r}>
        {(d) => {
          const fo = d.folio;
          return (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <KeyValue items={[
                  ["Status", <StatusBadge key="s" value={d.status} />],
                  ["Stay", `${fmtDate(d.checkInDate)} to ${fmtDate(d.checkOutDate)} (${fo.nights} night${fo.nights > 1 ? "s" : ""})`],
                  ["Room", d.room ? `${d.room.number} - ${d.roomType.name}` : `${d.roomType.name} (not assigned)`],
                  ["Occupancy", `${d.adults} adult${d.adults > 1 ? "s" : ""}${d.children ? `, ${d.children} children` : ""}`],
                  ["Rate", `${formatINR(d.ratePerNight)} per night + ${d.taxRate / 100}% GST`],
                  ["Source", humanize(d.source)],
                ]} />
                <KeyValue items={[
                  ["Guest", <span key="g">{d.guest.fullName}{d.guest.isVip && <Badge tone="brand" className="ml-1.5"><Star className="h-3 w-3" /> VIP</Badge>}</span>],
                  ["Phone", d.guest.phone],
                  ["ID proof", d.guest.idType ? `${humanize(d.guest.idType)} ${d.guest.idNumber ?? ""}` : <span key="i" className="text-amber-800">Not recorded</span>],
                  ["Requests", d.specialRequests],
                  ...(d.invoiceNo ? [["Invoice", d.invoiceNo] as [string, string]] : []),
                ]} />
              </div>

              <Card pad={false} title="Folio" actions={(d.status === "CHECKED_IN" || d.status === "CONFIRMED") && canBill ? <><Button size="sm" onClick={() => setPanel("charge")}><Plus className="h-3.5 w-3.5" /> Charge</Button><Button size="sm" onClick={() => setPanel("payment")}><Plus className="h-3.5 w-3.5" /> Payment</Button></> : undefined}>
                <DataTable dense rows={fo.lines} rowKey={(l: any) => l.id}
                  columns={[
                    { key: "d", label: "Charge", render: (l: any) => <>{l.description}{l.projected && <Badge className="ml-1.5">Estimate</Badge>}</> },
                    { key: "a", label: "Amount", align: "right", render: (l: any) => formatINR(l.amount) },
                    { key: "t", label: "GST", align: "right", render: (l: any) => formatINR(l.tax) },
                    { key: "x", label: "", align: "right", render: (l: any) => !l.projected && l.type !== "ROOM" && d.status !== "CHECKED_OUT" && canBill && <Button size="sm" variant="ghost" onClick={() => window.confirm("Remove this charge?") && run(async () => { await api(`/stay/charges/${l.id}`, { method: "DELETE" }); await done(); })}>Remove</Button> },
                  ]} />
                <dl className="space-y-1 border-t border-slate-200 px-4 py-3 text-sm">
                  <div className="flex justify-between"><dt className="text-slate-600">Total (incl. GST {formatINR(fo.tax)})</dt><dd className="tnum font-semibold">{formatINR(fo.total)}</dd></div>
                  {d.payments.map((pay: any) => <div key={pay.id} className="flex justify-between text-slate-600"><dt>Paid {fmtDateTime(pay.createdAt)} - {humanize(pay.method)}</dt><dd className="tnum">- {formatINR(pay.amount)}</dd></div>)}
                  <div className="flex justify-between text-base font-semibold"><dt>{fo.balance < 0 ? "Refund due" : "Balance due"}</dt><dd className={cx("tnum", fo.balance > 0 && "text-red-700")}>{formatINR(Math.abs(fo.balance))}</dd></div>
                </dl>
              </Card>

              <div className="flex flex-wrap gap-2">
                {d.status === "CONFIRMED" && canCheck && <Button variant="primary" onClick={() => setPanel("checkin")}><LogIn className="h-4 w-4" /> Check in</Button>}
                {d.status === "CHECKED_IN" && canCheck && <Button variant="primary" onClick={() => setPanel("checkout")}><LogOut className="h-4 w-4" /> Check out</Button>}
                {d.status === "CHECKED_OUT" && <a href={`/invoice/stay/${d.publicToken}`} target="_blank" rel="noreferrer"><Button><ExternalLink className="h-4 w-4" /> Open invoice</Button></a>}
                {d.status === "CONFIRMED" && p.can("reservations.manage") && (
                  <>
                    <Button variant="ghost" loading={busy} onClick={() => window.confirm("Cancel this reservation?") && run(async () => { await api(`/stay/reservations/${id}/cancel`, { body: {} }); await done(); }, "Reservation cancelled")}>Cancel reservation</Button>
                    <Button variant="ghost" onClick={() => window.confirm("Mark as no-show?") && run(async () => { await api(`/stay/reservations/${id}/no-show`, { body: {} }); await done(); })}>No-show</Button>
                  </>
                )}
              </div>

              {panel === "checkin" && <CheckInPanel res={d} onClose={() => setPanel(null)} onDone={done} />}
              {panel === "checkout" && <CheckOutPanel res={d} onClose={() => setPanel(null)} onDone={done} />}
              <FormModal open={panel === "charge"} title="Post a charge" onClose={() => setPanel(null)}
                fields={{ type: f.select("Type", ["FOOD", "LAUNDRY", "MINIBAR", "SERVICE", "OTHER"], { required: true, default: "FOOD" }), description: f.text("Description", { required: true, max: 120 }), amount: f.money("Amount (before GST)", { required: true }), taxRate: f.percent("GST %", { default: 0 }) }}
                onSubmit={async (v) => { await api(`/stay/reservations/${id}/charges`, { body: { ...v, taxRate: v.taxRate ?? 0 } }); await done(); }} />
              <FormModal open={panel === "payment"} title="Record payment" onClose={() => setPanel(null)}
                initial={{ amount: Math.max(0, fo.balance), method: "CASH" }}
                fields={{ amount: f.money("Amount", { required: true }), method: f.select("Method", TENDERS, { required: true, default: "CASH" }), reference: f.text("Reference / UTR", { max: 60 }) }}
                onSubmit={async (v) => { await api(`/stay/reservations/${id}/payments`, { body: { ...v, reference: v.reference ?? undefined } }); toast("Payment recorded"); await done(); }} />
            </div>
          );
        }}
      </Loadable>
    </Modal>
  );
}

function CheckInPanel({ res, onClose, onDone }: { res: any; onClose: () => void; onDone: () => Promise<void> }) {
  const rooms = useApi<{ items: any[] }>(`/stay/availability/rooms${qs({ checkIn: todayIST() < res.checkInDate ? todayIST() : res.checkInDate, checkOut: res.checkOutDate, roomTypeId: res.roomType.id, excludeReservationId: res.id })}`);
  const [roomId, setRoomId] = useState<string>(res.room?.id ?? "");
  const [idType, setIdType] = useState<string>(res.guest.idType ?? "");
  const [idNumber, setIdNumber] = useState<string>(res.guest.idNumber ?? "");
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/stay/reservations/${res.id}/check-in`, { body: { roomId: roomId || undefined, idType: idType || undefined, idNumber: idNumber || undefined, force } });
      toast("Guest checked in");
      await onDone();
      onClose();
    } catch (e: any) {
      setError(e.message);
      if (e.code === "ROOM_NOT_CLEAN") setForce(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Check in" size="sm" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!roomId} onClick={submit}>Check in</Button></>}>
      <div className="space-y-3">
        <Field label="Room" required>
          <Select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">Select a room...</option>
            {rooms.data?.items.map((r) => <option key={r.id} value={r.id}>{r.number}{r.floor ? ` (floor ${r.floor})` : ""} - {humanize(r.hkStatus)}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="ID proof"><Select value={idType} onChange={(e) => setIdType(e.target.value)}><option value="">Select...</option>{ID_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></Field>
          <Field label="ID number"><Input value={idNumber} maxLength={40} onChange={(e) => setIdNumber(e.target.value)} /></Field>
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Check in even if the room is not marked clean</label>
      </div>
    </Modal>
  );
}

function CheckOutPanel({ res, onClose, onDone }: { res: any; onClose: () => void; onDone: () => Promise<void> }) {
  const p = useProduct();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [allowBalance, setAllow] = useState(false);
  const [due, setDue] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const paise = rupeesToPaise(amount || 0);
      const out = await api<any>(`/stay/reservations/${res.id}/check-out`, { body: { ...(paise > 0 ? { payment: { amount: paise, method } } : {}), allowBalance } });
      toast(`Checked out - invoice ${out.invoiceNo}`);
      await onDone();
      onClose();
      window.open(out.invoiceUrl, "_blank", "noopener");
    } catch (e: any) {
      if (e.code === "BALANCE_DUE") {
        setDue(e.details.balance);
        setAmount(String(e.details.balance / 100));
        setError(`Balance due: ${formatINR(e.details.balance)}. Collect payment to complete check-out.`);
      } else setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Check out - Room ${res.room?.number ?? ""}`} size="sm" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Check out</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">Room charges are posted for the nights actually stayed, then the invoice is issued. Estimated balance now: <strong>{formatINR(Math.max(0, res.folio.balance))}</strong>.</p>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Payment now (Rs)"><Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></Field>
          <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{TENDERS.map((m) => <option key={m} value={m}>{humanize(m)}</option>)}</Select></Field>
        </div>
        {error && <Notice tone={due !== null ? "warn" : "bad"}>{error}</Notice>}
        {p.can("dashboard.view") && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allowBalance} onChange={(e) => setAllow(e.target.checked)} /> Allow check-out with an unpaid balance (manager)</label>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// New reservation / walk-in
// ---------------------------------------------------------------------------

export function NewReservationModal({ onClose, onCreated, walkIn }: { onClose: () => void; onCreated: (id: string) => void; walkIn?: boolean }) {
  const p = useProduct();
  const today = todayIST();
  const types = useApi<{ items: any[] }>("/stay/room-types?pageSize=200");
  const [guestQ, setGuestQ] = useState("");
  const found = useApi<{ items: any[] }>(guestQ.length >= 3 ? `/stay/guests${qs({ q: guestQ, pageSize: 6 })}` : null);
  const [guest, setGuest] = useState<any | null>(null);
  const [g, setG] = useState({ fullName: "", phone: "", idType: "", idNumber: "", city: "" });
  const [v, setV] = useState({ roomTypeId: "", roomId: "", checkInDate: today, checkOutDate: addDays(today, 1), adults: "1", children: "0", rate: "", source: "WALK_IN", advance: "", advanceMethod: "CASH", specialRequests: "", checkInNow: !!walkIn });
  const set = (patch: Partial<typeof v>) => setV((s) => ({ ...s, ...patch }));
  const validDates = v.checkOutDate > v.checkInDate;
  const rooms = useApi<{ items: any[] }>(v.roomTypeId && validDates ? `/stay/availability/rooms${qs({ checkIn: v.checkInDate, checkOut: v.checkOutDate, roomTypeId: v.roomTypeId })}` : null);
  const type = types.data?.items.find((t) => t.id === v.roomTypeId);
  const nights = validDates ? daysBetween(v.checkInDate, v.checkOutDate) : 0;
  const rate = v.rate ? rupeesToPaise(v.rate) : type?.baseRate ?? 0;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canCheckIn = v.checkInDate === today && p.has("checkin_checkout") && p.can("checkin.perform");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const adv = rupeesToPaise(v.advance || 0);
      const r = await api<any>("/stay/reservations", {
        body: {
          ...(guest ? { guestId: guest.id } : { guest: { fullName: g.fullName, phone: g.phone, idType: g.idType || undefined, idNumber: g.idNumber || undefined, city: g.city || undefined } }),
          roomTypeId: v.roomTypeId, roomId: v.roomId || null, checkInDate: v.checkInDate, checkOutDate: v.checkOutDate,
          adults: Number(v.adults) || 1, children: Number(v.children) || 0, ...(v.rate ? { ratePerNight: rupeesToPaise(v.rate) } : {}),
          source: v.source, specialRequests: v.specialRequests || undefined,
          ...(adv > 0 ? { advance: { amount: adv, method: v.advanceMethod } } : {}),
          checkInNow: canCheckIn && v.checkInNow,
        },
      });
      toast(canCheckIn && v.checkInNow ? "Guest checked in" : `Reservation #${r.reservationNo} created`);
      onCreated(r.id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={walkIn ? "Walk-in guest" : "New reservation"} size="lg">
      <form onSubmit={submit} className="space-y-5">
        <fieldset>
          <legend className="text-sm font-semibold text-slate-900">Guest</legend>
          {guest ? (
            <div className="mt-2 flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <span><strong>{guest.fullName}</strong> - {guest.phone}{guest.isVip ? " - VIP" : ""}</span>
              <Button size="sm" variant="ghost" onClick={() => setGuest(null)}>Change</Button>
            </div>
          ) : (
            <>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Field label="Find returning guest" className="sm:col-span-2">
                  <Input placeholder="Search by name or phone (3+ characters)" value={guestQ} onChange={(e) => setGuestQ(e.target.value)} />
                </Field>
              </div>
              {!!found.data?.items.length && (
                <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {found.data.items.map((x) => <li key={x.id}><button type="button" className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => setGuest(x)}><span>{x.fullName}</span><span className="text-slate-500">{x.phone}</span></button></li>)}
                </ul>
              )}
              {p.has("guest_registration") && p.can("guests.manage") && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label="Full name" required><Input required minLength={2} value={g.fullName} onChange={(e) => setG({ ...g, fullName: e.target.value })} /></Field>
                  <Field label="Phone" required><Input required type="tel" value={g.phone} onChange={(e) => setG({ ...g, phone: e.target.value })} /></Field>
                  <Field label="ID proof"><Select value={g.idType} onChange={(e) => setG({ ...g, idType: e.target.value })}><option value="">Select...</option>{ID_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></Field>
                  <Field label="ID number"><Input value={g.idNumber} onChange={(e) => setG({ ...g, idNumber: e.target.value })} /></Field>
                </div>
              )}
            </>
          )}
        </fieldset>

        <fieldset>
          <legend className="text-sm font-semibold text-slate-900">Stay</legend>
          <div className="mt-2 grid gap-3 sm:grid-cols-4">
            <Field label="Check-in" required><Input type="date" required min={today} value={v.checkInDate} onChange={(e) => set({ checkInDate: e.target.value, roomId: "", ...(e.target.value >= v.checkOutDate ? { checkOutDate: addDays(e.target.value, 1) } : {}) })} /></Field>
            <Field label="Check-out" required><Input type="date" required min={addDays(v.checkInDate, 1)} value={v.checkOutDate} onChange={(e) => set({ checkOutDate: e.target.value, roomId: "" })} /></Field>
            <Field label="Adults"><Input type="number" min="1" max="20" value={v.adults} onChange={(e) => set({ adults: e.target.value })} /></Field>
            <Field label="Children"><Input type="number" min="0" max="20" value={v.children} onChange={(e) => set({ children: e.target.value })} /></Field>
            <Field label="Room category" required className="sm:col-span-2">
              <Select required value={v.roomTypeId} onChange={(e) => set({ roomTypeId: e.target.value, roomId: "" })}>
                <option value="">Select...</option>
                {types.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name} - {formatINR(t.baseRate, { whole: true })} / night</option>)}
              </Select>
            </Field>
            <Field label="Room" help={rooms.data ? `${rooms.data.items.length} free for these dates` : "Optional until check-in"} className="sm:col-span-2">
              <Select value={v.roomId} onChange={(e) => set({ roomId: e.target.value })}>
                <option value="">Assign later</option>
                {rooms.data?.items.map((r) => <option key={r.id} value={r.id}>{r.number}{r.floor ? ` (floor ${r.floor})` : ""} - {humanize(r.hkStatus)}</option>)}
              </Select>
            </Field>
            <Field label="Rate per night (Rs)" help={type ? `Standard ${formatINR(type.baseRate, { whole: true })}` : undefined}><Input type="number" min="0" step="0.01" placeholder={type ? String(type.baseRate / 100) : ""} value={v.rate} onChange={(e) => set({ rate: e.target.value })} /></Field>
            <Field label="Source"><Select value={v.source} onChange={(e) => set({ source: e.target.value })}>{["WALK_IN", "PHONE", "OTA", "WEBSITE", "CORPORATE", "AGENT"].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></Field>
            {p.has("room_billing") && p.can("billing.manage") && (
              <>
                <Field label="Advance (Rs)"><Input type="number" min="0" step="0.01" value={v.advance} onChange={(e) => set({ advance: e.target.value })} /></Field>
                <Field label="Advance method"><Select value={v.advanceMethod} onChange={(e) => set({ advanceMethod: e.target.value })}>{TENDERS.map((m) => <option key={m} value={m}>{humanize(m)}</option>)}</Select></Field>
              </>
            )}
            <Field label="Special requests" className="sm:col-span-4"><Textarea rows={2} maxLength={500} value={v.specialRequests} onChange={(e) => set({ specialRequests: e.target.value })} /></Field>
          </div>
        </fieldset>

        {type && nights > 0 && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{nights} night{nights > 1 ? "s" : ""} x {formatINR(rate)} = <strong>{formatINR(rate * nights)}</strong> + GST</p>}
        {canCheckIn && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.checkInNow} onChange={(e) => set({ checkInNow: e.target.checked })} /> Guest is here - check in now (a room must be selected)</label>}
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy} disabled={canCheckIn && v.checkInNow && !v.roomId}>{canCheckIn && v.checkInNow ? "Check in" : "Create reservation"}</Button></div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Front desk
// ---------------------------------------------------------------------------

const ROOM_TONE: Record<string, string> = { AVAILABLE: "border-emerald-300 bg-emerald-50", OCCUPIED: "border-sky-300 bg-sky-50", OUT_OF_ORDER: "border-red-300 bg-red-50" };

export function StayFrontDesk() {
  const p = useProduct();
  const fd = useApi<any>("/stay/front-desk", { refreshMs: 20_000 });
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState<null | "walkin" | "reservation">(null);
  const [tab, setTab] = useState<"arrivals" | "departures" | "inhouse">("arrivals");
  const canBook = p.has("reservations") && p.can("reservations.manage");
  const rows = (list: any[], action: string) => (
    <DataTable rows={list} rowKey={(r: any) => r.id} onRowClick={(r: any) => setOpen(r.id)} empty={<Empty title="Nothing due" />}
      columns={[
        { key: "g", label: "Guest", render: (r: any) => <span className="font-medium">{r.guest.fullName}{r.guest.isVip && <Badge tone="brand" className="ml-1.5">VIP</Badge>}{r.overdue && <Badge tone="warn" className="ml-1.5">Overdue</Badge>}</span> },
        { key: "r", label: "Room", render: (r: any) => (r.room ? `${r.room} - ${r.roomType}` : `${r.roomType} (unassigned)`) },
        { key: "s", label: "Stay", render: (r: any) => `${fmtDate(r.checkInDate).slice(0, 6)} - ${fmtDate(r.checkOutDate).slice(0, 6)}` },
        { key: "p", label: "Phone", render: (r: any) => r.guest.phone },
        { key: "a", label: "", align: "right", render: () => <span className="text-sm font-medium text-brand">{action}</span> },
      ]} />
  );
  return (
    <>
      <PageHeader title="Front desk" description={fmtDate(todayIST())}
        actions={canBook ? <><Button onClick={() => setCreating("reservation")}><Plus className="h-4 w-4" /> Reservation</Button><Button variant="primary" onClick={() => setCreating("walkin")}><LogIn className="h-4 w-4" /> Walk-in</Button></> : undefined} />
      <Loadable state={fd}>
        {(d) => (
          <div className="grid gap-4 xl:grid-cols-[1fr_26rem]">
            <div>
              <Tabs value={tab} onChange={setTab} tabs={[{ key: "arrivals", label: "Arrivals", count: d.arrivals.length }, { key: "departures", label: "Departures", count: d.departures.length }, { key: "inhouse", label: "In house", count: d.inHouse.length }]} />
              <Card pad={false}>{tab === "arrivals" ? rows(d.arrivals, "Check in") : tab === "departures" ? rows(d.departures, "Check out") : rows(d.inHouse, "Open folio")}</Card>
            </div>
            <Card title="Rooms" subtitle="Tap an occupied room to open the folio">
              {!d.rooms.length ? <Empty title="No rooms set up" hint="A manager can add rooms under Rooms & categories." /> : (
                <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-3">
                  {d.rooms.map((r: any) => (
                    <li key={r.id}>
                      <button disabled={!r.reservationId} onClick={() => r.reservationId && setOpen(r.reservationId)} className={cx("h-full w-full rounded-lg border-2 p-2 text-left disabled:cursor-default", ROOM_TONE[r.status])}>
                        <span className="block text-base font-semibold text-slate-900">{r.number}</span>
                        <span className="block truncate text-[11px] text-slate-600">{r.type}</span>
                        <span className="mt-1 block truncate text-xs font-medium text-slate-800">{r.guest ?? (r.status === "OUT_OF_ORDER" ? "Out of order" : "Vacant")}</span>
                        <span className="mt-1 block"><StatusBadge value={r.hkStatus} label={r.hkStatus === "IN_PROGRESS" ? "Cleaning" : undefined} /></span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </Loadable>
      {open && <ReservationModal id={open} onClose={() => setOpen(null)} onChanged={() => void fd.reload()} />}
      {creating && <NewReservationModal walkIn={creating === "walkin"} onClose={() => setCreating(null)} onCreated={(id) => { setCreating(null); void fd.reload(); setOpen(id); }} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Reservations list
// ---------------------------------------------------------------------------

export function StayReservations() {
  const p = useProduct();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const list = useApi<{ items: any[] }>(`/stay/reservations${qs({ status, q })}`);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Reservations"
        actions={<>
          <Input aria-label="Search reservations" placeholder="Guest, phone or number" className="w-48" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select aria-label="Status" className="w-36" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{["CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>
          {p.can("reservations.manage") && <Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New reservation</Button>}
        </>} />
      <Card pad={false}>
        <Loadable state={list}>
          {(d) => (
            <DataTable rows={d.items} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r.id)} empty={<Empty title="No reservations found" />}
              columns={[
                { key: "n", label: "No.", render: (r) => <span className="font-medium">#{r.reservationNo}</span> },
                { key: "g", label: "Guest", render: (r) => <>{r.guest.fullName}<span className="block text-xs text-slate-500">{r.guest.phone}</span></> },
                { key: "r", label: "Room", render: (r) => (r.room ? `${r.room.number} - ${r.roomType.name}` : r.roomType.name) },
                { key: "i", label: "Check-in", render: (r) => fmtDate(r.checkInDate) },
                { key: "o", label: "Check-out", render: (r) => fmtDate(r.checkOutDate) },
                { key: "nt", label: "Nights", align: "right", render: (r) => r.nights },
                { key: "rt", label: "Rate", align: "right", render: (r) => formatINR(r.ratePerNight, { whole: true }) },
                { key: "s", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
              ]} />
          )}
        </Loadable>
      </Card>
      {open && <ReservationModal id={open} onClose={() => setOpen(null)} onChanged={() => void list.reload()} />}
      {creating && <NewReservationModal onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); void list.reload(); setOpen(id); }} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Availability calendar
// ---------------------------------------------------------------------------

export function StayAvailability() {
  const [from, setFrom] = useState(todayIST());
  const a = useApi<any>(`/stay/availability?from=${from}&days=14`);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Room availability" description="14-day view. Coloured cells are booked nights."
        actions={<><Button onClick={() => setFrom(addDays(from, -7))}>Earlier</Button><Input aria-label="From date" type="date" className="w-40" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /><Button onClick={() => setFrom(addDays(from, 7))}>Later</Button></>} />
      <Loadable state={a}>
        {(d) => (
          <div className="space-y-4">
            <Card pad={false} title="Rooms free by category">
              <div className="overflow-x-auto">
                <table className="w-full min-w-max text-sm">
                  <thead><tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500"><th scope="col" className="px-3 py-2 text-left font-medium">Category</th>{d.dates.map((x: string) => <th key={x} scope="col" className="px-1.5 py-2 text-center font-medium">{fmtDate(x).slice(0, 6)}</th>)}</tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {d.byType.map((t: any) => (
                      <tr key={t.id}>
                        <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-medium">{t.name}<span className="block text-xs font-normal text-slate-500">{formatINR(t.baseRate, { whole: true })}</span></th>
                        {t.available.map((n: number, i: number) => <td key={i} className={cx("tnum px-1.5 py-2 text-center", n === 0 ? "font-semibold text-red-700" : "text-slate-800")}>{n === 0 ? "Full" : n}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card pad={false} title="Room calendar" subtitle="Tap a booking to open it">
              <div className="overflow-x-auto">
                <table className="w-full min-w-max border-separate border-spacing-0 text-xs">
                  <thead><tr className="bg-slate-50 text-slate-500"><th scope="col" className="sticky left-0 bg-slate-50 px-3 py-2 text-left font-medium">Room</th>{d.dates.map((x: string) => <th key={x} scope="col" className="w-16 border-l border-slate-100 px-1 py-2 text-center font-medium">{fmtDate(x).slice(0, 6)}</th>)}</tr></thead>
                  <tbody>
                    {d.rooms.map((room: any) => (
                      <tr key={room.id}>
                        <th scope="row" className="sticky left-0 whitespace-nowrap border-t border-slate-100 bg-white px-3 py-1.5 text-left font-medium text-slate-800">{room.number} <span className="font-normal text-slate-500">{room.type}</span></th>
                        {d.dates.map((x: string) => {
                          const b = d.bookings.find((k: any) => k.roomId === room.id && k.checkInDate <= x && k.checkOutDate > x);
                          return (
                            <td key={x} className="h-9 border-l border-t border-slate-100 p-0.5">
                              {b ? (
                                <button onClick={() => setOpen(b.id)} title={`${b.guest} (#${b.reservationNo})`} className={cx("h-full w-full truncate rounded px-1 text-left text-[11px] font-medium", b.status === "CHECKED_IN" ? "bg-sky-200 text-sky-950" : "bg-amber-200 text-amber-950")}>{b.checkInDate === x || x === d.dates[0] ? b.guest : ""}</button>
                              ) : room.status === "OUT_OF_ORDER" ? <span className="block h-full rounded bg-slate-200" title="Out of order" /> : null}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="flex flex-wrap gap-4 border-t border-slate-100 px-4 py-2 text-xs text-slate-600">
                <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-sky-200" /> In house</span>
                <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-amber-200" /> Reserved</span>
                <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-slate-200" /> Out of order</span>
              </p>
            </Card>
          </div>
        )}
      </Loadable>
      {open && <ReservationModal id={open} onClose={() => setOpen(null)} onChanged={() => void a.reload()} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Cashier & invoices
// ---------------------------------------------------------------------------

export function StayCashier() {
  const c = useApi<any>("/stay/cashier", { refreshMs: 30_000 });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Cashier" description="Guest folios, payments and today's collections." />
      <Loadable state={c}>
        {(d) => (
          <>
            <KpiRow cols={4}>
              <StatTile label="Collected today" value={formatINR(d.collections.total, { whole: true })} sub={`${d.payments.length} payments`} />
              <StatTile label="Cash" value={formatINR(d.collections.byMethod.CASH ?? 0, { whole: true })} />
              <StatTile label="UPI and card" value={formatINR((d.collections.byMethod.UPI ?? 0) + (d.collections.byMethod.CARD ?? 0), { whole: true })} />
              <StatTile label="Outstanding in house" value={formatINR(d.outstanding, { whole: true })} tone={d.outstanding ? "warn" : undefined} />
            </KpiRow>
            <div className="grid gap-4 xl:grid-cols-2">
              <Card pad={false} title="Open folios">
                <DataTable rows={d.folios} rowKey={(r: any) => r.id} onRowClick={(r: any) => setOpen(r.id)} empty={<Empty title="No guests in house" />}
                  columns={[
                    { key: "r", label: "Room", render: (r: any) => <span className="font-medium">{r.room ?? "-"}</span> },
                    { key: "g", label: "Guest", render: (r: any) => <>{r.guest}{r.dueToday && <Badge tone="warn" className="ml-1.5">Leaving today</Badge>}</> },
                    { key: "t", label: "Total", align: "right", render: (r: any) => formatINR(r.total) },
                    { key: "p", label: "Paid", align: "right", render: (r: any) => formatINR(r.paid) },
                    { key: "b", label: "Balance", align: "right", render: (r: any) => <span className={r.balance > 0 ? "font-semibold text-red-700" : ""}>{formatINR(r.balance)}</span> },
                  ]} />
              </Card>
              <Card pad={false} title="Payments today">
                <DataTable dense rows={d.payments} rowKey={(r: any) => r.id} empty={<Empty title="No payments yet today" />}
                  columns={[
                    { key: "t", label: "Time", render: (r: any) => fmtDateTime(r.createdAt) },
                    { key: "g", label: "Guest", render: (r: any) => `${r.reservation.guest.fullName} (#${r.reservation.reservationNo})` },
                    { key: "m", label: "Method", render: (r: any) => humanize(r.method) },
                    { key: "a", label: "Amount", align: "right", render: (r: any) => formatINR(r.amount) },
                  ]} />
              </Card>
            </div>
          </>
        )}
      </Loadable>
      {open && <ReservationModal id={open} onClose={() => setOpen(null)} onChanged={() => void c.reload()} />}
    </>
  );
}

export function StayInvoices() {
  const range = useRange("30d");
  const list = useApi<{ items: any[] }>(`/stay/invoices?${range.query}`);
  return (
    <>
      <PageHeader title="Invoices" description="Invoices are issued at check-out." />
      <RangePicker state={range} />
      <Card pad={false}>
        <Loadable state={list}>
          {(d) => (
            <DataTable rows={d.items} rowKey={(r) => r.id} empty={<Empty title="No invoices in this period" />}
              columns={[
                { key: "n", label: "Invoice", render: (r) => <span className="font-mono text-[13px]">{r.invoiceNo}</span> },
                { key: "d", label: "Checked out", render: (r) => fmtDateTime(r.checkedOutAt) },
                { key: "g", label: "Guest", render: (r) => r.guest },
                { key: "r", label: "Room", render: (r) => r.room ?? "-" },
                { key: "nt", label: "Nights", align: "right", render: (r) => r.nights },
                { key: "t", label: "Total", align: "right", render: (r) => formatINR(r.total) },
                { key: "b", label: "Balance", align: "right", render: (r) => (r.balance > 0 ? <span className="font-semibold text-red-700">{formatINR(r.balance)}</span> : "Paid") },
                { key: "a", label: "", align: "right", render: (r) => <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-brand underline"><ExternalLink className="h-3.5 w-3.5" /> Open</a> },
              ]} />
          )}
        </Loadable>
      </Card>
    </>
  );
}
