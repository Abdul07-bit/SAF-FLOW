"use client";

import { useRef, useState } from "react";
import { BadgeCheck, Camera, Copy, Download, KeyRound, LogIn, LogOut, Pencil, Plus, Printer, ShieldAlert, UserPlus } from "lucide-react";
import { PRODUCTS, type ProductCode } from "@/config/catalog";
import { addDays, fmtDate, fmtDateTime, fmtTime, todayIST } from "@/lib/dates";
import { api, qs, useApi } from "@/lib/client";
import { f, humanize } from "@/shared/fields";
import { shifts } from "@/shared/resources";
import { KpiRow, StatTile } from "@/components/charts";
import { FormModal, ResourcePage } from "@/components/forms";
import { useProduct } from "@/components/product-context";
import { ScanInput } from "@/components/scanner";
import { Badge, Button, Card, DataTable, Empty, Field, Input, Loadable, Modal, Notice, PageHeader, Select, StatusBadge, Tabs, toast, toastError, useAction } from "@/components/ui";

const hours = (min: number) => (min ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m` : "-");

function CredentialsModal({ creds, onClose }: { creds: { username: string; temporaryPassword: string } | null; onClose: () => void }) {
  if (!creds) return null;
  const text = `SMARTAUTO FLEX login\nLogin ID: ${creds.username}\nTemporary password: ${creds.temporaryPassword}\nYou will be asked to set your own password at first sign-in.`;
  return (
    <Modal open onClose={onClose} title="Login details" size="sm" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <Notice tone="warn">This temporary password is shown only once. Share it privately with the staff member.</Notice>
      <dl className="mt-4 space-y-3">
        <div><dt className="text-xs text-slate-500">Login ID</dt><dd className="font-mono text-base font-semibold text-slate-900">{creds.username}</dd></div>
        <div><dt className="text-xs text-slate-500">Temporary password</dt><dd className="font-mono text-base font-semibold text-slate-900">{creds.temporaryPassword}</dd></div>
      </dl>
      <Button className="mt-4 w-full" onClick={() => navigator.clipboard.writeText(text).then(() => toast("Copied"))}><Copy className="h-4 w-4" /> Copy details</Button>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Staff logins
// ---------------------------------------------------------------------------

interface TeamData {
  items: any[];
  roles: { product: ProductCode; code: string; name: string; description: string }[];
  grantableProducts: ProductCode[];
  tenantCode: string;
}

export function TeamScreen() {
  const p = useProduct();
  const team = useApi<TeamData>(`${p.base}/team`);
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [creds, setCreds] = useState<{ username: string; temporaryPassword: string } | null>(null);
  const [, run] = useAction();

  return (
    <>
      <PageHeader
        title="Staff logins" description="Create login IDs for your team and choose what each person can do."
        actions={<Button variant="primary" onClick={() => setEditing(null)}><UserPlus className="h-4 w-4" /> Add staff login</Button>}
      />
      <Card pad={false}>
        <Loadable state={team}>
          {(d) => (
            <DataTable
              rows={d.items} rowKey={(r) => r.id}
              columns={[
                { key: "name", label: "Name", render: (r) => <><span className="font-medium">{r.fullName}</span>{r.isTenantOwner && <Badge tone="brand" className="ml-2">Owner</Badge>}</> },
                { key: "login", label: "Login ID", render: (r) => <span className="font-mono text-[13px]">{r.username}</span> },
                { key: "roles", label: "Access", render: (r) => <span className="flex flex-wrap gap-1">{r.access.map((a: any) => <Badge key={a.product} tone={a.product === p.code ? "brand" : "neutral"}>{PRODUCTS[a.product as ProductCode].shortName}: {a.roleName}</Badge>)}</span> },
                { key: "status", label: "Status", render: (r) => <StatusBadge value={r.isActive ? (r.lockedUntil && new Date(r.lockedUntil) > new Date() ? "SUSPENDED" : "ACTIVE") : "INACTIVE"} label={r.isActive ? (r.lockedUntil && new Date(r.lockedUntil) > new Date() ? "Locked" : r.mustChangePassword ? "Active - temp password" : "Active") : "Disabled"} /> },
                { key: "last", label: "Last sign-in", render: (r) => (r.lastLoginAt ? fmtDateTime(r.lastLoginAt) : "Never") },
                {
                  key: "act", label: "", align: "right",
                  render: (r) => (!r.isTenantOwner || p.user.isTenantOwner) && (
                    <span className="flex justify-end gap-1">
                      {r.id !== p.user.id && <Button size="sm" variant="ghost" onClick={() => setEditing(r)}><Pencil className="h-3.5 w-3.5" /> Roles</Button>}
                      <Button size="sm" variant="ghost" onClick={() => window.confirm(`Reset the password for ${r.username}? They will be signed out.`) && run(async () => setCreds(await api(`${p.base}/team/${r.id}/reset-password`, { method: "POST" })))}><KeyRound className="h-3.5 w-3.5" /> Reset</Button>
                      {r.id !== p.user.id && (
                        <Button size="sm" variant="ghost" onClick={() => run(async () => { await api(`${p.base}/team/${r.id}/status`, { body: { isActive: !r.isActive } }); await team.reload(); }, r.isActive ? "Account disabled" : "Account enabled")}>
                          {r.isActive ? "Disable" : "Enable"}
                        </Button>
                      )}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Loadable>
      </Card>
      {team.data && editing !== undefined && (
        <StaffModal data={team.data} member={editing} onClose={() => setEditing(undefined)} onSaved={(c) => { if (c) setCreds(c); void team.reload(); }} />
      )}
      <CredentialsModal creds={creds} onClose={() => setCreds(null)} />
    </>
  );
}

function StaffModal({ data, member, onClose, onSaved }: { data: TeamData; member: any | null; onClose: () => void; onSaved: (creds?: { username: string; temporaryPassword: string }) => void }) {
  const p = useProduct();
  const [fullName, setFullName] = useState(member?.fullName ?? "");
  const [handle, setHandle] = useState("");
  const [phone, setPhone] = useState(member?.phone ?? "");
  const initial = Object.fromEntries(data.grantableProducts.map((c) => [c, member?.access.find((a: any) => a.product === c)?.roleCode ?? ""]));
  const [roles, setRoles] = useState<Record<string, string>>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (member) {
        const access = data.grantableProducts.filter((c) => roles[c] !== initial[c]).map((c) => ({ product: c, roleCode: roles[c] || null }));
        await api(`${p.base}/team/${member.id}`, { method: "PATCH", body: { fullName, phone: phone || null, ...(access.length ? { access } : {}) } });
        toast("Staff member updated");
        onSaved();
      } else {
        const access = data.grantableProducts.filter((c) => roles[c]).map((c) => ({ product: c, roleCode: roles[c] }));
        if (!access.length) throw new Error("Choose a role for at least one application.");
        onSaved(await api(`${p.base}/team`, { body: { fullName, handle: handle.toLowerCase(), phone: phone || undefined, access } }));
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={member ? `Edit ${member.fullName}` : "Add staff login"}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name" required><Input required minLength={2} value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
          <Field label="Phone"><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          {!member && (
            <Field label="Login ID" required help="Lower-case letters, digits, dot, dash." className="sm:col-span-2">
              <div className="flex">
                <span className="flex h-10 items-center rounded-l-lg border border-r-0 border-slate-300 bg-slate-50 px-3 font-mono text-sm text-slate-600">{data.tenantCode}@</span>
                <Input required className="rounded-l-none font-mono" pattern="[a-zA-Z][a-zA-Z0-9._\-]{1,29}" placeholder="ravi" autoCapitalize="none" value={handle} onChange={(e) => setHandle(e.target.value)} />
              </div>
            </Field>
          )}
        </div>
        <fieldset>
          <legend className="text-[13px] font-medium text-slate-700">Access and role per application</legend>
          <div className="mt-2 space-y-2">
            {data.grantableProducts.map((c) => (
              <div key={c} className="grid items-center gap-2 sm:grid-cols-[10rem_1fr]">
                <span className="text-sm text-slate-800">{PRODUCTS[c].name}</span>
                <Select aria-label={`${PRODUCTS[c].name} role`} value={roles[c]} onChange={(e) => setRoles((s) => ({ ...s, [c]: e.target.value }))}>
                  <option value="">No access</option>
                  {data.roles.filter((r) => r.product === c && (r.code !== "manager" || p.user.isTenantOwner)).map((r) => <option key={r.code} value={r.code}>{r.name} - {r.description}</option>)}
                </Select>
              </div>
            ))}
          </div>
        </fieldset>
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>{member ? "Save" : "Create login"}</Button></div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Employee database
// ---------------------------------------------------------------------------

const EMPLOYEE_FIELDS = {
  fullName: f.text("Full name", { required: true, max: 100 }),
  designation: f.text("Designation", { required: true, max: 60, placeholder: "Cashier" }),
  department: f.text("Department", { max: 60 }),
  phone: f.phone("Phone"),
  email: f.email("Email"),
  bloodGroup: f.select("Blood group", ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"]),
  dateOfJoining: f.date("Date of joining"),
  emergencyContact: f.text("Emergency contact", { max: 100 }),
  userId: f.ref("Linked login", "/:product/staff/linkable-users", "username", { help: "Lets this person check in and out themselves." }),
  address: f.textarea("Address", { max: 300 }),
};

function Avatar({ url, name, size = 9 }: { url: string | null; name: string; size?: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="" className="shrink-0 rounded-full object-cover" style={{ height: size * 4, width: size * 4 }} /> : (
    <span className="flex shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand" style={{ height: size * 4, width: size * 4 }} aria-hidden>{name.slice(0, 2).toUpperCase()}</span>
  );
}

export function EmployeesScreen() {
  const p = useProduct();
  const [status, setStatus] = useState("ACTIVE");
  const [q, setQ] = useState("");
  const list = useApi<{ items: any[] }>(`${p.base}/staff/employees${qs({ status, q })}`);
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const file = useRef<HTMLInputElement>(null);
  const photoFor = useRef<string | null>(null);
  const [, run] = useAction();

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked || !photoFor.current) return;
    const form = new FormData();
    form.append("file", picked);
    await run(async () => { await api(`${p.base}/staff/employees/${photoFor.current}/photo`, { form }); await list.reload(); }, "Photo updated");
  };

  return (
    <>
      <PageHeader
        title="Employees" description="Employee records used for attendance, shifts and ID cards."
        actions={
          <>
            <Input aria-label="Search employees" placeholder="Search..." className="w-44" value={q} onChange={(e) => setQ(e.target.value)} />
            <Select aria-label="Status" className="w-32" value={status} onChange={(e) => setStatus(e.target.value)}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="ALL">All</option></Select>
            <Button variant="primary" onClick={() => setEditing(null)}><Plus className="h-4 w-4" /> Add employee</Button>
          </>
        }
      />
      <input ref={file} type="file" accept="image/png,image/jpeg" className="hidden" onChange={upload} />
      <Card pad={false}>
        <Loadable state={list}>
          {(d) => (
            <DataTable
              rows={d.items} rowKey={(r) => r.id}
              empty={<Empty title="No employees yet" hint="Add employee records to track attendance and print ID cards." />}
              columns={[
                { key: "emp", label: "Employee", render: (r) => <span className="flex items-center gap-2.5"><Avatar url={r.photoUrl} name={r.fullName} /><span><span className="block font-medium">{r.fullName}</span><span className="block text-xs text-slate-500">{r.employeeCode}</span></span></span> },
                { key: "des", label: "Designation", render: (r) => <>{r.designation}{r.department && <span className="text-slate-500"> - {r.department}</span>}</> },
                { key: "phone", label: "Phone", render: (r) => r.phone ?? "-" },
                { key: "login", label: "Login", render: (r) => (r.user ? <span className="font-mono text-[13px]">{r.user.username}</span> : <span className="text-slate-400">Not linked</span>) },
                { key: "card", label: "ID card", render: (r) => (r.idCards?.[0] ? <Badge tone="good">{r.idCards[0].cardNumber}</Badge> : <span className="text-slate-400">None</span>) },
                { key: "st", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
                {
                  key: "act", label: "", align: "right",
                  render: (r) => (
                    <span className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => { photoFor.current = r.id; file.current?.click(); }}><Camera className="h-3.5 w-3.5" /> Photo</Button>
                      <Button size="sm" variant="ghost" aria-label="Edit employee" onClick={() => setEditing(r)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => run(async () => { await api(`${p.base}/staff/employees/${r.id}/status`, { body: { status: r.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" } }); await list.reload(); })}>{r.status === "ACTIVE" ? "Deactivate" : "Activate"}</Button>
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Loadable>
      </Card>
      <FormModal
        open={editing !== undefined} title={editing ? "Edit employee" : "Add employee"} fields={EMPLOYEE_FIELDS} initial={editing} base={p.base} size="lg"
        hide={(k) => k === "userId" && !!editing?.userId}
        intro={editing?.user ? <Notice tone="info">Linked login: <span className="font-mono">{editing.user.username}</span></Notice> : undefined}
        onClose={() => setEditing(undefined)}
        onSubmit={async (v) => {
          if (editing) await api(`${p.base}/staff/employees/${editing.id}`, { method: "PATCH", body: v });
          else await api(`${p.base}/staff/employees`, { body: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null)) });
          toast("Employee saved");
          await list.reload();
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

const MARK_FIELDS = {
  status: f.select("Status", ["PRESENT", "LATE", "HALF_DAY", "ABSENT", "ON_LEAVE"], { required: true, default: "PRESENT" }),
  checkIn: f.time("Check-in time"),
  checkOut: f.time("Check-out time"),
  notes: f.text("Notes", { max: 200 }),
};
const toHHMM = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(11, 16) : "");

export function AttendanceScreen() {
  const p = useProduct();
  const [tab, setTab] = useState<"daily" | "monthly">("daily");
  return (
    <>
      <PageHeader title="Attendance" description="Daily check-in / check-out, late arrivals and working hours." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "daily", label: "Daily sheet" }, { key: "monthly", label: "Monthly report" }]} />
      {tab === "daily" ? <DailyAttendance /> : <MonthlyAttendance />}
      {!p.has("staff_checkin") && <p className="mt-3 text-xs text-slate-500">Self check-in is not enabled on your plan.</p>}
    </>
  );
}

function DailyAttendance() {
  const p = useProduct();
  const [date, setDate] = useState(todayIST());
  const sheet = useApi<{ rows: any[]; summary: Record<string, number> }>(`${p.base}/staff/attendance?date=${date}`, { refreshMs: 30_000 });
  const [marking, setMarking] = useState<any | null>(null);
  const [, run] = useAction();
  const canScan = p.has("qr_verification") && date === todayIST();

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="Date"><Input type="date" value={date} max={todayIST()} onChange={(e) => setDate(e.target.value || todayIST())} /></Field>
        {canScan && (
          <div className="min-w-64 flex-1">
            <p className="mb-1 text-[13px] font-medium text-slate-700">Scan staff ID card to check in / out</p>
            <ScanInput label="Scan staff ID card" placeholder="Scan the QR on the ID card" formats={["qr_code"]}
              onScan={(token) => run(async () => { const r = await api(`${p.base}/staff/attendance/qr`, { body: { token } }); toast(`${r.employee.fullName} checked ${r.action}`); await sheet.reload(); })} />
          </div>
        )}
      </div>
      <Loadable state={sheet}>
        {(d) => (
          <>
            <KpiRow cols={6}>
              <StatTile label="Staff" value={d.summary.total} />
              <StatTile label="Present" value={d.summary.present} />
              <StatTile label="Late" value={d.summary.late} tone={d.summary.late ? "warn" : undefined} />
              <StatTile label="Half day" value={d.summary.halfDay} />
              <StatTile label="Absent / leave" value={d.summary.absent + d.summary.onLeave} />
              <StatTile label="Not marked" value={d.summary.notMarked} />
            </KpiRow>
            <Card pad={false}>
              <DataTable
                rows={d.rows} rowKey={(r) => r.employee.id}
                empty={<Empty title="No active employees" hint="Add employees first." />}
                columns={[
                  { key: "emp", label: "Employee", render: (r) => <span className="flex items-center gap-2.5"><Avatar url={r.employee.photoUrl} name={r.employee.fullName} size={8} /><span><span className="block font-medium">{r.employee.fullName}</span><span className="block text-xs text-slate-500">{r.employee.designation}</span></span></span> },
                  { key: "shift", label: "Shift", render: (r) => (r.shift ? `${r.shift.name} (${r.shift.startTime}-${r.shift.endTime})` : "-") },
                  { key: "in", label: "Check-in", render: (r) => fmtTime(r.record?.checkInAt) },
                  { key: "out", label: "Check-out", render: (r) => fmtTime(r.record?.checkOutAt) },
                  { key: "worked", label: "Worked", align: "right", render: (r) => hours(r.record?.workedMinutes ?? 0) },
                  { key: "late", label: "Late by", align: "right", render: (r) => (r.record?.lateMinutes ? `${r.record.lateMinutes} min` : "-") },
                  { key: "st", label: "Status", render: (r) => (r.record ? <StatusBadge value={r.record.status} /> : <Badge>Not marked</Badge>) },
                  { key: "act", label: "", align: "right", render: (r) => <Button size="sm" variant="ghost" onClick={() => setMarking(r)}>Mark</Button> },
                ]}
              />
            </Card>
          </>
        )}
      </Loadable>
      <FormModal
        open={!!marking} title={`Attendance - ${marking?.employee.fullName ?? ""}`} fields={MARK_FIELDS}
        initial={marking ? { status: marking.record?.status ?? "PRESENT", checkIn: toHHMM(marking.record?.checkInAt ?? null), checkOut: toHHMM(marking.record?.checkOutAt ?? null), notes: marking.record?.notes } : null}
        onClose={() => setMarking(null)}
        onSubmit={async (v) => { await api(`${p.base}/staff/attendance/mark`, { body: { ...v, notes: v.notes ?? undefined, employeeId: marking.employee.id, date } }); toast("Attendance saved"); await sheet.reload(); }}
      />
    </>
  );
}

const DAY_CODE: Record<string, string> = { PRESENT: "P", LATE: "L", HALF_DAY: "H", ABSENT: "A", ON_LEAVE: "V" };

function MonthlyAttendance() {
  const p = useProduct();
  const [month, setMonth] = useState(todayIST().slice(0, 7));
  const report = useApi<{ dates: string[]; rows: any[] }>(`${p.base}/staff/attendance/report?month=${month}`);
  return (
    <>
      <div className="no-print mb-3 flex flex-wrap items-end gap-3">
        <Field label="Month"><Input type="month" value={month} max={todayIST().slice(0, 7)} onChange={(e) => setMonth(e.target.value || todayIST().slice(0, 7))} /></Field>
        <Button onClick={() => window.print()}><Printer className="h-4 w-4" /> Print report</Button>
      </div>
      <Loadable state={report}>
        {(d) => (
          <Card pad={false} title={`Attendance report - ${month}`} subtitle="P present, L late, H half day, A absent, V on leave">
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th scope="col" className="sticky left-0 bg-slate-50 px-3 py-2 font-medium">Employee</th>
                    {d.dates.map((x) => <th key={x} scope="col" className="w-6 px-0.5 py-2 text-center font-medium">{Number(x.slice(8))}</th>)}
                    {["P", "L", "H", "A", "V", "Late min", "Hours"].map((h) => <th key={h} scope="col" className="px-2 py-2 text-right font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {d.rows.map((r) => (
                    <tr key={r.employee.id}>
                      <th scope="row" className="sticky left-0 whitespace-nowrap bg-white px-3 py-1.5 text-left font-medium text-slate-800">{r.employee.fullName}</th>
                      {d.dates.map((x) => <td key={x} className="px-0.5 py-1.5 text-center text-slate-700" title={r.days[x] ? `${fmtDate(x)}: ${humanize(r.days[x])}` : undefined}>{DAY_CODE[r.days[x]] ?? ""}</td>)}
                      {[r.present, r.late, r.halfDay, r.absent, r.onLeave, r.lateMinutes, hours(r.workedMinutes)].map((v, i) => <td key={i} className="tnum px-2 py-1.5 text-right">{v}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!d.rows.length && <Empty title="No employees" />}
          </Card>
        )}
      </Loadable>
    </>
  );
}

export function MyAttendanceScreen() {
  const p = useProduct();
  const me = useApi<any>(`${p.base}/staff/attendance/me`);
  const [busy, run] = useAction();
  return (
    <>
      <PageHeader title="My attendance" description="Check in when you start work and check out when you leave." />
      <Loadable state={me}>
        {(d) =>
          !d.employee ? (
            <Notice tone="info" title="Your login is not linked to an employee record">Ask your manager to link your login in Employees so you can check in.</Notice>
          ) : (
            <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
              <Card title={fmtDate(todayIST())} subtitle={d.todayShift ? `Shift: ${d.todayShift.name}, ${d.todayShift.startTime} - ${d.todayShift.endTime}` : "No shift assigned today"}>
                <div className="space-y-3 text-center">
                  <p className="text-sm text-slate-600">{d.today?.checkInAt ? `Checked in at ${fmtTime(d.today.checkInAt)}` : "Not checked in yet"}{d.today?.checkOutAt ? `, out at ${fmtTime(d.today.checkOutAt)}` : ""}</p>
                  {d.today && <StatusBadge value={d.today.status} />}
                  {!d.today?.checkInAt && <Button variant="primary" size="lg" className="w-full" loading={busy} onClick={() => run(async () => { await api(`${p.base}/staff/attendance/check-in`, { method: "POST" }); await me.reload(); }, "Checked in")}><LogIn className="h-5 w-5" /> Check in</Button>}
                  {d.today?.checkInAt && !d.today.checkOutAt && <Button variant="primary" size="lg" className="w-full" loading={busy} onClick={() => run(async () => { await api(`${p.base}/staff/attendance/check-out`, { method: "POST" }); await me.reload(); }, "Checked out")}><LogOut className="h-5 w-5" /> Check out</Button>}
                  {d.today?.checkOutAt && <p className="text-sm font-medium text-emerald-800">Done for today - {hours(d.today.workedMinutes)} worked.</p>}
                </div>
                {d.upcoming.length > 0 && (
                  <div className="mt-4 border-t border-slate-100 pt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">This week</p>
                    <ul className="mt-1.5 space-y-1 text-sm">{d.upcoming.map((u: any) => <li key={u.date} className="flex justify-between"><span>{fmtDate(u.date)}</span><span className="text-slate-600">{u.shift.name} {u.shift.startTime}-{u.shift.endTime}</span></li>)}</ul>
                  </div>
                )}
              </Card>
              <Card title="Last 30 days" pad={false}>
                <DataTable
                  dense rows={d.history} rowKey={(r: any) => r.id} empty={<Empty title="No attendance recorded yet" />}
                  columns={[
                    { key: "d", label: "Date", render: (r: any) => fmtDate(r.date) },
                    { key: "in", label: "In", render: (r: any) => fmtTime(r.checkInAt) },
                    { key: "out", label: "Out", render: (r: any) => fmtTime(r.checkOutAt) },
                    { key: "w", label: "Worked", align: "right", render: (r: any) => hours(r.workedMinutes) },
                    { key: "s", label: "Status", render: (r: any) => <StatusBadge value={r.status} /> },
                  ]}
                />
              </Card>
            </div>
          )
        }
      </Loadable>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shifts & roster
// ---------------------------------------------------------------------------

export function ShiftsScreen() {
  const [tab, setTab] = useState<"roster" | "shifts">("roster");
  const [version, setVersion] = useState(0);
  return (
    <>
      <PageHeader title="Shifts & roster" description="Define shifts, then assign them day by day. Late arrivals are measured against the assigned shift." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "roster", label: "Weekly roster" }, { key: "shifts", label: "Shift definitions" }]} />
      {tab === "shifts" ? <ResourcePage def={shifts} embedded onChanged={() => setVersion((v) => v + 1)} /> : <Roster key={version} />}
    </>
  );
}

function Roster() {
  const p = useProduct();
  const [from, setFrom] = useState(todayIST());
  const roster = useApi<{ dates: string[]; employees: any[]; shifts: any[]; assignments: { employeeId: string; date: string; shiftId: string }[] }>(`${p.base}/staff/roster?from=${from}&days=7`);
  const assign = async (employeeId: string, date: string, shiftId: string) => {
    try {
      await api(`${p.base}/staff/roster`, { method: "PUT", body: { assignments: [{ employeeId, date, shiftId: shiftId || null }] } });
      await roster.reload();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Loadable state={roster}>
      {(d) => (
        <Card pad={false} title={`${fmtDate(d.dates[0])} - ${fmtDate(d.dates[d.dates.length - 1])}`}
          actions={<><Button size="sm" onClick={() => setFrom(addDays(from, -7))}>Previous week</Button><Button size="sm" onClick={() => setFrom(todayIST())}>This week</Button><Button size="sm" onClick={() => setFrom(addDays(from, 7))}>Next week</Button></>}>
          {!d.shifts.length ? <Empty title="No shifts defined" hint="Create a shift under Shift definitions first." /> : !d.employees.length ? <Empty title="No employees" hint="Add employees first." /> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-left text-sm">
                <thead><tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500"><th scope="col" className="px-3 py-2 font-medium">Employee</th>{d.dates.map((x) => <th key={x} scope="col" className="px-2 py-2 font-medium">{fmtDate(x).slice(0, 6)}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {d.employees.map((e) => (
                    <tr key={e.id}>
                      <th scope="row" className="whitespace-nowrap px-3 py-1.5 text-left font-medium">{e.fullName}<span className="block text-xs font-normal text-slate-500">{e.designation}</span></th>
                      {d.dates.map((x) => (
                        <td key={x} className="px-1 py-1.5">
                          <Select aria-label={`${e.fullName} ${fmtDate(x)}`} className="!h-8 min-w-24 !px-2 text-xs" value={d.assignments.find((a) => a.employeeId === e.id && a.date === x)?.shiftId ?? ""} onChange={(ev) => assign(e.id, x, ev.target.value)}>
                            <option value="">Off</option>
                            {d.shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </Select>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </Loadable>
  );
}

// ---------------------------------------------------------------------------
// ID cards & verification
// ---------------------------------------------------------------------------

export function IdCardsScreen() {
  const p = useProduct();
  const employees = useApi<{ items: any[] }>(`${p.base}/staff/employees?status=ACTIVE`);
  const cards = useApi<{ items: any[] }>(`${p.base}/staff/id-cards`);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [months, setMonths] = useState(12);
  const [busy, run] = useAction();
  const pdfUrl = (ids: string[]) => `/api${p.base}/staff/id-cards/pdf?cardIds=${ids.join(",")}`;
  const active = cards.data?.items.filter((c) => c.status === "ACTIVE") ?? [];
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const issue = () => run(async () => {
    await api(`${p.base}/staff/id-cards`, { body: { employeeIds: [...selected], validMonths: months } });
    setSelected(new Set());
    await Promise.all([cards.reload(), employees.reload()]);
  }, "ID cards issued");

  return (
    <>
      <PageHeader title="Staff ID cards" description="Printable ID cards with photo and a QR code for verification."
        actions={active.length > 0 ? <a href={pdfUrl(active.map((c) => c.id))} target="_blank" rel="noreferrer"><Button><Printer className="h-4 w-4" /> Print all active ({active.length})</Button></a> : undefined} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card pad={false} title="Issue cards" subtitle="Re-issuing replaces the old card: its QR code stops verifying."
          actions={<>
            <Select aria-label="Validity" className="!h-8 w-32 text-xs" value={months} onChange={(e) => setMonths(Number(e.target.value))}>{[6, 12, 24, 36].map((m) => <option key={m} value={m}>{m} months</option>)}</Select>
            <Button size="sm" variant="primary" disabled={!selected.size} loading={busy} onClick={issue}>Issue {selected.size || ""}</Button>
          </>}>
          <Loadable state={employees}>
            {(d) => (
              <DataTable dense rows={d.items} rowKey={(r) => r.id} empty={<Empty title="No active employees" hint="Add employees first." />}
                columns={[
                  { key: "sel", label: "", render: (r) => <input type="checkbox" aria-label={`Select ${r.fullName}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /> },
                  { key: "emp", label: "Employee", render: (r) => <span className="flex items-center gap-2"><Avatar url={r.photoUrl} name={r.fullName} size={7} /><span>{r.fullName}<span className="block text-xs text-slate-500">{r.designation}</span></span></span> },
                  { key: "photo", label: "Photo", render: (r) => (r.photoUrl ? "Yes" : <span className="text-amber-800">Missing</span>) },
                  { key: "card", label: "Current card", render: (r) => r.idCards?.[0]?.cardNumber ?? "-" },
                ]} />
            )}
          </Loadable>
        </Card>
        <Card pad={false} title="Issued cards">
          <Loadable state={cards}>
            {(d) => (
              <DataTable dense rows={d.items} rowKey={(r) => r.id} empty={<Empty title="No cards issued yet" />}
                columns={[
                  { key: "no", label: "Card no.", render: (r) => <span className="font-mono text-[13px]">{r.cardNumber}</span> },
                  { key: "emp", label: "Employee", render: (r) => r.employee.fullName },
                  { key: "valid", label: "Valid till", render: (r) => fmtDate(r.validUntil) },
                  { key: "st", label: "Status", render: (r) => <StatusBadge value={r.status === "ACTIVE" && new Date(r.validUntil) < new Date() ? "EXPIRED" : r.status} /> },
                  {
                    key: "act", label: "", align: "right",
                    render: (r) => r.status === "ACTIVE" && (
                      <span className="flex justify-end gap-1">
                        <a href={pdfUrl([r.id])} target="_blank" rel="noreferrer"><Button size="sm" variant="ghost"><Download className="h-3.5 w-3.5" /> PDF</Button></a>
                        <Button size="sm" variant="ghost" onClick={() => window.confirm("Revoke this ID card? Its QR code will stop verifying.") && run(async () => { await api(`${p.base}/staff/id-cards/${r.id}/revoke`, { method: "POST" }); await cards.reload(); }, "Card revoked")}>Revoke</Button>
                      </span>
                    ),
                  },
                ]} />
            )}
          </Loadable>
        </Card>
      </div>
    </>
  );
}

export function VerifyScreen() {
  const p = useProduct();
  const [result, setResult] = useState<any | null>(null);
  const [busy, run] = useAction();
  const verify = (raw: string) => run(async () => setResult(await api(`${p.base}/staff/verify/${encodeURIComponent(raw.split("/").pop() ?? raw)}`)));
  return (
    <>
      <PageHeader title="Verify staff ID" description="Scan the QR code on a staff ID card to confirm it is genuine and current." />
      <div className="mx-auto max-w-xl space-y-4">
        <Card><ScanInput label="Scan staff ID card" placeholder="Scan or paste the QR code" formats={["qr_code"]} autoFocus onScan={verify} /></Card>
        {busy && <p className="text-center text-sm text-slate-500">Checking...</p>}
        {result && (
          <Card>
            <div className="flex items-start gap-4">
              {result.valid ? <BadgeCheck className="h-10 w-10 shrink-0 text-emerald-700" aria-hidden /> : <ShieldAlert className="h-10 w-10 shrink-0 text-red-700" aria-hidden />}
              <div className="min-w-0 flex-1">
                <p className={`text-lg font-semibold ${result.valid ? "text-emerald-800" : "text-red-800"}`}>{result.valid ? "Valid staff ID" : "Not valid"}</p>
                {result.reason && <p className="text-sm text-slate-700">{result.reason}</p>}
                {result.employee && (
                  <div className="mt-3 flex items-center gap-3">
                    <Avatar url={result.employee.photoUrl} name={result.employee.fullName} size={16} />
                    <div className="text-sm">
                      <p className="font-semibold text-slate-900">{result.employee.fullName}</p>
                      <p className="text-slate-600">{result.employee.designation} - {result.employee.employeeCode}</p>
                      {result.card && <p className="text-slate-600">Card {result.card.cardNumber}, valid till {fmtDate(result.card.validUntil)}</p>}
                      <p className="text-slate-600">Today: {result.today?.checkInAt ? `in ${fmtTime(result.today.checkInAt)}${result.today.checkOutAt ? `, out ${fmtTime(result.today.checkOutAt)}` : ""}` : "not checked in"}</p>
                      {!result.worksInThisProduct && <p className="text-amber-800">Works in another department of this business.</p>}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
