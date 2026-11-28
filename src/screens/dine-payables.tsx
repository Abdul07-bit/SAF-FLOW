"use client";

/**
 * Supplier credit & payables (SAF Dine Flow): suppliers, credit purchases,
 * payments, the supplier ledger, reports and alerts. Every figure comes from
 * the API (/api/dine/payables/...), which computes it from stored
 * transactions; this file only displays and collects input.
 * See docs/SUPPLIER-CREDIT.md.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, Ban, Banknote, BellRing, Camera, Download, FileSpreadsheet, HandCoins, MessageCircle, Pencil, Plus, Power, ReceiptText, Scale, Trash2, Undo2,
} from "lucide-react";
import { currentBusinessDate } from "@/lib/business-day";
import { addDays, fmtDate, fmtDateTime } from "@/lib/dates";
import { formatINR, rupeesToPaise } from "@/lib/money";
import {
  ADJUSTMENT_KINDS, defaultDueDate, formatQuantity, lineAmount, parseQuantity, PURCHASE_UNITS, SUPPLIER_CATEGORIES, SUPPLIER_PAYMENT_METHODS,
} from "@/lib/payables";
import { api, ApiError, qs, useApi } from "@/lib/client";
import { humanize } from "@/shared/fields";
import { ChartCard, fmtCompactINR, KpiRow, Legend, SERIES_COLORS, StackedColumnChart, StatTile } from "@/components/charts";
import { useProduct } from "@/components/product-context";
import {
  Badge, Button, Card, cx, DataTable, Empty, Field, Input, KeyValue, Loadable, Modal, Notice, PageHeader, Select, StatusBadge, Tabs, Textarea, toast, useAction,
} from "@/components/ui";

// ---------------------------------------------------------------------------
// Types (as returned by the API)
// ---------------------------------------------------------------------------

interface SupplierRow {
  id: string; name: string; businessName: string | null; category: string; phone: string | null; whatsapp: string | null; isActive: boolean;
  paymentTermsDays: number | null; creditLimit: number | null; purchases: number; paid: number; otherCredits: number; otherDebits: number;
  balance: number; overdue: number; overdueBills: number; openBills: number; oldestOpenBill: string | null; lastActivity: string | null; overLimit: boolean;
}
interface Bill {
  id: string; number: string; kind: string; status: string; displayStatus: string; billDate: string; dueDate: string | null; daysOverdue: number;
  invoiceNo: string | null; total: number; settled: number; due: number; paidAtPurchase: number; notes: string | null; hasAttachment: boolean;
  dinePurchaseId: string | null; cancelReason: string | null; cancelledAt: string | null;
  supplier: { id: string; name: string; businessName: string | null; phone: string | null; category: string };
  items: { id: string; productName: string; category: string; quantity: string; unit: string; rate: number; amount: number }[];
}
interface Paged<T> { items: T[]; total: number; page: number; pageSize: number }

const money = (p: number) => formatINR(p);
const UNIT_LABEL: Record<string, string> = { KG: "kg", GRAM: "g", LITRE: "L", PIECE: "pc", BOX: "box", PACKET: "pkt", OTHER: "" };
const METHOD_LABEL: Record<string, string> = { CASH: "Cash", UPI: "UPI", BANK_TRANSFER: "Bank transfer", OTHER: "Other" };
const STATUS_LABEL: Record<string, string> = { PAID: "Paid", PARTIALLY_PAID: "Partially paid", UNPAID: "Unpaid", OVERDUE: "Overdue", CANCELLED: "Cancelled" };
const newRef = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`.replace(/\D/g, ""));
const queryParams = () => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);

/** The restaurant's current business day (a shop open past midnight is still on yesterday). */
function useToday(): string {
  const p = useProduct();
  return currentBusinessDate({ openingTime: p.settings.openingTime ?? "09:00", closingTime: p.settings.closingTime ?? "23:00" });
}

function BillStatus({ status }: { status: string }) {
  return <StatusBadge value={status} label={STATUS_LABEL[status] ?? humanize(status)} />;
}

/** Signed balance: what is owed, or an advance with the supplier. */
function Balance({ value, className }: { value: number; className?: string }) {
  if (value < 0) return <span className={cx("tnum text-emerald-800", className)} title="Paid in advance: credit with the supplier">{money(-value)} advance</span>;
  return <span className={cx("tnum font-medium", value > 0 ? "text-slate-900" : "text-slate-500", className)}>{money(value)}</span>;
}

function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-2 text-sm text-slate-600">
      <span>{(page - 1) * pageSize + 1}-{Math.min(total, page * pageSize)} of {total}</span>
      <div className="flex gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
}

function RupeeInput(props: { value: string; onChange: (v: string) => void; required?: boolean; placeholder?: string; "aria-label"?: string; autoFocus?: boolean }) {
  return (
    <Input
      type="number" inputMode="decimal" min="0" step="0.01" required={props.required} placeholder={props.placeholder ?? "0.00"}
      aria-label={props["aria-label"]} autoFocus={props.autoFocus} value={props.value} onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

/** Upload a bill photo / receipt after the record is saved. */
async function uploadPhoto(path: string, file: File | null) {
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  await api(path, { method: "POST", form });
}

function PhotoInput({ file, onFile, label }: { file: File | null; onFile: (f: File | null) => void; label: string }) {
  return (
    <Field label={label} help="PNG or JPEG photo, up to 2 MB. Kept private.">
      <label className="flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 text-sm text-slate-600 hover:bg-slate-50">
        <Camera className="h-4 w-4" aria-hidden />
        <span className="truncate">{file ? file.name : "Take or choose a photo"}</span>
        <input type="file" accept="image/png,image/jpeg" capture="environment" className="sr-only" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      </label>
    </Field>
  );
}

/** Suppliers for pickers (active first). */
function useSupplierOptions(includeInactive = false) {
  const r = useApi<Paged<SupplierRow>>(`/dine/payables/suppliers${qs({ status: includeInactive ? "all" : "active", pageSize: 100 })}`);
  return r.data?.items ?? [];
}

// ---------------------------------------------------------------------------
// Supplier form
// ---------------------------------------------------------------------------

function SupplierForm({ initial, onClose, onSaved }: { initial?: SupplierRow & { contactPerson?: string | null; email?: string | null; address?: string | null; gstin?: string | null; notes?: string | null }; onClose: () => void; onSaved: (id: string) => void }) {
  const today = useToday();
  const editing = !!initial;
  const [f, setF] = useState({
    name: initial?.name ?? "", businessName: initial?.businessName ?? "", phone: initial?.phone ?? "", whatsapp: initial?.whatsapp ?? "",
    address: initial?.address ?? "", category: initial?.category ?? "OTHER", paymentTermsDays: initial?.paymentTermsDays?.toString() ?? "",
    creditLimit: initial?.creditLimit != null ? String(initial.creditLimit / 100) : "", notes: initial?.notes ?? "",
    contactPerson: initial?.contactPerson ?? "", email: initial?.email ?? "", gstin: initial?.gstin ?? "",
    openingBalance: "", openingBalanceDate: "",
  });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const [busy, run] = useAction();
  const submit = () => run(async () => {
    const body: Record<string, unknown> = {
      name: f.name, businessName: f.businessName, phone: f.phone, whatsapp: f.whatsapp, address: f.address, category: f.category,
      paymentTermsDays: f.paymentTermsDays === "" ? null : Number(f.paymentTermsDays),
      creditLimit: f.creditLimit === "" ? null : rupeesToPaise(f.creditLimit),
      notes: f.notes, contactPerson: f.contactPerson, email: f.email, gstin: f.gstin,
    };
    if (!editing && f.openingBalance) {
      body.openingBalance = rupeesToPaise(f.openingBalance);
      if (f.openingBalanceDate) body.openingBalanceDate = f.openingBalanceDate;
    }
    const s = await api<{ id: string }>(editing ? `/dine/payables/suppliers/${initial!.id}` : "/dine/payables/suppliers", { method: editing ? "PATCH" : "POST", body });
    onSaved(s.id);
  }, editing ? "Supplier updated" : "Supplier added");
  return (
    <Modal open size="lg" title={editing ? `Edit ${initial!.name}` : "Add supplier"} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void submit()} disabled={f.name.trim().length < 2}>{editing ? "Save" : "Add supplier"}</Button></>}>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Supplier name" required><Input value={f.name} onChange={(e) => set("name")(e.target.value)} autoFocus maxLength={100} placeholder="ABC Chicken Centre" /></Field>
        <Field label="Business name"><Input value={f.businessName} onChange={(e) => set("businessName")(e.target.value)} maxLength={120} /></Field>
        <Field label="Mobile number"><Input type="tel" inputMode="tel" value={f.phone} onChange={(e) => set("phone")(e.target.value)} /></Field>
        <Field label="WhatsApp number"><Input type="tel" inputMode="tel" value={f.whatsapp} onChange={(e) => set("whatsapp")(e.target.value)} placeholder="Same as mobile if empty" /></Field>
        <Field label="Category">
          <Select value={f.category} onChange={(e) => set("category")(e.target.value)}>
            {SUPPLIER_CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
          </Select>
        </Field>
        <Field label="Payment terms (days)" help="Days of credit the supplier gives. Sets the due date of new purchases.">
          <Input type="number" inputMode="numeric" min="0" max="365" value={f.paymentTermsDays} onChange={(e) => set("paymentTermsDays")(e.target.value)} placeholder="e.g. 7" />
        </Field>
        <Field label="Credit limit (Rs)" help="You get an alert when you owe more than this.">
          <RupeeInput value={f.creditLimit} onChange={set("creditLimit")} placeholder="No limit" />
        </Field>
        <Field label="Contact person"><Input value={f.contactPerson} onChange={(e) => set("contactPerson")(e.target.value)} maxLength={80} /></Field>
        <Field label="Address" className="sm:col-span-2"><Textarea value={f.address} onChange={(e) => set("address")(e.target.value)} maxLength={300} rows={2} /></Field>
        <Field label="GSTIN"><Input value={f.gstin} onChange={(e) => set("gstin")(e.target.value)} maxLength={20} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={(e) => set("email")(e.target.value)} /></Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea value={f.notes} onChange={(e) => set("notes")(e.target.value)} maxLength={500} rows={2} /></Field>
        {!editing && (
          <>
            <Field label="Opening balance (Rs)" help="What you already owe this supplier from before.">
              <RupeeInput value={f.openingBalance} onChange={set("openingBalance")} />
            </Field>
            <Field label="Opening balance as of">
              <Input type="date" max={today} value={f.openingBalanceDate} onChange={(e) => set("openingBalanceDate")(e.target.value)} />
            </Field>
          </>
        )}
        <button type="submit" className="hidden" />
      </form>
      {editing && <p className="mt-3 text-xs text-slate-500">The balance is never edited here. To correct it, record an adjustment with a reason from the supplier&apos;s page.</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Record purchase (built for phones: one item by default, big targets)
// ---------------------------------------------------------------------------

interface Line { productName: string; category: string; quantity: string; unit: string; rate: string }

function PurchaseForm({ supplierId: fixedSupplier, onClose, onSaved }: { supplierId?: string; onClose: () => void; onSaved: (bill: Bill) => void }) {
  const suppliers = useSupplierOptions();
  const [supplierId, setSupplierId] = useState(fixedSupplier ?? "");
  const supplier = suppliers.find((s) => s.id === supplierId);
  const today = useToday();
  const [billDate, setBillDate] = useState(today);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([{ productName: "", category: "", quantity: "", unit: "KG", rate: "" }]);
  const [payMode, setPayMode] = useState<"credit" | "full" | "part">("credit");
  const [paid, setPaid] = useState("");
  const [method, setMethod] = useState("CASH");
  const [reference, setReference] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [more, setMore] = useState(false);
  const [clientRef] = useState(newRef);
  const [busy, run] = useAction();

  const priced = lines.map((l) => {
    const milli = parseQuantity(l.quantity || "");
    const rate = l.rate === "" ? null : rupeesToPaise(l.rate);
    return { milli, rate, amount: milli != null && rate != null ? lineAmount(milli, rate) : 0 };
  });
  const total = priced.reduce((a, l) => a + l.amount, 0);
  const paidNow = payMode === "credit" ? 0 : payMode === "full" ? total : Math.min(rupeesToPaise(paid || "0"), total);
  const credit = total - paidNow;
  const autoDue = supplier ? defaultDueDate(billDate, supplier.paymentTermsDays) : null;
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const valid = !!supplierId && total > 0 && lines.every((l, i) => l.productName.trim() && priced[i].milli != null && priced[i].rate != null);

  const submit = () => run(async () => {
    const bill = await api<Bill & { duplicate: boolean }>("/dine/payables/purchases", {
      method: "POST",
      body: {
        supplierId, billDate, invoiceNo, notes, dueDate: dueDate || undefined, clientRef,
        items: lines.map((l) => ({ productName: l.productName, category: l.category || undefined, quantity: l.quantity, unit: l.unit, rate: rupeesToPaise(l.rate) })),
        ...(paidNow > 0 ? { amountPaid: paidNow, paymentMethod: method, paymentReference: reference } : {}),
      },
    });
    try {
      await uploadPhoto(`/dine/payables/purchases/${bill.id}/attachment`, photo);
    } catch (e) {
      toast(`Purchase saved, but the photo was not: ${(e as Error).message}`, "bad");
    }
    onSaved(bill);
  }, "Purchase recorded");

  return (
    <Modal open size="lg" title="Record purchase" onClose={onClose}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="text-sm">
            <span className="text-slate-600">Total </span><strong className="tnum">{money(total)}</strong>
            {total > 0 && <span className="ml-2 text-slate-600">On credit <strong className={cx("tnum", credit > 0 && "text-amber-800")}>{money(credit)}</strong></span>}
          </div>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void submit()}>Save purchase</Button>
          </div>
        </div>
      }>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier" required>
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} disabled={!!fixedSupplier} autoFocus={!fixedSupplier}>
              <option value="">Select supplier...</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.balance > 0 ? ` (owed ${formatINR(s.balance, { whole: true })})` : ""}</option>)}
            </Select>
          </Field>
          <Field label="Purchase date" required>
            <Input type="date" value={billDate} max={today} onChange={(e) => e.target.value && setBillDate(e.target.value)} />
          </Field>
        </div>

        <div className="space-y-3">
          {lines.map((l, i) => (
            <div key={i} className="rounded-lg border border-slate-200 p-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,2fr)_6rem_6.5rem_7rem]">
                <Field label="Product" className="col-span-2 sm:col-span-1">
                  <Input value={l.productName} onChange={(e) => set(i, { productName: e.target.value })} placeholder="Chicken" maxLength={100} autoFocus={i > 0 || !!fixedSupplier} />
                </Field>
                <Field label="Quantity">
                  <Input type="number" inputMode="decimal" min="0.001" step="0.001" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} placeholder="20" />
                </Field>
                <Field label="Unit">
                  <Select value={l.unit} onChange={(e) => set(i, { unit: e.target.value })}>
                    {PURCHASE_UNITS.map((u) => <option key={u} value={u}>{humanize(u)}</option>)}
                  </Select>
                </Field>
                <Field label={`Rate per ${UNIT_LABEL[l.unit] || "unit"} (Rs)`} className="col-span-2 sm:col-span-1">
                  <RupeeInput value={l.rate} onChange={(v) => set(i, { rate: v })} placeholder="220" />
                </Field>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 text-sm">
                <Select aria-label="Product category" className="h-8 w-40 text-xs" value={l.category} onChange={(e) => set(i, { category: e.target.value })}>
                  <option value="">{supplier ? `${humanize(supplier.category)} (supplier)` : "Category"}</option>
                  {SUPPLIER_CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
                </Select>
                <span className="text-slate-600">
                  {priced[i].milli != null && priced[i].rate != null
                    ? <>{formatQuantity(priced[i].milli!)} x {money(priced[i].rate!)} = <strong className="tnum text-slate-900">{money(priced[i].amount)}</strong></>
                    : l.quantity && priced[i].milli == null ? <span className="text-red-700">Quantity: up to 3 decimals</span> : null}
                </span>
                {lines.length > 1 && (
                  <button type="button" aria-label={`Remove item ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))} className="rounded p-1 text-slate-500 hover:bg-slate-100"><Trash2 className="h-4 w-4" /></button>
                )}
              </div>
            </div>
          ))}
          <Button size="sm" onClick={() => setLines([...lines, { productName: "", category: "", quantity: "", unit: lines[lines.length - 1].unit, rate: "" }])}><Plus className="h-3.5 w-3.5" /> Add another item</Button>
        </div>

        <fieldset>
          <legend className="mb-1 text-[13px] font-medium text-slate-700">Payment now</legend>
          <div className="grid grid-cols-3 gap-2" role="radiogroup">
            {([["credit", "Unpaid (credit)"], ["part", "Part paid"], ["full", "Paid in full"]] as const).map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={payMode === k} onClick={() => setPayMode(k)}
                className={cx("h-11 rounded-lg border text-sm font-medium", payMode === k ? "border-brand bg-brand-soft text-brand" : "border-slate-300 text-slate-700 hover:bg-slate-50")}>
                {label}
              </button>
            ))}
          </div>
          {payMode !== "credit" && (
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {payMode === "part" && <Field label="Amount paid (Rs)" required><RupeeInput value={paid} onChange={setPaid} autoFocus /></Field>}
              <Field label="Paid by">
                <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {SUPPLIER_PAYMENT_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
                </Select>
              </Field>
              <Field label="Transaction ID"><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} placeholder="Optional" /></Field>
            </div>
          )}
          {payMode === "part" && rupeesToPaise(paid || "0") > total && total > 0 && <p className="mt-1 text-xs text-red-700">More than the total. Record an advance as a separate payment.</p>}
        </fieldset>

        {credit > 0 && (
          <Field label="Payment due date" help={autoDue && !dueDate ? `Leave empty for ${fmtDate(autoDue)} (${supplier!.paymentTermsDays} days credit).` : "Optional."}>
            <Input type="date" min={billDate} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        )}

        {more ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Supplier's invoice / bill number"><Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} maxLength={60} /></Field>
            <PhotoInput label="Photo of the bill" file={photo} onFile={setPhoto} />
            <Field label="Notes" className="sm:col-span-2"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2} /></Field>
          </div>
        ) : (
          <button type="button" className="text-sm font-medium text-brand underline" onClick={() => setMore(true)}>Add invoice number, bill photo or notes</button>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Record payment
// ---------------------------------------------------------------------------

interface SupplierAccount {
  supplier: { id: string; name: string; businessName: string | null; contactPerson: string | null; phone: string | null; whatsapp: string | null; email: string | null; address: string | null; gstin: string | null; category: string; paymentTermsDays: number | null; creditLimit: number | null; notes: string | null; isActive: boolean };
  account: SupplierRow;
  openBills: Bill[];
  recentPayments: { id: string; number: string; paymentDate: string; amount: number; method: string; status: string; reference: string | null }[];
}

function PaymentForm({ supplierId: fixedSupplier, billId, onClose, onSaved }: { supplierId?: string; billId?: string; onClose: () => void; onSaved: () => void }) {
  const suppliers = useSupplierOptions(true);
  const [supplierId, setSupplierId] = useState(fixedSupplier ?? "");
  const acc = useApi<SupplierAccount>(supplierId ? `/dine/payables/suppliers/${supplierId}` : null);
  const today = useToday();
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [method, setMethod] = useState("CASH");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [pick, setPick] = useState<Record<string, string>>({});
  const [advanceOk, setAdvanceOk] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [clientRef] = useState(newRef);
  const [busy, run] = useAction();

  // Opening from a bill: settle that bill.
  useEffect(() => {
    if (!billId || !acc.data) return;
    const b = acc.data.openBills.find((x) => x.id === billId);
    if (b && !Object.keys(pick).length) { setPick({ [b.id]: String(b.due / 100) }); setAmount(String(b.due / 100)); }
  }, [billId, acc.data, pick]);

  const balance = acc.data?.account.balance ?? 0;
  const amt = rupeesToPaise(amount || "0");
  const picked = Object.entries(pick).filter(([, v]) => v !== "").map(([purchaseId, v]) => ({ purchaseId, amount: rupeesToPaise(v) })).filter((x) => x.amount > 0);
  const pickedTotal = picked.reduce((a, x) => a + x.amount, 0);
  const advance = Math.max(0, amt - Math.max(0, balance));
  const submit = () => run(async () => {
    try {
      const pay = await api<{ id: string }>("/dine/payables/payments", {
        method: "POST",
        body: { supplierId, amount: amt, paymentDate: date, method, reference, notes, clientRef, allowAdvance: advance > 0 && advanceOk, ...(picked.length ? { allocations: picked } : {}) },
      });
      try { await uploadPhoto(`/dine/payables/payments/${pay.id}/attachment`, photo); } catch (e) { toast(`Payment saved, but the receipt was not: ${(e as Error).message}`, "bad"); }
    } catch (e) {
      if (e instanceof ApiError && e.code === "EXCEEDS_BALANCE") setAdvanceOk(false);
      throw e;
    }
    onSaved();
  }, "Payment recorded");

  return (
    <Modal open size="lg" title="Record payment to supplier" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!supplierId || amt <= 0 || pickedTotal > amt || (advance > 0 && !advanceOk)} onClick={() => void submit()}>Save payment</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier" required>
            <Select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setPick({}); }} disabled={!!fixedSupplier} autoFocus={!fixedSupplier}>
              <option value="">Select supplier...</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.balance > 0 ? ` (owed ${formatINR(s.balance, { whole: true })})` : ""}{s.isActive ? "" : " - inactive"}</option>)}
            </Select>
          </Field>
          <Field label="Payment date" required><Input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>
        </div>
        {acc.data && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <span>Outstanding with {acc.data.supplier.name}: <Balance value={balance} /></span>
            {balance > 0 && <Button size="sm" onClick={() => { setAmount(String(balance / 100)); setPick({}); }}>Pay all {money(balance)}</Button>}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Amount (Rs)" required><RupeeInput value={amount} onChange={setAmount} autoFocus={!!fixedSupplier && !billId} /></Field>
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {SUPPLIER_PAYMENT_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
            </Select>
          </Field>
          <Field label="Transaction / reference ID"><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} placeholder="UPI ref, cheque no..." /></Field>
        </div>

        {acc.data && acc.data.openBills.length > 0 && (
          <div>
            <p className="mb-1 text-[13px] font-medium text-slate-700">Settle specific bills (optional)</p>
            <p className="mb-2 text-xs text-slate-500">Anything not set against a bill here settles the oldest unpaid bills first.</p>
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {acc.data.openBills.map((b) => (
                <div key={b.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{b.number}</span> <span className="text-slate-500">{fmtDate(b.billDate)}{b.invoiceNo ? ` - inv. ${b.invoiceNo}` : ""}</span>
                    <div className="text-xs text-slate-600">Owed {money(b.due)} of {money(b.total)} <BillStatus status={b.displayStatus} /></div>
                  </div>
                  <Input aria-label={`Amount for ${b.number}`} className="h-9 w-28" type="number" inputMode="decimal" min="0" step="0.01" max={b.due / 100}
                    value={pick[b.id] ?? ""} placeholder="0.00" onChange={(e) => setPick({ ...pick, [b.id]: e.target.value })} />
                  <Button size="sm" variant="ghost" onClick={() => setPick({ ...pick, [b.id]: String(b.due / 100) })}>Full</Button>
                </div>
              ))}
            </div>
            {pickedTotal > amt && <p className="mt-1 text-xs text-red-700">The bills add up to {money(pickedTotal)}, more than the payment.</p>}
          </div>
        )}

        {advance > 0 && acc.data && (
          <Notice tone="warn" title={balance > 0 ? `This is ${money(advance)} more than you owe` : `Nothing is owed to ${acc.data.supplier.name}`}>
            <label className="mt-1 flex items-center gap-2">
              <input type="checkbox" checked={advanceOk} onChange={(e) => setAdvanceOk(e.target.checked)} />
              Keep {money(advance)} as an advance (it settles the next purchases)
            </label>
          </Notice>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <PhotoInput label="Receipt / screenshot" file={photo} onFile={setPhoto} />
          <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></Field>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Adjustments, cancellation, reversal
// ---------------------------------------------------------------------------

function AdjustmentForm({ supplierId, bills, onClose, onSaved, presetBill }: { supplierId: string; bills: Bill[]; presetBill?: string; onClose: () => void; onSaved: () => void }) {
  const today = useToday();
  const [direction, setDirection] = useState<"DECREASE" | "INCREASE">("DECREASE");
  const [kind, setKind] = useState("RETURN");
  const [amount, setAmount] = useState("");
  const [purchaseId, setPurchaseId] = useState(presetBill ?? "");
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState("");
  const [allowAdvance, setAllowAdvance] = useState(false);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [clientRef] = useState(newRef);
  const [busy, run] = useAction();
  const submit = () => run(async () => {
    try {
      await api("/dine/payables/adjustments", { method: "POST", body: { supplierId, direction, kind, amount: rupeesToPaise(amount), purchaseId: purchaseId || null, adjustmentDate: date, reason, allowAdvance, clientRef } });
    } catch (e) {
      if (e instanceof ApiError && e.code === "EXCEEDS_BALANCE") setNeedsConfirm(true);
      throw e;
    }
    onSaved();
  }, "Adjustment recorded");
  return (
    <Modal open title="Adjust balance" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!(rupeesToPaise(amount || "0") > 0) || reason.trim().length < 3} onClick={() => void submit()}>Save adjustment</Button></>}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Direction">
          {([["DECREASE", "We owe less", "Return, discount, correction"], ["INCREASE", "We owe more", "Missed charge, correction"]] as const).map(([k, label, hint]) => (
            <button key={k} type="button" role="radio" aria-checked={direction === k} onClick={() => { setDirection(k); setKind(k === "DECREASE" ? "RETURN" : "CORRECTION"); }}
              className={cx("rounded-lg border p-2 text-left text-sm", direction === k ? "border-brand bg-brand-soft" : "border-slate-300 hover:bg-slate-50")}>
              <span className="block font-medium">{label}</span><span className="text-xs text-slate-600">{hint}</span>
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Type">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {ADJUSTMENT_KINDS.filter((k) => direction === "DECREASE" || ["CORRECTION", "OTHER"].includes(k)).map((k) => <option key={k} value={k}>{humanize(k)}</option>)}
            </Select>
          </Field>
          <Field label="Amount (Rs)" required><RupeeInput value={amount} onChange={setAmount} /></Field>
          <Field label="Against bill" help={direction === "DECREASE" ? "A return or discount on a bill settles that bill first." : undefined}>
            <Select value={purchaseId} onChange={(e) => setPurchaseId(e.target.value)}>
              <option value="">No specific bill</option>
              {bills.map((b) => <option key={b.id} value={b.id}>{b.number} - {fmtDate(b.billDate)} - {money(b.total)}</option>)}
            </Select>
          </Field>
          <Field label="Date"><Input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>
        </div>
        <Field label="Reason" required help="Kept in the ledger and the audit log."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} placeholder="2 kg returned: not fresh" /></Field>
        {needsConfirm && (
          <Notice tone="warn">
            <label className="flex items-center gap-2"><input type="checkbox" checked={allowAdvance} onChange={(e) => setAllowAdvance(e.target.checked)} /> Yes, keep the difference as credit with the supplier</label>
          </Notice>
        )}
      </div>
    </Modal>
  );
}

function ReasonDialog({ title, intro, confirm, extra, onClose, onConfirm }: { title: string; intro: ReactNode; confirm: string; extra?: ReactNode; onClose: () => void; onConfirm: (reason: string) => Promise<unknown> }) {
  const [reason, setReason] = useState("");
  const [busy, run] = useAction();
  return (
    <Modal open size="sm" title={title} onClose={onClose}
      footer={<><Button onClick={onClose}>Keep it</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => void run(() => onConfirm(reason), "Done").then((ok) => ok && onClose())}>{confirm}</Button></>}>
      <div className="space-y-3 text-sm">
        <div className="text-slate-700">{intro}</div>
        <Field label="Reason" required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} autoFocus /></Field>
        {extra}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Bill detail
// ---------------------------------------------------------------------------

interface BillDetail extends Bill {
  attachmentUrl: string | null;
  allocations: { id: string; amount: number; createdAt: string; voidedAt: string | null; voidReason: string | null; source: { kind: string; number: string; date: string; method?: string; status: string } }[];
}

function BillModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const p = useProduct();
  const r = useApi<BillDetail>(`/dine/payables/purchases/${id}`);
  const [dialog, setDialog] = useState<"pay" | "cancel" | "adjust" | "edit" | null>(null);
  const [reversePay, setReversePay] = useState(false);
  const canManage = p.can("payables.manage");
  const canAdjust = p.can("payables.adjust");
  const changed = async () => { setDialog(null); await r.reload(); onChanged(); };
  return (
    <Modal open size="lg" title={r.data ? `${r.data.kind === "OPENING_BALANCE" ? "Opening balance" : "Purchase"} ${r.data.number}` : "Purchase"} onClose={onClose}
      footer={r.data && r.data.status === "ACTIVE" ? (
        <>
          {canAdjust && <Button variant="ghost" onClick={() => setDialog("cancel")}><Ban className="h-4 w-4" /> Cancel purchase</Button>}
          {canAdjust && <Button onClick={() => setDialog("adjust")}><Scale className="h-4 w-4" /> Return / adjust</Button>}
          {canManage && <Button onClick={() => setDialog("edit")}><Pencil className="h-4 w-4" /> Edit details</Button>}
          {canManage && r.data.due > 0 && <Button variant="primary" onClick={() => setDialog("pay")}><Banknote className="h-4 w-4" /> Pay this bill</Button>}
        </>
      ) : undefined}>
      <Loadable state={r}>
        {(b) => (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <KeyValue items={[
                ["Supplier", <Link key="s" className="font-medium text-brand underline" href={`${p.base}/supplier-credit/${b.supplier.id}`}>{b.supplier.name}</Link>],
                ["Purchase date", fmtDate(b.billDate)],
                ["Due date", b.dueDate ? `${fmtDate(b.dueDate)}${b.daysOverdue ? ` (${b.daysOverdue} days late)` : ""}` : "Not set"],
                ["Invoice no.", b.invoiceNo ?? "-"],
                ["Status", <BillStatus key="st" status={b.displayStatus} />],
              ]} />
              <KeyValue items={[
                ["Total", <strong key="t" className="tnum">{money(b.total)}</strong>],
                ["Paid at purchase", money(b.paidAtPurchase)],
                ["Settled so far", money(b.settled)],
                ["Still owed", <strong key="d" className={cx("tnum", b.due > 0 && "text-amber-800")}>{money(b.due)}</strong>],
                ["Bill photo", b.attachmentUrl ? <a key="a" className="text-brand underline" href={b.attachmentUrl} target="_blank" rel="noreferrer">View photo</a> : "None"],
              ]} />
            </div>
            {b.status === "CANCELLED" && <Notice tone="bad" title={`Cancelled ${fmtDateTime(b.cancelledAt)}`}>{b.cancelReason}</Notice>}
            {b.dinePurchaseId && <Notice>Created from a received stock purchase order.</Notice>}
            {b.items.length > 0 && (
              <Card pad={false} title="Items">
                <DataTable dense rowKey={(x) => x.id} rows={b.items} columns={[
                  { key: "p", label: "Product", render: (x) => <>{x.productName} <span className="text-xs text-slate-500">{humanize(x.category)}</span></> },
                  { key: "q", label: "Quantity", align: "right", render: (x) => `${x.quantity} ${UNIT_LABEL[x.unit] || humanize(x.unit)}` },
                  { key: "r", label: "Rate", align: "right", render: (x) => money(x.rate) },
                  { key: "a", label: "Amount", align: "right", render: (x) => money(x.amount) },
                ]} />
              </Card>
            )}
            <Card pad={false} title="How it was settled" subtitle="Payments and credits set against this bill. Voided lines were undone by a cancellation or reversal.">
              <DataTable dense rowKey={(x) => x.id} rows={b.allocations} empty={<Empty title="Nothing paid against this bill yet" />} columns={[
                { key: "d", label: "Date", render: (x) => fmtDate(x.source.date) },
                { key: "s", label: "From", render: (x) => <>{x.source.number} <span className="text-xs text-slate-500">{x.source.kind === "PAYMENT" ? METHOD_LABEL[x.source.method ?? ""] : humanize(x.source.kind)}</span></> },
                { key: "a", label: "Amount", align: "right", render: (x) => <span className={x.voidedAt ? "text-slate-400 line-through" : ""}>{money(x.amount)}</span> },
                { key: "v", label: "", render: (x) => (x.voidedAt ? <span className="text-xs text-slate-500">Voided: {x.voidReason}</span> : null) },
              ]} />
            </Card>
            {b.notes && <p className="text-sm text-slate-600">Notes: {b.notes}</p>}
            {dialog === "pay" && <PaymentForm supplierId={b.supplier.id} billId={b.id} onClose={() => setDialog(null)} onSaved={() => void changed()} />}
            {dialog === "adjust" && <AdjustmentForm supplierId={b.supplier.id} bills={[b]} presetBill={b.id} onClose={() => setDialog(null)} onSaved={() => void changed()} />}
            {dialog === "edit" && <EditBillDialog bill={b} onClose={() => setDialog(null)} onSaved={() => void changed()} />}
            {dialog === "cancel" && (
              <ReasonDialog title={`Cancel ${b.number}?`} confirm="Cancel purchase" onClose={() => setDialog(null)}
                intro={<>The purchase stays in the ledger with a matching reversal, so the history is kept. {money(b.total)} comes off what you owe {b.supplier.name}.</>}
                extra={b.paidAtPurchase > 0 ? (
                  <label className="flex items-center gap-2"><input type="checkbox" checked={reversePay} onChange={(e) => setReversePay(e.target.checked)} /> Also undo the {money(b.paidAtPurchase)} paid with it (it was never really paid)</label>
                ) : undefined}
                onConfirm={async (reason) => { await api(`/dine/payables/purchases/${b.id}/cancel`, { method: "POST", body: { reason, reversePayments: reversePay } }); await changed(); }} />
            )}
          </div>
        )}
      </Loadable>
    </Modal>
  );
}

function EditBillDialog({ bill, onClose, onSaved }: { bill: Bill; onClose: () => void; onSaved: () => void }) {
  const [invoiceNo, setInvoiceNo] = useState(bill.invoiceNo ?? "");
  const [dueDate, setDueDate] = useState(bill.dueDate ?? "");
  const [notes, setNotes] = useState(bill.notes ?? "");
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, run] = useAction();
  return (
    <Modal open size="sm" title={`Edit ${bill.number}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void run(async () => {
        await api(`/dine/payables/purchases/${bill.id}`, { method: "PATCH", body: { invoiceNo, dueDate: dueDate || null, notes } });
        await uploadPhoto(`/dine/payables/purchases/${bill.id}/attachment`, photo);
        onSaved();
      }, "Saved")}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Supplier's invoice / bill number"><Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} maxLength={60} /></Field>
        <Field label="Due date"><Input type="date" min={bill.billDate} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
        <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2} /></Field>
        <PhotoInput label={bill.hasAttachment ? "Replace bill photo" : "Bill photo"} file={photo} onFile={setPhoto} />
        <p className="text-xs text-slate-500">Amounts, items, supplier and date cannot be edited. If they are wrong, cancel this purchase and record it again.</p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Dashboard: /dine/supplier-credit  (and /dine/supplier-credit/<id>: supplier account)
// ---------------------------------------------------------------------------

interface Summary {
  today: string; totalOutstanding: number; suppliersOwed: number; totalAdvance: number; purchasesThisMonth: number; purchaseCountThisMonth: number;
  paidThisMonth: number; paymentCountThisMonth: number; overdueAmount: number; overdueBills: number; overdueSuppliers: number; activeSuppliers: number;
  newCreditToday: number; newCreditBillsToday: number; overLimit: { id: string; name: string; balance: number; creditLimit: number }[];
  totalCreditLimit: number | null; linkStockPurchases: boolean; usesStockPurchases: boolean;
}

/** Record purchase / payment / supplier, shared by the screens. */
function useRecorders(onChange: () => void) {
  const [open, setOpen] = useState<"purchase" | "payment" | "supplier" | null>(null);
  const router = useRouter();
  const p = useProduct();
  const node = (
    <>
      {open === "purchase" && <PurchaseForm onClose={() => setOpen(null)} onSaved={() => { setOpen(null); onChange(); }} />}
      {open === "payment" && <PaymentForm onClose={() => setOpen(null)} onSaved={() => { setOpen(null); onChange(); }} />}
      {open === "supplier" && <SupplierForm onClose={() => setOpen(null)} onSaved={(id) => { setOpen(null); router.push(`${p.base}/supplier-credit/${id}`); }} />}
    </>
  );
  const buttons = (
    <>
      {p.can("payables.manage") && <Button onClick={() => setOpen("supplier")}><Plus className="h-4 w-4" /> Add supplier</Button>}
      {p.can("payables.manage") && <Button onClick={() => setOpen("payment")}><Banknote className="h-4 w-4" /> Record payment</Button>}
      {p.can("payables.manage") && <Button variant="primary" onClick={() => setOpen("purchase")}><ReceiptText className="h-4 w-4" /> Record purchase</Button>}
    </>
  );
  // Phones: the most common action stays one tap away.
  const fab = p.can("payables.manage") ? (
    <button type="button" onClick={() => setOpen("purchase")} className="no-print fixed bottom-5 right-5 z-40 inline-flex h-14 items-center gap-2 rounded-full bg-brand px-5 text-sm font-semibold text-brand-ink shadow-lg sm:hidden">
      <Plus className="h-5 w-5" aria-hidden /> Purchase
    </button>
  ) : null;
  return { node, buttons, fab, open: setOpen };
}

export function SupplierCreditScreen({ rest }: { rest: string[] }) {
  if (rest[0]) return <SupplierAccountScreen id={rest[0]} />;
  return <SupplierDashboard />;
}

function SupplierDashboard() {
  const p = useProduct();
  const router = useRouter();
  const summary = useApi<Summary>("/dine/payables/summary");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("active");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("balance");
  const [page, setPage] = useState(1);
  const list = useApi<Paged<SupplierRow> & { totals: { balance: number; overdue: number } }>(`/dine/payables/suppliers${qs({ q: q || undefined, status, category: category || undefined, sort, page, pageSize: 25 })}`);
  const reload = async () => { await Promise.all([summary.reload(), list.reload()]); };
  const rec = useRecorders(() => void reload());

  return (
    <>
      <PageHeader title="Supplier credit" description="What you owe each supplier, from every purchase and payment you record." actions={rec.buttons} />
      <Loadable state={summary}>
        {(s) => (
          <div className="space-y-4">
            <KpiRow cols={6}>
              <StatTile label="Total outstanding" value={money(s.totalOutstanding)} sub={`${s.suppliersOwed} supplier${s.suppliersOwed === 1 ? "" : "s"}${s.totalAdvance ? ` | ${money(s.totalAdvance)} advance` : ""}`} tone={s.totalCreditLimit != null && s.totalOutstanding > s.totalCreditLimit ? "warn" : undefined} />
              <StatTile label="Purchases this month" value={money(s.purchasesThisMonth)} sub={`${s.purchaseCountThisMonth} purchase${s.purchaseCountThisMonth === 1 ? "" : "s"}`} />
              <StatTile label="Paid this month" value={money(s.paidThisMonth)} sub={`${s.paymentCountThisMonth} payment${s.paymentCountThisMonth === 1 ? "" : "s"}`} />
              <StatTile label="Overdue" value={money(s.overdueAmount)} sub={s.overdueBills ? `${s.overdueBills} bill${s.overdueBills === 1 ? "" : "s"}, ${s.overdueSuppliers} supplier${s.overdueSuppliers === 1 ? "" : "s"}` : "Nothing overdue"} tone={s.overdueAmount ? "bad" : undefined} />
              <StatTile label="Active suppliers" value={s.activeSuppliers} />
              <StatTile label="New credit today" value={money(s.newCreditToday)} sub={`${s.newCreditBillsToday} purchase${s.newCreditBillsToday === 1 ? "" : "s"} on credit`} />
            </KpiRow>
            {s.overdueAmount > 0 && (
              <Notice tone="bad" title={`${money(s.overdueAmount)} is overdue`} action={<Link href={`${p.base}/supplier-purchases?status=OVERDUE`}><Button size="sm">See overdue bills</Button></Link>}>
                {s.overdueBills} bill{s.overdueBills === 1 ? " is" : "s are"} past the due date.
              </Notice>
            )}
            {s.overLimit.length > 0 && (
              <Notice tone="warn" title="Over the credit limit">
                {s.overLimit.map((x) => `${x.name}: owed ${money(x.balance)}, limit ${money(x.creditLimit)}`).join(" | ")}
              </Notice>
            )}
            {s.usesStockPurchases && !s.linkStockPurchases && p.can("payables.adjust") && (
              <Notice action={<Link href={`${p.base}/supplier-alerts`}><Button size="sm">Settings</Button></Link>}>
                You also use stock purchase orders. To avoid recording the same purchase twice, let received orders create the supplier bill automatically.
              </Notice>
            )}
          </div>
        )}
      </Loadable>

      <Card className="mt-4" pad={false} title="Suppliers" subtitle={list.data ? `${list.data.total} supplier${list.data.total === 1 ? "" : "s"} | outstanding ${money(list.data.totals.balance)}` : undefined}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <Input aria-label="Search suppliers" className="w-full sm:w-56" placeholder="Search name or phone" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <Select aria-label="Status" className="w-40" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="active">Active</option><option value="owed">Money owed</option><option value="overdue">Overdue</option>
            <option value="advance">Paid in advance</option><option value="inactive">Inactive</option><option value="all">All</option>
          </Select>
          <Select aria-label="Category" className="w-40" value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}>
            <option value="">All categories</option>
            {SUPPLIER_CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
          </Select>
          <Select aria-label="Sort" className="w-44" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="balance">Highest outstanding</option><option value="overdue">Most overdue</option><option value="purchases">Most purchased</option>
            <option value="activity">Recent activity</option><option value="name">Name</option>
          </Select>
        </div>
        <Loadable state={list}>
          {(d) => (
            <>
              <DataTable rows={d.items} rowKey={(r) => r.id} onRowClick={(r) => router.push(`${p.base}/supplier-credit/${r.id}`)}
                empty={<Empty title={q || status !== "active" || category ? "No suppliers match" : "No suppliers yet"} hint="Add the suppliers you buy from on credit." action={p.can("payables.manage") ? <Button variant="primary" onClick={() => rec.open("supplier")}><Plus className="h-4 w-4" /> Add supplier</Button> : undefined} />}
                columns={[
                  { key: "name", label: "Supplier", render: (r) => <div><span className="font-medium">{r.name}</span>{!r.isActive && <Badge className="ml-2">Inactive</Badge>}<div className="text-xs text-slate-500">{humanize(r.category)}{r.phone ? ` | ${r.phone}` : ""}</div></div> },
                  { key: "purchases", label: "Total purchases", align: "right", render: (r) => money(r.purchases) },
                  { key: "paid", label: "Paid", align: "right", render: (r) => money(r.paid) },
                  { key: "pending", label: "Pending", align: "right", render: (r) => <Balance value={r.balance} /> },
                  { key: "overdue", label: "Overdue", align: "right", render: (r) => (r.overdue ? <span className="font-medium text-red-700">{money(r.overdue)}</span> : <span className="text-slate-400">-</span>) },
                  { key: "status", label: "Status", render: (r) => (r.overdue ? <BillStatus status="OVERDUE" /> : r.balance > 0 ? <BillStatus status={r.paid > 0 ? "PARTIALLY_PAID" : "UNPAID"} /> : r.balance < 0 ? <Badge tone="good">Advance</Badge> : <BillStatus status="PAID" />) },
                ]} />
              <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
            </>
          )}
        </Loadable>
      </Card>
      {rec.node}
      {rec.fab}
    </>
  );
}

// ---------------------------------------------------------------------------
// Supplier account and ledger
// ---------------------------------------------------------------------------

interface Ledger {
  opening: number; closing: number; totals: { increase: number; decrease: number };
  entries: { id: string; date: string; type: string; description: string; reference: string | null; increase: number; decrease: number; balance: number; purchaseId: string | null }[];
}

const ENTRY_LABEL: Record<string, string> = {
  OPENING_BALANCE: "Opening balance", PURCHASE: "Purchase", PAYMENT: "Payment", ADJUSTMENT_INCREASE: "Adjustment (+)", ADJUSTMENT_DECREASE: "Return / credit",
  PURCHASE_CANCELLED: "Purchase cancelled", PAYMENT_REVERSED: "Payment reversed", ADJUSTMENT_REVERSED: "Adjustment reversed",
};

function SupplierAccountScreen({ id }: { id: string }) {
  const p = useProduct();
  const acc = useApi<SupplierAccount>(`/dine/payables/suppliers/${id}`);
  const [tab, setTab] = useState<"ledger" | "bills" | "payments">("ledger");
  const [range, setRange] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const ledger = useApi<Ledger>(`/dine/payables/suppliers/${id}/ledger${qs({ from: range.from || undefined, to: range.to || undefined })}`);
  const [dialog, setDialog] = useState<"purchase" | "payment" | "adjust" | "edit" | "deactivate" | null>(null);
  const [billId, setBillId] = useState<string | null>(null);
  const [busy, run] = useAction();
  const reload = async () => { setDialog(null); await Promise.all([acc.reload(), ledger.reload()]); };

  return (
    <Loadable state={acc}>
      {(a) => {
        const s = a.supplier;
        const wa = s.whatsapp || s.phone;
        return (
          <>
            <Link href={`${p.base}/supplier-credit`} className="no-print mb-2 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"><ArrowLeft className="h-4 w-4" /> All suppliers</Link>
            <PageHeader
              title={s.name}
              description={<>{s.businessName ? `${s.businessName} | ` : ""}{humanize(s.category)}{s.paymentTermsDays != null ? ` | ${s.paymentTermsDays} days credit` : ""}{s.phone ? ` | ${s.phone}` : ""}{!s.isActive && <Badge className="ml-2">Inactive</Badge>}</>}
              actions={
                <>
                  {wa && <a href={`https://wa.me/${wa.replace(/\D/g, "").replace(/^(\d{10})$/, "91$1")}`} target="_blank" rel="noreferrer"><Button><MessageCircle className="h-4 w-4" /> WhatsApp</Button></a>}
                  {p.can("payables.manage") && <Button onClick={() => setDialog("edit")}><Pencil className="h-4 w-4" /> Edit</Button>}
                  {p.can("payables.adjust") && <Button onClick={() => setDialog("adjust")}><Scale className="h-4 w-4" /> Adjust</Button>}
                  {p.can("payables.manage") && <Button onClick={() => setDialog("payment")}><Banknote className="h-4 w-4" /> Record payment</Button>}
                  {p.can("payables.manage") && s.isActive && <Button variant="primary" onClick={() => setDialog("purchase")}><ReceiptText className="h-4 w-4" /> Record purchase</Button>}
                </>
              }
            />
            <KpiRow cols={5}>
              <StatTile label={a.account.balance < 0 ? "Advance with supplier" : "Outstanding"} value={money(Math.abs(a.account.balance))} sub={a.account.openBills ? `${a.account.openBills} unpaid bill${a.account.openBills === 1 ? "" : "s"}` : "No unpaid bills"} tone={a.account.overLimit ? "warn" : undefined} />
              <StatTile label="Overdue" value={money(a.account.overdue)} sub={a.account.overdueBills ? `${a.account.overdueBills} bill${a.account.overdueBills === 1 ? "" : "s"}` : undefined} tone={a.account.overdue ? "bad" : undefined} />
              <StatTile label="Total purchases" value={money(a.account.purchases)} sub="incl. opening balance" />
              <StatTile label="Total paid" value={money(a.account.paid)} sub={a.account.otherCredits ? `+ ${money(a.account.otherCredits)} returns & credits` : undefined} />
              <StatTile label="Credit limit" value={s.creditLimit != null ? money(s.creditLimit) : "None"} sub={a.account.overLimit ? "Over the limit" : a.account.oldestOpenBill ? `Oldest unpaid: ${fmtDate(a.account.oldestOpenBill)}` : undefined} tone={a.account.overLimit ? "warn" : undefined} />
            </KpiRow>
            {!s.isActive && a.account.balance !== 0 && <div className="mt-3"><Notice tone="warn">This supplier is inactive but still has a balance. You can record payments; new purchases need the supplier to be reactivated.</Notice></div>}

            <div className="mt-4">
              <Tabs value={tab} onChange={setTab} tabs={[{ key: "ledger", label: "Ledger" }, { key: "bills", label: "Unpaid bills", count: a.openBills.length }, { key: "payments", label: "Recent payments" }]} />
            </div>

            {tab === "ledger" && (
              <Card pad={false}
                title="Supplier ledger"
                subtitle={<>Every transaction with {s.name}, oldest first. <strong>Added</strong> raises what you owe (purchases, charges); <strong>Paid / reduced</strong> lowers it (payments, returns, cancellations). <strong>Balance</strong> is what you owe after each line; in your books this is the supplier&apos;s credit balance.</>}
                actions={
                  <div className="flex flex-wrap items-center gap-2">
                    <Input aria-label="From" type="date" className="h-8 w-36 text-xs" value={range.from} max={range.to || undefined} onChange={(e) => setRange({ ...range, from: e.target.value })} />
                    <Input aria-label="To" type="date" className="h-8 w-36 text-xs" value={range.to} min={range.from || undefined} onChange={(e) => setRange({ ...range, to: e.target.value })} />
                    <a href={`/api/dine/payables/suppliers/${id}/ledger${qs({ from: range.from || undefined, to: range.to || undefined, format: "csv" })}`}><Button size="sm"><FileSpreadsheet className="h-4 w-4" /> CSV</Button></a>
                  </div>
                }>
                <Loadable state={ledger}>
                  {(l) => (
                    <DataTable dense rowKey={(e) => e.id} rows={[{ id: "bf", date: range.from, type: "BF", description: "Balance brought forward", reference: null, increase: 0, decrease: 0, balance: l.opening, purchaseId: null }, ...l.entries, { id: "tot", date: "", type: "TOTAL", description: "Totals", reference: null, increase: l.totals.increase, decrease: l.totals.decrease, balance: l.closing, purchaseId: null }]}
                      onRowClick={(e) => e.purchaseId && setBillId(e.purchaseId)}
                      columns={[
                        { key: "date", label: "Date", render: (e) => (e.type === "BF" || e.type === "TOTAL" ? "" : fmtDate(e.date)) },
                        { key: "tx", label: "Transaction", render: (e) => (e.type === "BF" || e.type === "TOTAL" ? <span className="font-medium">{e.description}</span> : <div><span className="text-xs font-medium uppercase tracking-wide text-slate-500">{ENTRY_LABEL[e.type] ?? humanize(e.type)}</span><div>{e.description}</div></div>) },
                        { key: "ref", label: "Reference", render: (e) => e.reference ?? "" },
                        { key: "inc", label: "Added (+)", align: "right", render: (e) => (e.increase ? money(e.increase) : "") },
                        { key: "dec", label: "Paid / reduced (-)", align: "right", render: (e) => (e.decrease ? money(e.decrease) : "") },
                        { key: "bal", label: "Balance", align: "right", render: (e) => <Balance value={e.balance} className={e.type === "TOTAL" ? "font-semibold" : ""} /> },
                      ]} />
                  )}
                </Loadable>
              </Card>
            )}
            {tab === "bills" && (
              <Card pad={false} title="Unpaid bills" subtitle="Oldest first: payments settle these in this order unless you choose a bill.">
                <BillTable rows={a.openBills} onOpen={setBillId} showSupplier={false} />
              </Card>
            )}
            {tab === "payments" && (
              <Card pad={false} title="Recent payments" actions={<Link href={`${p.base}/supplier-payments?supplierId=${s.id}`}><Button size="sm">All payments</Button></Link>}>
                <DataTable dense rowKey={(x) => x.id} rows={a.recentPayments} empty={<Empty title="No payments yet" />} columns={[
                  { key: "d", label: "Date", render: (x) => fmtDate(x.paymentDate) },
                  { key: "n", label: "Payment", render: (x) => x.number },
                  { key: "m", label: "Method", render: (x) => METHOD_LABEL[x.method] ?? x.method },
                  { key: "r", label: "Reference", render: (x) => x.reference ?? "-" },
                  { key: "a", label: "Amount", align: "right", render: (x) => <span className={x.status === "REVERSED" ? "text-slate-400 line-through" : ""}>{money(x.amount)}</span> },
                  { key: "s", label: "", render: (x) => (x.status === "REVERSED" ? <StatusBadge value="REVERSED" /> : null) },
                ]} />
              </Card>
            )}

            {p.can("payables.manage") && (
              <div className="mt-4 flex justify-end">
                <Button variant="ghost" loading={busy} onClick={() => (s.isActive ? setDialog("deactivate") : void run(async () => { await api(`/dine/payables/suppliers/${s.id}`, { method: "PATCH", body: { isActive: true } }); await reload(); }, "Supplier reactivated"))}>
                  <Power className="h-4 w-4" /> {s.isActive ? "Deactivate supplier" : "Reactivate supplier"}
                </Button>
              </div>
            )}

            {dialog === "purchase" && <PurchaseForm supplierId={s.id} onClose={() => setDialog(null)} onSaved={() => void reload()} />}
            {dialog === "payment" && <PaymentForm supplierId={s.id} onClose={() => setDialog(null)} onSaved={() => void reload()} />}
            {dialog === "adjust" && <AdjustmentForm supplierId={s.id} bills={a.openBills} onClose={() => setDialog(null)} onSaved={() => void reload()} />}
            {dialog === "edit" && <SupplierForm initial={{ ...a.account, ...s }} onClose={() => setDialog(null)} onSaved={() => void reload()} />}
            {dialog === "deactivate" && (
              <Modal open size="sm" title={`Deactivate ${s.name}?`} onClose={() => setDialog(null)}
                footer={<><Button onClick={() => setDialog(null)}>Keep active</Button><Button variant="danger" loading={busy} onClick={() => void run(async () => { await api(`/dine/payables/suppliers/${s.id}`, { method: "PATCH", body: { isActive: false } }); await reload(); }, "Supplier deactivated")}>Deactivate</Button></>}>
                <p className="text-sm text-slate-700">No new purchases can be recorded from an inactive supplier. Its history stays in every report.</p>
                {a.account.balance > 0 && <div className="mt-3"><Notice tone="warn">You still owe {money(a.account.balance)}. Payments can still be recorded after deactivating.</Notice></div>}
              </Modal>
            )}
            {billId && <BillModal id={billId} onClose={() => setBillId(null)} onChanged={() => void reload()} />}
          </>
        );
      }}
    </Loadable>
  );
}

function BillTable({ rows, onOpen, showSupplier = true }: { rows: Bill[]; onOpen: (id: string) => void; showSupplier?: boolean }) {
  return (
    <DataTable rows={rows} rowKey={(b) => b.id} onRowClick={(b) => onOpen(b.id)}
      empty={<Empty title="No bills" />}
      columns={[
        { key: "date", label: "Date", render: (b) => fmtDate(b.billDate) },
        { key: "no", label: "Bill", render: (b) => <div><span className="font-medium">{b.number}</span>{b.invoiceNo && <div className="text-xs text-slate-500">Inv. {b.invoiceNo}</div>}</div> },
        ...(showSupplier ? [{ key: "sup", label: "Supplier", render: (b: Bill) => b.supplier.name }] : []),
        { key: "items", label: "Items", render: (b) => (b.kind === "OPENING_BALANCE" ? <span className="text-slate-500">Opening balance</span> : <span className="line-clamp-1 max-w-56">{b.items.map((i) => `${i.productName} ${i.quantity} ${UNIT_LABEL[i.unit] ?? ""}`).join(", ")}</span>) },
        { key: "total", label: "Total", align: "right", render: (b) => money(b.total) },
        { key: "paid", label: "Paid", align: "right", render: (b) => money(b.settled) },
        { key: "due", label: "Pending", align: "right", render: (b) => <span className={cx("font-medium", b.due > 0 ? "text-slate-900" : "text-slate-400")}>{money(b.due)}</span> },
        { key: "dueDate", label: "Due", render: (b) => (b.dueDate ? <span className={b.daysOverdue ? "text-red-700" : ""}>{fmtDate(b.dueDate)}</span> : "-") },
        { key: "status", label: "Status", render: (b) => <BillStatus status={b.displayStatus} /> },
      ]} />
  );
}

// ---------------------------------------------------------------------------
// Credit purchases: /dine/supplier-purchases
// ---------------------------------------------------------------------------

export function SupplierPurchasesScreen() {
  const init = useMemo(queryParams, []);
  const suppliers = useSupplierOptions(true);
  const [status, setStatus] = useState(init.get("status") ?? "");
  const [supplierId, setSupplierId] = useState(init.get("supplierId") ?? "");
  const today = useToday();
  const [from, setFrom] = useState(addDays(today, -89));
  const [to, setTo] = useState(today);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [billId, setBillId] = useState<string | null>(null);
  // Open bills and overdue bills: any date.
  const dated = status !== "OPEN" && status !== "OVERDUE";
  const list = useApi<Paged<Bill>>(`/dine/payables/purchases${qs({ status: status || undefined, supplierId: supplierId || undefined, from: dated ? from : undefined, to: dated ? to : undefined, q: q || undefined, page })}`);
  const rec = useRecorders(() => void list.reload());
  return (
    <>
      <PageHeader title="Credit purchases" description="Everything bought from suppliers, with what is still owed on each bill." actions={rec.buttons} />
      <Tabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} tabs={[
        { key: "", label: "All" }, { key: "OPEN", label: "Not fully paid" }, { key: "OVERDUE", label: "Overdue" }, { key: "UNPAID", label: "Unpaid" },
        { key: "PARTIALLY_PAID", label: "Partially paid" }, { key: "PAID", label: "Paid" }, { key: "CANCELLED", label: "Cancelled" },
      ]} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select aria-label="Supplier" className="w-52" value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setPage(1); }}>
          <option value="">All suppliers</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        {dated && (
          <>
            <Input aria-label="From date" type="date" className="w-40" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
            <span className="text-sm text-slate-500">to</span>
            <Input aria-label="To date" type="date" className="w-40" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
          </>
        )}
        <Input aria-label="Search" className="w-full sm:w-56" placeholder="Product, invoice or SP-number" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
      </div>
      <Card pad={false}>
        <Loadable state={list}>
          {(d) => (
            <>
              <BillTable rows={d.items} onOpen={setBillId} />
              <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
            </>
          )}
        </Loadable>
      </Card>
      {billId && <BillModal id={billId} onClose={() => setBillId(null)} onChanged={() => void list.reload()} />}
      {rec.node}
      {rec.fab}
    </>
  );
}

// ---------------------------------------------------------------------------
// Supplier payments: /dine/supplier-payments
// ---------------------------------------------------------------------------

interface PaymentRow {
  id: string; number: string; supplier: { id: string; name: string }; paymentDate: string; amount: number; method: string; reference: string | null; notes: string | null;
  status: string; isAdvance: boolean; paidWithPurchase: boolean; hasReceipt: boolean; receiptUrl: string | null; allocated: number; unallocated: number;
  bills: { number: string; amount: number }[]; reverseReason: string | null;
}

export function SupplierPaymentsScreen() {
  const p = useProduct();
  const init = useMemo(queryParams, []);
  const suppliers = useSupplierOptions(true);
  const [supplierId, setSupplierId] = useState(init.get("supplierId") ?? "");
  const today = useToday();
  const [from, setFrom] = useState(addDays(today, -29));
  const [to, setTo] = useState(today);
  const [method, setMethod] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [reversing, setReversing] = useState<PaymentRow | null>(null);
  const list = useApi<Paged<PaymentRow> & { totalPaid: number }>(`/dine/payables/payments${qs({ supplierId: supplierId || undefined, from, to, method: method || undefined, q: q || undefined, page })}`);
  const rec = useRecorders(() => void list.reload());
  return (
    <>
      <PageHeader title="Supplier payments" description="Money paid to suppliers and the bills each payment settled." actions={rec.buttons} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select aria-label="Supplier" className="w-52" value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setPage(1); }}>
          <option value="">All suppliers</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Input aria-label="From date" type="date" className="w-40" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        <span className="text-sm text-slate-500">to</span>
        <Input aria-label="To date" type="date" className="w-40" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        <Select aria-label="Method" className="w-40" value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="">All methods</option>
          {SUPPLIER_PAYMENT_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
        </Select>
        <Input aria-label="Search" className="w-full sm:w-48" placeholder="Reference or PAY-number" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Card pad={false} subtitle={list.data ? `Paid in this period: ${money(list.data.totalPaid)} (reversed payments not counted)` : undefined} title="Payments">
        <Loadable state={list}>
          {(d) => (
            <>
              <DataTable rows={d.items} rowKey={(x) => x.id} empty={<Empty title="No payments in this period" />} columns={[
                { key: "d", label: "Date", render: (x) => fmtDate(x.paymentDate) },
                { key: "n", label: "Payment", render: (x) => <div><span className="font-medium">{x.number}</span>{x.paidWithPurchase && <div className="text-xs text-slate-500">Paid at purchase</div>}</div> },
                { key: "s", label: "Supplier", render: (x) => <Link className="text-brand underline" href={`${p.base}/supplier-credit/${x.supplier.id}`}>{x.supplier.name}</Link> },
                { key: "m", label: "Method", render: (x) => <>{METHOD_LABEL[x.method] ?? x.method}{x.reference && <div className="text-xs text-slate-500">{x.reference}</div>}</> },
                { key: "b", label: "Settled", render: (x) => (x.status === "REVERSED" ? <span className="text-xs text-slate-500">Reversed: {x.reverseReason}</span> : <span className="text-xs">{x.bills.map((b) => `${b.number} ${money(b.amount)}`).join(", ") || "-"}{x.unallocated > 0 && <Badge tone="good" className="ml-1">{money(x.unallocated)} advance</Badge>}</span>) },
                { key: "a", label: "Amount", align: "right", render: (x) => <span className={x.status === "REVERSED" ? "text-slate-400 line-through" : "font-medium"}>{money(x.amount)}</span> },
                { key: "r", label: "", render: (x) => (
                  <div className="flex justify-end gap-1">
                    {x.receiptUrl && <a href={x.receiptUrl} target="_blank" rel="noreferrer"><Button size="sm" variant="ghost">Receipt</Button></a>}
                    {x.status === "ACTIVE" && p.can("payables.adjust") && <Button size="sm" variant="ghost" onClick={() => setReversing(x)}><Undo2 className="h-3.5 w-3.5" /> Reverse</Button>}
                  </div>
                ) },
              ]} />
              <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
            </>
          )}
        </Loadable>
      </Card>
      {reversing && (
        <ReasonDialog title={`Reverse ${reversing.number}?`} confirm="Reverse payment" onClose={() => setReversing(null)}
          intro={<>Use this when the payment was entered by mistake. The {money(reversing.amount)} is added back to what you owe {reversing.supplier.name}; both entries stay in the ledger.</>}
          onConfirm={async (reason) => { await api(`/dine/payables/payments/${reversing.id}/reverse`, { method: "POST", body: { reason } }); await list.reload(); }} />
      )}
      {rec.node}
      {rec.fab}
    </>
  );
}

// ---------------------------------------------------------------------------
// Reports: /dine/supplier-reports
// ---------------------------------------------------------------------------

interface Report {
  title: string; period: string; from: string; to: string; today: string; opening: number; closing: number; newCredit: number; creditSettled: number;
  purchaseCount: number; paymentCount: number; overdueTotal: number; reconciled: boolean;
  flow: { purchases: number; openingBalances: number; payments: number; paymentReversals: number; creditAdjustments: number; debitAdjustments: number; cancellations: number; adjustmentReversals: number; increase: number; decrease: number };
  previous: { from: string; to: string; purchases: number; payments: number; newCredit: number; closing: number };
  change: { purchases: number | null; payments: number | null; closing: number | null };
  daily: { date: string; purchases: number; payments: number; balance: number }[];
  suppliers: { id: string; name: string; category: string; isActive: boolean; opening: number; purchases: number; payments: number; other: number; closing: number; overdue: number }[];
  highest: { id: string; name: string; closing: number } | null;
  overdue: { id: string; number: string; supplier: string; billDate: string; dueDate: string | null; daysOverdue: number; due: number }[];
}

export function SupplierReportsScreen() {
  const p = useProduct();
  const init = useMemo(queryParams, []);
  const today = useToday();
  const [period, setPeriod] = useState<"day" | "week" | "month" | "custom">((["day", "week", "month", "custom"].includes(init.get("period") ?? "") ? init.get("period") : "day") as "day");
  const [date, setDate] = useState(init.get("date") ?? today);
  const [from, setFrom] = useState(addDays(today, -29));
  const [to, setTo] = useState(today);
  const query = qs(period === "custom" ? { period, from, to } : { period, date });
  const r = useApi<Report>(`/dine/payables/reports${query}`);
  const prevLabel = { day: "vs previous day", week: "vs previous week", month: "vs previous month", custom: "vs previous period" }[period];
  return (
    <>
      <PageHeader title="Credit reports" description="Purchases, payments and what you owe suppliers for any day, week or month. Built from the ledger, so the figures always add up." />
      <Tabs value={period} onChange={setPeriod} tabs={[{ key: "day", label: "Daily" }, { key: "week", label: "Weekly" }, { key: "month", label: "Monthly" }, { key: "custom", label: "Custom range" }]} />
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        {period === "custom" ? (
          <>
            <Input aria-label="From date" type="date" className="w-40" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
            <span className="text-sm text-slate-500">to</span>
            <Input aria-label="To date" type="date" className="w-40" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} />
          </>
        ) : (
          <Field label={period === "day" ? "Day" : period === "week" ? "Any day in the week (Mon-Sun)" : "Any day in the month"} className="w-56">
            <Input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </Field>
        )}
        <div className="ml-auto flex gap-2">
          <a href={`/api/dine/payables/reports/pdf${query}`}><Button><Download className="h-4 w-4" /> PDF</Button></a>
          <a href={`/api/dine/payables/reports/csv${query}`}><Button><FileSpreadsheet className="h-4 w-4" /> Excel (CSV)</Button></a>
        </div>
      </div>
      <Loadable state={r}>
        {(d) => (
          <div className={r.refreshing ? "space-y-4 opacity-60" : "space-y-4"}>
            <p className="text-sm font-medium text-slate-700">{d.title}</p>
            <KpiRow cols={6}>
              <StatTile label="Owed at start" value={money(d.opening)} />
              <StatTile label="Credit purchases" value={money(d.flow.purchases)} delta={{ pct: d.change.purchases, goodWhenUp: false, vs: prevLabel }} sub={`${d.purchaseCount} purchase${d.purchaseCount === 1 ? "" : "s"}`} />
              <StatTile label="Paid to suppliers" value={money(d.flow.payments - d.flow.paymentReversals)} delta={{ pct: d.change.payments, vs: prevLabel }} sub={`${d.paymentCount} payment${d.paymentCount === 1 ? "" : "s"}`} />
              <StatTile label="New credit" value={money(d.newCredit)} sub="unpaid part of purchases" />
              <StatTile label="Credit settled" value={money(d.creditSettled)} sub="payments, returns, credits" />
              <StatTile label="Owed at end" value={money(d.closing)} delta={{ pct: d.change.closing, goodWhenUp: false, vs: prevLabel }} tone={d.overdueTotal ? "warn" : undefined} sub={d.overdueTotal ? `${money(d.overdueTotal)} overdue now` : undefined} />
            </KpiRow>
            {!d.reconciled && <Notice tone="bad" title="The figures do not reconcile">Please contact support with this report.</Notice>}

            <div className="grid gap-4 xl:grid-cols-2">
              <Card pad={false} title="Movement" subtitle={`Previous period ${fmtDate(d.previous.from)}${d.previous.from === d.previous.to ? "" : ` - ${fmtDate(d.previous.to)}`}: purchases ${money(d.previous.purchases)}, paid ${money(d.previous.payments)}, owed at end ${money(d.previous.closing)}`}>
                <DataTable dense rowKey={(x) => x[0]} rows={([
                  ["Owed at start", d.opening, null],
                  ["Credit purchases", d.flow.purchases, "+"],
                  ["Opening balances added", d.flow.openingBalances, "+"],
                  ["Other increases", d.flow.debitAdjustments, "+"],
                  ["Payments reversed", d.flow.paymentReversals, "+"],
                  ["Payments", d.flow.payments, "-"],
                  ["Returns, discounts and credits", d.flow.creditAdjustments, "-"],
                  ["Cancelled purchases", d.flow.cancellations, "-"],
                  ["Adjustments reversed (net)", d.flow.adjustmentReversals, "+"],
                  ["Owed at end", d.closing, null],
                ] as [string, number, string | null][]).filter(([, v, sign], i, all) => i === 0 || i === all.length - 1 || v !== 0 || !sign)}
                  columns={[
                    { key: "l", label: "", render: (x) => <span className={x[2] ? "" : "font-semibold"}>{x[0]}</span> },
                    { key: "v", label: "Amount", align: "right", render: (x) => <span className={x[2] ? "" : "font-semibold"}>{x[2] === "-" ? `- ${money(x[1])}` : x[2] === "+" ? `+ ${money(x[1])}` : money(x[1])}</span> },
                  ]} />
              </Card>
              {d.daily.length > 1 ? (
                <ChartCard title="Day by day" subtitle="Purchases and payments per day"
                  legend={<Legend items={[{ label: "Purchases", color: SERIES_COLORS[0] }, { label: "Payments", color: SERIES_COLORS[1] }]} />}
                  table={{ columns: ["Date", "Purchases", "Payments", "Owed at end of day"], rows: d.daily.map((x) => [fmtDate(x.date), money(x.purchases), money(x.payments), money(x.balance)]) }}>
                  <StackedColumnChart data={d.daily.map((x) => ({ label: fmtDate(x.date).slice(0, 6), values: { purchases: x.purchases, payments: Math.max(0, x.payments) } }))}
                    series={[{ key: "purchases", label: "Purchases", color: SERIES_COLORS[0] }, { key: "payments", label: "Payments", color: SERIES_COLORS[1] }]}
                    format={(n) => formatINR(n, { whole: true })} axisFormat={fmtCompactINR} />
                </ChartCard>
              ) : (
                <Card title="Highest outstanding">
                  {d.highest ? <p className="text-sm"><Link className="font-medium text-brand underline" href={`${p.base}/supplier-credit/${d.highest.id}`}>{d.highest.name}</Link>: {money(d.highest.closing)}</p> : <p className="text-sm text-slate-500">Nothing is owed.</p>}
                </Card>
              )}
            </div>

            <Card pad={false} title="By supplier" subtitle={d.highest ? `Highest outstanding: ${d.highest.name} (${money(d.highest.closing)})` : undefined}>
              <DataTable dense rowKey={(x) => x.id} rows={d.suppliers} empty={<Empty title="No supplier activity in this period" />} columns={[
                { key: "n", label: "Supplier", render: (x) => <Link className="text-brand underline" href={`${p.base}/supplier-credit/${x.id}`}>{x.name}</Link> },
                { key: "o", label: "At start", align: "right", render: (x) => money(x.opening) },
                { key: "p", label: "Purchases", align: "right", render: (x) => money(x.purchases) },
                { key: "pd", label: "Paid", align: "right", render: (x) => money(x.payments) },
                { key: "ot", label: "Other", align: "right", render: (x) => (x.other ? money(x.other) : "-") },
                { key: "c", label: "At end", align: "right", render: (x) => <Balance value={x.closing} /> },
                { key: "od", label: "Overdue now", align: "right", render: (x) => (x.overdue ? <span className="text-red-700">{money(x.overdue)}</span> : "-") },
              ]} />
            </Card>

            <Card pad={false} title={`Overdue bills (as of ${fmtDate(d.today)})`}>
              <DataTable dense rowKey={(x) => x.id} rows={d.overdue} empty={<Empty title="Nothing is overdue" />} columns={[
                { key: "n", label: "Bill", render: (x) => x.number },
                { key: "s", label: "Supplier", render: (x) => x.supplier },
                { key: "b", label: "Bill date", render: (x) => fmtDate(x.billDate) },
                { key: "d", label: "Due date", render: (x) => fmtDate(x.dueDate) },
                { key: "l", label: "Days late", align: "right", render: (x) => x.daysOverdue },
                { key: "o", label: "Owed", align: "right", render: (x) => <span className="font-medium text-red-700">{money(x.due)}</span> },
              ]} />
            </Card>
          </div>
        )}
      </Loadable>
    </>
  );
}

// ---------------------------------------------------------------------------
// Alerts and settings: /dine/supplier-alerts
// ---------------------------------------------------------------------------

interface Alerts {
  today: string; overdueBills: Bill[]; overLimit: SupplierRow[]; totalOverLimit: { total: number; limit: number } | null;
  aging: { id: string; name: string; balance: number; oldestOpenBill: string; days: number }[]; agingDays: number | null;
  history: { id: string; kind: string; title: string; body: string; supplierId: string | null; recipients: number; channels: Record<string, string>; createdAt: string }[];
}
interface Settings {
  notifyPurchases: boolean; notifyPayments: boolean; notifyOverdue: boolean; totalCreditLimit: number | null; agingDays: number | null;
  dailySummary: boolean; weeklySummary: boolean; monthlySummary: boolean; whatsappEnabled: boolean; whatsappNumber: string | null; linkStockPurchases: boolean;
  whatsappReady: boolean; usesStockPurchases: boolean;
}

export function SupplierAlertsScreen() {
  const p = useProduct();
  const alerts = useApi<Alerts>("/dine/payables/alerts");
  const [billId, setBillId] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Credit alerts" description="What needs attention now, the alerts already sent, and how you want to be told." />
      <Loadable state={alerts}>
        {(a) => (
          <div className="space-y-4">
            {!a.overdueBills.length && !a.overLimit.length && !a.aging.length && !a.totalOverLimit && <Notice tone="good">Nothing needs attention: no overdue bills and no supplier over its limit.</Notice>}
            {a.totalOverLimit && <Notice tone="warn" title="Total supplier credit is over your limit">You owe {money(a.totalOverLimit.total)}; your limit is {money(a.totalOverLimit.limit)}.</Notice>}
            {a.overdueBills.length > 0 && (
              <Card pad={false} title={`Overdue bills (${a.overdueBills.length})`} subtitle={`${money(a.overdueBills.reduce((s, b) => s + b.due, 0))} past the due date`}>
                <BillTable rows={a.overdueBills} onOpen={setBillId} />
              </Card>
            )}
            {a.overLimit.length > 0 && (
              <Card pad={false} title="Over the credit limit">
                <DataTable dense rowKey={(x) => x.id} rows={a.overLimit} columns={[
                  { key: "n", label: "Supplier", render: (x) => <Link className="text-brand underline" href={`${p.base}/supplier-credit/${x.id}`}>{x.name}</Link> },
                  { key: "b", label: "Owed", align: "right", render: (x) => money(x.balance) },
                  { key: "l", label: "Limit", align: "right", render: (x) => money(x.creditLimit ?? 0) },
                ]} />
              </Card>
            )}
            {a.aging.length > 0 && (
              <Card pad={false} title={`Unpaid for more than ${a.agingDays} days`}>
                <DataTable dense rowKey={(x) => x.id} rows={a.aging} columns={[
                  { key: "n", label: "Supplier", render: (x) => <Link className="text-brand underline" href={`${p.base}/supplier-credit/${x.id}`}>{x.name}</Link> },
                  { key: "o", label: "Oldest unpaid bill", render: (x) => `${fmtDate(x.oldestOpenBill)} (${x.days} days)` },
                  { key: "b", label: "Owed", align: "right", render: (x) => money(x.balance) },
                ]} />
              </Card>
            )}
            <CreditSettingsCard />
            <Card pad={false} title="Alert history" subtitle="Sent in the app to everyone who can see supplier credit.">
              <DataTable dense rowKey={(x) => x.id} rows={a.history} empty={<Empty title="No alerts yet" />} columns={[
                { key: "t", label: "When", render: (x) => fmtDateTime(x.createdAt) },
                { key: "k", label: "Alert", render: (x) => <div><span className="font-medium">{x.title}</span><div className="text-xs text-slate-600">{x.body}</div></div> },
                { key: "c", label: "Delivered", render: (x) => (
                  <div className="flex flex-wrap gap-1">
                    <Badge tone="good">In app ({x.recipients})</Badge>
                    {x.channels.whatsapp && x.channels.whatsapp !== "OFF" && <Badge tone={x.channels.whatsapp === "SENT" ? "good" : "warn"}>WhatsApp: {humanize(x.channels.whatsapp.split(":")[0])}</Badge>}
                  </div>
                ) },
              ]} />
            </Card>
          </div>
        )}
      </Loadable>
      {billId && <BillModal id={billId} onClose={() => setBillId(null)} onChanged={() => void alerts.reload()} />}
    </>
  );
}

function CreditSettingsCard() {
  const p = useProduct();
  const r = useApi<Settings>("/dine/payables/settings");
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, run] = useAction();
  useEffect(() => { if (r.data) setDraft(r.data); }, [r.data]);
  const canEdit = p.can("payables.adjust");
  if (!draft) return <Loadable state={r}>{() => null}</Loadable>;
  const toggle = (k: keyof Settings, label: string, help?: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-0.5" disabled={!canEdit} checked={!!draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} />
      <span>{label}{help && <span className="block text-xs text-slate-500">{help}</span>}</span>
    </label>
  );
  const save = () => run(async () => {
    const { whatsappReady: _w, usesStockPurchases: _u, ...body } = draft;
    const saved = await api<Settings>("/dine/payables/settings", { method: "PUT", body });
    r.setData(saved);
  }, "Settings saved");
  return (
    <Card title={<span className="inline-flex items-center gap-2"><BellRing className="h-4 w-4" /> Alert settings</span>}
      subtitle={canEdit ? undefined : "Only a manager can change these."}
      actions={canEdit ? <Button variant="primary" loading={busy} onClick={() => void save()}>Save settings</Button> : undefined}>
      <div className="grid gap-6 md:grid-cols-3">
        <div className="space-y-2">
          <p className="text-[13px] font-semibold text-slate-800">Tell me when</p>
          {toggle("notifyPurchases", "A credit purchase is recorded")}
          {toggle("notifyPayments", "A supplier payment is recorded")}
          {toggle("notifyOverdue", "A bill becomes overdue", "Checked every day after closing time.")}
          <Field label="Total credit limit (Rs)" help="Alert when you owe all suppliers together more than this.">
            <Input type="number" min="0" step="0.01" disabled={!canEdit} value={draft.totalCreditLimit == null ? "" : draft.totalCreditLimit / 100} placeholder="No limit"
              onChange={(e) => setDraft({ ...draft, totalCreditLimit: e.target.value === "" ? null : rupeesToPaise(e.target.value) })} />
          </Field>
          <Field label="Alert when a bill is unpaid for (days)">
            <Input type="number" min="1" max="365" disabled={!canEdit} value={draft.agingDays ?? ""} placeholder="Off"
              onChange={(e) => setDraft({ ...draft, agingDays: e.target.value === "" ? null : Math.max(1, Math.min(365, Number(e.target.value))) })} />
          </Field>
        </div>
        <div className="space-y-2">
          <p className="text-[13px] font-semibold text-slate-800">Summaries</p>
          {toggle("dailySummary", "Daily summary", "After closing time.")}
          {toggle("weeklySummary", "Weekly summary", "Sunday, after closing time.")}
          {toggle("monthlySummary", "Monthly summary", "Last day of the month.")}
          {draft.usesStockPurchases && (
            <>
              <p className="pt-2 text-[13px] font-semibold text-slate-800">Stock purchases</p>
              {toggle("linkStockPurchases", "Received purchase orders create the supplier bill", "Avoids recording the same purchase twice. The bill starts unpaid.")}
            </>
          )}
        </div>
        <div className="space-y-2">
          <p className="text-[13px] font-semibold text-slate-800">WhatsApp</p>
          {!draft.whatsappReady && <Notice tone="warn">WhatsApp alerts are not set up on the server yet. Alerts are delivered in the app only.</Notice>}
          {toggle("whatsappEnabled", "Also send overdue alerts and summaries on WhatsApp")}
          <Field label="WhatsApp number" help="Empty: the number for the daily report, or the business phone.">
            <Input type="tel" disabled={!canEdit} value={draft.whatsappNumber ?? ""} onChange={(e) => setDraft({ ...draft, whatsappNumber: e.target.value || null })} />
          </Field>
        </div>
      </div>
    </Card>
  );
}

/** Small card for the restaurant dashboard (managers with supplier credit). */
export function SupplierCreditWidget({ className }: { className?: string }) {
  const p = useProduct();
  const s = useApi<Summary>(p.has("supplier_credit") && p.can("payables.view") ? "/dine/payables/summary" : null);
  if (!s.data) return null;
  const d = s.data;
  return (
    <Card className={className} title={<span className="inline-flex items-center gap-2"><HandCoins className="h-4 w-4" /> Supplier credit</span>}
      actions={<Link href={`${p.base}/supplier-credit`}><Button size="sm">Open</Button></Link>}>
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div><p className="text-slate-600">Owed to suppliers</p><p className="text-lg font-semibold tnum">{money(d.totalOutstanding)}</p></div>
        <div><p className="text-slate-600">Overdue</p><p className={cx("text-lg font-semibold tnum", d.overdueAmount > 0 && "text-red-700")}>{money(d.overdueAmount)}</p></div>
        <div><p className="text-slate-600">Paid this month</p><p className="text-lg font-semibold tnum">{money(d.paidThisMonth)}</p></div>
      </div>
    </Card>
  );
}
