"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pencil, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { fmtDate } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { api, errorMessage, get, qs, useApi } from "@/lib/client";
import { humanize, type FieldDef, type ResourceDef } from "@/shared/fields";
import { Badge, Button, Card, DataTable, Empty, Field, Input, Modal, Notice, PageHeader, Select, Spinner, StatusBadge, Textarea, toast, toastError, type Col } from "./ui";
import { useProduct } from "./product-context";

// ---------------------------------------------------------------------------
// Wire <-> form conversion (money is paise on the wire, rupees in the form)
// ---------------------------------------------------------------------------

type Values = Record<string, any>;

export function toDisplay(fields: Record<string, FieldDef>, row: Values | null | undefined): Values {
  const out: Values = {};
  for (const [k, fd] of Object.entries(fields)) {
    const v = row ? row[k] : fd.default;
    if (fd.type === "bool") out[k] = !!v;
    else if (v === null || v === undefined) out[k] = "";
    else if (fd.type === "money") out[k] = String(Number(v) / 100);
    else if (fd.type === "percent") out[k] = String(Number(v) / 100);
    else if (fd.type === "tags") out[k] = Array.isArray(v) ? v.join(", ") : String(v);
    else if (fd.type === "date") out[k] = String(v).slice(0, 10);
    else out[k] = String(v);
  }
  return out;
}

export function toWire(fields: Record<string, FieldDef>, values: Values, skip: (name: string, fd: FieldDef) => boolean = () => false): Values {
  const out: Values = {};
  for (const [k, fd] of Object.entries(fields)) {
    if (fd.readOnly || skip(k, fd)) continue;
    const v = values[k];
    if (fd.type === "bool") out[k] = !!v;
    else if (fd.type === "tags") out[k] = String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (v === "" || v === undefined || v === null) out[k] = fd.required ? "" : null;
    else if (fd.type === "money" || fd.type === "percent") out[k] = Math.round(Number(v) * 100);
    else if (fd.type === "int") out[k] = Math.round(Number(v));
    else if (fd.type === "number") out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

function RefSelect({ fd, value, onChange, base }: { fd: FieldDef; value: string; onChange: (v: string) => void; base: string }) {
  const { data } = useApi<{ items: any[] }>(`${fd.ref!.api.replace("/:product", base)}?pageSize=500`);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} required={fd.required}>
      <option value="">{data ? (fd.required ? "Select..." : "None") : "Loading..."}</option>
      {data?.items.map((o) => <option key={o.id} value={o.id}>{get(o, fd.ref!.label)}</option>)}
    </Select>
  );
}

export function FieldInput({ name, fd, value, onChange, base = "" }: { name: string; fd: FieldDef; value: any; onChange: (v: any) => void; base?: string }) {
  const common = { id: `f-${name}`, required: fd.required, placeholder: fd.placeholder };
  switch (fd.type) {
    case "bool":
      return (
        <label className="flex h-10 items-center gap-2 text-sm text-slate-800">
          <input type="checkbox" className="h-4 w-4 rounded border-slate-300 accent-[var(--brand)]" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {fd.label}
        </label>
      );
    case "textarea":
      return <Textarea {...common} value={value ?? ""} maxLength={fd.max} onChange={(e) => onChange(e.target.value)} />;
    case "select":
      return (
        <Select {...common} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
          {!fd.required && <option value="">None</option>}
          {fd.required && !value && <option value="">Select...</option>}
          {fd.options!.map((o) => <option key={o} value={o}>{humanize(o)}</option>)}
        </Select>
      );
    case "ref":
      return <RefSelect fd={fd} value={value ?? ""} onChange={onChange} base={base} />;
    case "money":
      return (
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-slate-500" aria-hidden>Rs</span>
          <Input {...common} className="pl-9" type="number" inputMode="decimal" min={0} step="0.01" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    case "percent":
      return <Input {...common} type="number" inputMode="decimal" min={0} max={100} step="0.01" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "int":
    case "number":
      return <Input {...common} type="number" inputMode={fd.type === "int" ? "numeric" : "decimal"} min={fd.min} max={fd.max} step={fd.type === "int" ? 1 : "any"} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "date":
      return <Input {...common} type="date" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "time":
      return <Input {...common} type="time" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "phone":
      return <Input {...common} type="tel" inputMode="tel" autoComplete="tel" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "email":
      return <Input {...common} type="email" autoComplete="email" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <Input {...common} type="text" maxLength={fd.max} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
  }
}

// ---------------------------------------------------------------------------
// Generic form modal
// ---------------------------------------------------------------------------

export function FormModal({ open, title, fields, initial, onSubmit, onClose, submitLabel = "Save", intro, base, hide, size = "md", danger }: {
  open: boolean;
  title: string;
  fields: Record<string, FieldDef>;
  /** Existing record (wire format) when editing. */
  initial?: Values | null;
  onSubmit: (values: Values) => Promise<unknown>;
  onClose: () => void;
  submitLabel?: string;
  intro?: ReactNode;
  base?: string;
  hide?: (name: string, fd: FieldDef) => boolean;
  size?: "sm" | "md" | "lg";
  danger?: boolean;
}) {
  const [values, setValues] = useState<Values>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = !!initial?.id;
  const hidden = (k: string, fd: FieldDef) => !!fd.readOnly || (editing && !!fd.createOnly) || !!hide?.(k, fd);

  useEffect(() => {
    if (open) {
      setValues(toDisplay(fields, initial));
      setError(null);
    }
    // Reset only when the modal opens: a parent that re-renders (polling)
    // must not wipe what the user is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(toWire(fields, values, hidden));
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const visible = Object.entries(fields).filter(([k, fd]) => !hidden(k, fd));
  return (
    <Modal open={open} title={title} onClose={onClose} size={size}>
      <form onSubmit={submit} className="space-y-4" noValidate={false}>
        {intro}
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          {visible.map(([k, fd]) =>
            fd.type === "bool" ? (
              <div key={k} className="self-end">
                <FieldInput name={k} fd={fd} value={values[k]} onChange={(v) => setValues((s) => ({ ...s, [k]: v }))} base={base} />
                {fd.help && <span className="block text-xs text-slate-500">{fd.help}</span>}
              </div>
            ) : (
              <Field key={k} label={fd.label} help={fd.help} required={fd.required} className={fd.type === "textarea" || visible.length === 1 ? "sm:col-span-2" : ""}>
                <FieldInput name={k} fd={fd} value={values[k]} onChange={(v) => setValues((s) => ({ ...s, [k]: v }))} base={base} />
              </Field>
            ),
          )}
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={danger ? "danger" : "primary"} loading={busy}>{submitLabel}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Table cells
// ---------------------------------------------------------------------------

export function renderCell(type: string | undefined, v: any): ReactNode {
  if (v === null || v === undefined || v === "") return <span className="text-slate-400">-</span>;
  switch (type) {
    case "money": return formatINR(v);
    case "percent": return `${v / 100}%`;
    case "bool": return v ? "Yes" : "No";
    case "status": return <StatusBadge value={String(v)} />;
    case "badge": return <Badge>{humanize(String(v))}</Badge>;
    case "date": return fmtDate(String(v).slice(0, 10));
    case "tags": return Array.isArray(v) ? v.join(", ") : String(v);
    case "number": return Number(v).toLocaleString("en-IN", { maximumFractionDigits: 3 });
    default: return String(v);
  }
}

const RIGHT = new Set(["money", "number", "percent"]);

// ---------------------------------------------------------------------------
// Generic CRUD screen driven by a ResourceDef
// ---------------------------------------------------------------------------

export function ResourcePage({ def, title, description, rowActions, headerActions, embedded, onChanged, transformSubmit }: {
  def: ResourceDef;
  title?: string;
  description?: ReactNode;
  rowActions?: (row: any, reload: () => void) => ReactNode;
  headerActions?: ReactNode;
  /** Render without the page header (inside a tab). */
  embedded?: boolean;
  onChanged?: () => void;
  transformSubmit?: (values: Values) => Values;
}) {
  const p = useProduct();
  const path = def.api.replace("/:product", p.base);
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Values | null | undefined>(undefined);
  const list = useApi<{ items: any[]; total: number }>(`${path}${qs({ q, all: showInactive ? 1 : undefined, pageSize: 300 })}`);
  const canWrite = p.has(def.write.feature) && p.can(def.write.permission);

  const reload = () => {
    void list.reload();
    onChanged?.();
  };

  const remove = async (row: any) => {
    const verb = def.softDelete ? "Deactivate" : "Delete";
    if (!window.confirm(`${verb} this ${def.singular.toLowerCase()}?`)) return;
    try {
      await api(`${path}/${row.id}`, { method: "DELETE" });
      toast(`${def.singular} ${def.softDelete ? "deactivated" : "deleted"}`);
      reload();
    } catch (e) {
      toastError(e);
    }
  };
  const restore = async (row: any) => {
    try {
      await api(`${path}/${row.id}/restore`, { method: "POST" });
      reload();
    } catch (e) {
      toastError(e);
    }
  };

  const columns = useMemo<Col<any>[]>(() => {
    const cols: Col<any>[] = def.columns
      .filter((c) => !c.feature || p.has(c.feature))
      .map((c) => ({
        key: c.key, label: c.label, align: RIGHT.has(c.type ?? "") ? "right" : "left",
        render: (r) => (
          <span className={r.isActive === false ? "text-slate-400 line-through" : ""}>{renderCell(c.type, get(r, c.key))}</span>
        ),
      }));
    if (canWrite || rowActions)
      cols.push({
        key: "_actions", label: "", align: "right",
        render: (r) => (
          <span className="flex justify-end gap-1">
            {rowActions?.(r, reload)}
            {canWrite && r.isActive !== false && (
              <>
                <Button size="sm" variant="ghost" aria-label={`Edit ${def.singular}`} onClick={() => setEditing(r)}><Pencil className="h-3.5 w-3.5" /></Button>
                {!(r.isMain) && <Button size="sm" variant="ghost" aria-label={`${def.softDelete ? "Deactivate" : "Delete"} ${def.singular}`} onClick={() => remove(r)}><Trash2 className="h-3.5 w-3.5 text-red-600" /></Button>}
              </>
            )}
            {canWrite && r.isActive === false && <Button size="sm" variant="ghost" onClick={() => restore(r)}><RotateCcw className="h-3.5 w-3.5" /> Restore</Button>}
          </span>
        ),
      });
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, canWrite, p.features]);

  const toolbar = (
    <>
      {def.search && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" aria-hidden />
          <Input aria-label={`Search ${def.title}`} placeholder="Search..." className="w-44 pl-8 sm:w-56" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      {def.softDelete && canWrite && (
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
        </label>
      )}
      {headerActions}
      {canWrite && <Button variant="primary" onClick={() => setEditing(null)}><Plus className="h-4 w-4" /> Add {def.singular.toLowerCase()}</Button>}
    </>
  );

  return (
    <>
      {!embedded && <PageHeader title={title ?? def.title} description={description ?? def.description} actions={toolbar} />}
      <Card pad={false} title={embedded ? (title ?? def.title) : undefined} subtitle={embedded ? (description ?? def.description) : undefined} actions={embedded ? toolbar : undefined}>
        {list.error && !list.data ? (
          <div className="p-4"><Notice tone="bad" title="Could not load">{list.error.message}</Notice></div>
        ) : !list.data ? (
          <Spinner />
        ) : (
          <DataTable
            columns={columns} rows={list.data.items} rowKey={(r) => r.id}
            empty={<Empty title={q ? "No matches" : `No ${def.title.toLowerCase()} yet`} hint={canWrite && !q ? `Add your first ${def.singular.toLowerCase()} to get started.` : undefined} />}
          />
        )}
      </Card>
      <FormModal
        open={editing !== undefined}
        title={`${editing ? "Edit" : "Add"} ${def.singular.toLowerCase()}`}
        fields={def.fields}
        initial={editing}
        base={p.base}
        hide={(_k, fd) => !!fd.feature && !p.has(fd.feature)}
        onClose={() => setEditing(undefined)}
        onSubmit={async (values) => {
          const body = transformSubmit ? transformSubmit(values) : values;
          if (editing) await api(`${path}/${editing.id}`, { method: "PATCH", body });
          else await api(path, { method: "POST", body });
          toast(`${def.singular} saved`);
          reload();
        }}
      />
    </>
  );
}

/** A locked Growth module: explains the upgrade path instead of a blank 403. */
export function UpgradeNotice({ feature }: { feature: string }) {
  const p = useProduct();
  return (
    <Card>
      <Empty
        title={`${feature} is part of ${p.product.shortName} Growth`}
        hint={`Your business is on the ${p.subscription?.planName ?? "Basic"} plan. Upgrade to unlock this module.`}
        action={p.can("subscription.view") ? <a className="text-sm font-medium text-brand underline" href={`${p.base}/subscription`}>Compare plans</a> : undefined}
      />
    </Card>
  );
}
