"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { api, useApi } from "@/lib/client";
import { f, humanize } from "@/shared/fields";
import { stayExpenses, stayGuests, stayRoomTypes, stayRooms } from "@/shared/resources";
import { BarList, ChartCard, ColumnChart, fmtCompactINR, KpiRow, StatTile } from "@/components/charts";
import { FormModal, ResourcePage } from "@/components/forms";
import { useProduct } from "@/components/product-context";
import { RangePicker, useRange } from "@/components/range";
import { Badge, Button, Card, DataTable, Empty, Loadable, PageHeader, Select, StatusBadge, Tabs, toast, useAction, cx } from "@/components/ui";

export const StayGuests = () => <ResourcePage def={stayGuests} title="Guests" description="Guest profiles with ID proof, stay preferences and company details." />;
export const StayExpenses = () => <ResourcePage def={stayExpenses} description="Day-to-day hotel expenses. They feed the revenue report." />;

export function StayRooms() {
  const p = useProduct();
  const [tab, setTab] = useState<"rooms" | "types">("rooms");
  const [, run] = useAction();
  return (
    <>
      <PageHeader title="Rooms & categories" description="Create room categories with rates first, then add the rooms." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "rooms", label: "Rooms" }, { key: "types", label: "Room categories" }]} />
      {tab === "types" ? <ResourcePage def={stayRoomTypes} embedded /> : (
        <ResourcePage def={stayRooms} embedded
          rowActions={(row, reload) => p.can("rooms.manage") && row.isActive !== false && row.status !== "OCCUPIED" && (
            <Button size="sm" variant="ghost" onClick={() => run(async () => { await api(`/stay/rooms/${row.id}/status`, { body: { status: row.status === "OUT_OF_ORDER" ? "AVAILABLE" : "OUT_OF_ORDER" } }); reload(); })}>
              {row.status === "OUT_OF_ORDER" ? "Back in service" : "Out of order"}
            </Button>
          )} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

const HK_TONE: Record<string, string> = { CLEAN: "border-emerald-300 bg-emerald-50", INSPECTED: "border-emerald-400 bg-emerald-50", IN_PROGRESS: "border-sky-300 bg-sky-50", DIRTY: "border-amber-400 bg-amber-50" };
const HK_NEXT: Record<string, { to: string; label: string }[]> = {
  DIRTY: [{ to: "IN_PROGRESS", label: "Start cleaning" }],
  IN_PROGRESS: [{ to: "CLEAN", label: "Mark clean" }],
  CLEAN: [{ to: "INSPECTED", label: "Inspected" }, { to: "DIRTY", label: "Mark dirty" }],
  INSPECTED: [{ to: "DIRTY", label: "Mark dirty" }],
};

export function StayHousekeeping() {
  const p = useProduct();
  const [tab, setTab] = useState<"board" | "tasks">("board");
  const tasksOn = p.has("housekeeping_tasks");
  return (
    <>
      <PageHeader title="Housekeeping" description="Room cleaning status. Rooms turn dirty automatically at check-out." />
      {tasksOn && <Tabs value={tab} onChange={setTab} tabs={[{ key: "board", label: "Room status" }, { key: "tasks", label: "Tasks" }]} />}
      {tab === "tasks" && tasksOn ? <HkTasks /> : <HkBoard />}
    </>
  );
}

function HkBoard() {
  const p = useProduct();
  const board = useApi<{ rooms: any[] }>("/stay/housekeeping", { refreshMs: 15_000 });
  const [, run] = useAction();
  const canUpdate = p.can("housekeeping.update");
  const canInspect = p.can("housekeeping.assign") || p.can("dashboard.view");
  return (
    <Loadable state={board}>
      {(d) => !d.rooms.length ? <Card><Empty title="No rooms set up" /></Card> : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {d.rooms.map((r) => (
            <li key={r.id} className={cx("rounded-xl border-2 p-3", HK_TONE[r.hkStatus])}>
              <div className="flex items-baseline justify-between"><span className="text-lg font-semibold text-slate-900">{r.number}</span><span className="text-xs text-slate-600">{r.floor ? `Floor ${r.floor}` : ""}</span></div>
              <p className="truncate text-xs text-slate-600">{r.type}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <StatusBadge value={r.hkStatus} label={r.hkStatus === "IN_PROGRESS" ? "Being cleaned" : undefined} />
                {r.status === "OCCUPIED" && <Badge tone="info">Occupied</Badge>}
                {r.status === "OUT_OF_ORDER" && <Badge tone="bad">Out of order</Badge>}
                {r.departureToday && <Badge tone="warn">Departure</Badge>}
              </div>
              {r.tasks.map((t: any) => <p key={t.id} className="mt-1 text-xs text-slate-700">{humanize(t.type)}{t.assignee ? ` - ${t.assignee}` : " - unassigned"}</p>)}
              {canUpdate && (
                <div className="mt-2 flex flex-col gap-1">
                  {HK_NEXT[r.hkStatus].filter((n) => n.to !== "INSPECTED" || canInspect).map((n) => (
                    <Button key={n.to} size="sm" variant={n.to === "DIRTY" ? "ghost" : "primary"} onClick={() => run(async () => { await api(`/stay/rooms/${r.id}/hk-status`, { body: { hkStatus: n.to } }); await board.reload(); })}>{n.label}</Button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Loadable>
  );
}

function HkTasks() {
  const p = useProduct();
  const tasks = useApi<{ items: any[]; staff: any[] }>("/stay/hk-tasks", { refreshMs: 20_000 });
  const [creating, setCreating] = useState(false);
  const [busy, run] = useAction();
  const canAssign = p.can("housekeeping.assign");
  const setStatus = (id: string, body: object, msg?: string) => run(async () => { await api(`/stay/hk-tasks/${id}/status`, { body }); await tasks.reload(); }, msg);
  return (
    <>
      <Card pad={false} title={canAssign ? "Open tasks" : "My tasks"} subtitle={canAssign ? undefined : "Your tasks and unassigned ones you can pick up"} actions={canAssign ? <Button size="sm" variant="primary" onClick={() => setCreating(true)}><Plus className="h-3.5 w-3.5" /> Assign task</Button> : undefined}>
        <Loadable state={tasks}>
          {(d) => (
            <DataTable rows={d.items} rowKey={(r) => r.id} empty={<Empty title="No open tasks" hint="A cleaning task is created automatically when a guest checks out." />}
              columns={[
                { key: "r", label: "Room", render: (r) => <span className="font-semibold">{r.room.number}</span> },
                { key: "t", label: "Task", render: (r) => <>{humanize(r.type)}{r.notes && <span className="block text-xs text-slate-500">{r.notes}</span>}</> },
                { key: "p", label: "Priority", render: (r) => <StatusBadge value={r.priority} /> },
                {
                  key: "a", label: "Assigned to",
                  render: (r) => canAssign ? (
                    <Select aria-label="Assign to" className="!h-8 w-40 text-xs" value={r.assignedTo?.id ?? ""} onChange={(e) => setStatus(r.id, { assignedToId: e.target.value || null }, "Task assigned")}>
                      <option value="">Unassigned</option>
                      {d.staff.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
                    </Select>
                  ) : r.assignedTo?.fullName ?? "Unassigned",
                },
                { key: "s", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
                { key: "c", label: "Created", render: (r) => fmtDateTime(r.createdAt) },
                {
                  key: "x", label: "", align: "right",
                  render: (r) => (
                    <span className="flex justify-end gap-1">
                      {r.status === "PENDING" && <Button size="sm" loading={busy} onClick={() => setStatus(r.id, { status: "IN_PROGRESS" }, "Task started")}>Start</Button>}
                      <Button size="sm" variant="primary" loading={busy} onClick={() => setStatus(r.id, { status: "DONE" }, "Task completed")}>Done</Button>
                      {canAssign && <Button size="sm" variant="ghost" onClick={() => setStatus(r.id, { status: "CANCELLED" })}>Cancel</Button>}
                    </span>
                  ),
                },
              ]} />
          )}
        </Loadable>
      </Card>
      <FormModal open={creating} title="Assign housekeeping task" onClose={() => setCreating(false)} base={p.base}
        fields={{
          roomId: f.ref("Room", "/stay/rooms", "number", { required: true }),
          type: f.select("Task", ["CLEANING", "CHECKOUT_CLEAN", "INSPECTION", "TURNDOWN", "DEEP_CLEAN", "LINEN_CHANGE"], { required: true, default: "CLEANING" }),
          priority: f.select("Priority", ["LOW", "NORMAL", "HIGH", "URGENT"], { required: true, default: "NORMAL" }),
          notes: f.textarea("Notes", { max: 300 }),
        }}
        onSubmit={async (v) => { await api("/stay/hk-tasks", { body: { roomId: v.roomId, type: v.type, priority: v.priority, notes: v.notes ?? undefined } }); toast("Task created - assign it from the list"); await tasks.reload(); }} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export function StayMaintenance() {
  const p = useProduct();
  const [status, setStatus] = useState("ACTIVE");
  const list = useApi<{ items: any[]; staff: any[] }>(`/stay/maintenance?status=${status}`);
  const [creating, setCreating] = useState(false);
  const [resolving, setResolving] = useState<any | null>(null);
  const [busy, run] = useAction();
  const canWork = p.can(["maintenance.update", "maintenance.manage"]);
  const canManage = p.can("maintenance.manage");
  const patch = (id: string, body: object, msg?: string) => run(async () => { await api(`/stay/maintenance/${id}`, { method: "PATCH", body }); await list.reload(); }, msg);
  return (
    <>
      <PageHeader title="Maintenance" description="Report and track repairs. A room marked out of order cannot be sold until the job is resolved."
        actions={<>
          <Select aria-label="Show" className="w-36" value={status} onChange={(e) => setStatus(e.target.value)}><option value="ACTIVE">Open jobs</option><option value="RESOLVED">Resolved</option><option value="ALL">All</option></Select>
          {p.can("maintenance.report") && <Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Report issue</Button>}
        </>} />
      <Card pad={false}>
        <Loadable state={list}>
          {(d) => (
            <DataTable rows={d.items} rowKey={(r) => r.id} empty={<Empty title="No maintenance jobs" />}
              columns={[
                { key: "t", label: "Issue", render: (r) => <span className="block max-w-xs whitespace-normal"><span className="font-medium">{r.title}</span>{r.description && <span className="block text-xs text-slate-500">{r.description}</span>}{r.resolution && <span className="block text-xs text-emerald-800">Fix: {r.resolution}</span>}</span> },
                { key: "r", label: "Room", render: (r) => (r.room ? <>{r.room.number}{r.roomOutOfOrder && <Badge tone="bad" className="ml-1.5">Out of order</Badge>}</> : "General") },
                { key: "p", label: "Priority", render: (r) => <StatusBadge value={r.priority} /> },
                {
                  key: "a", label: "Assigned to",
                  render: (r) => canManage && (r.status === "OPEN" || r.status === "IN_PROGRESS") ? (
                    <Select aria-label="Assign to" className="!h-8 w-40 text-xs" value={r.assignedTo?.id ?? ""} onChange={(e) => patch(r.id, { assignedToId: e.target.value || null })}>
                      <option value="">Unassigned</option>
                      {d.staff.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
                    </Select>
                  ) : r.assignedTo?.fullName ?? "Unassigned",
                },
                { key: "s", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
                { key: "c", label: "Reported", render: (r) => fmtDateTime(r.createdAt) },
                { key: "cost", label: "Cost", align: "right", render: (r) => (r.cost ? formatINR(r.cost) : "-") },
                {
                  key: "x", label: "", align: "right",
                  render: (r) => canWork && (r.status === "OPEN" || r.status === "IN_PROGRESS") && (
                    <span className="flex justify-end gap-1">
                      {r.status === "OPEN" && <Button size="sm" loading={busy} onClick={() => patch(r.id, { status: "IN_PROGRESS" }, "Job started")}>Start</Button>}
                      <Button size="sm" variant="primary" onClick={() => setResolving(r)}>Resolve</Button>
                    </span>
                  ),
                },
              ]} />
          )}
        </Loadable>
      </Card>
      <FormModal open={creating} title="Report a maintenance issue" onClose={() => setCreating(false)} base={p.base}
        fields={{
          title: f.text("What is wrong?", { required: true, max: 120, placeholder: "AC not cooling" }),
          roomId: f.ref("Room", "/stay/rooms", "number", { help: "Leave empty for common areas." }),
          priority: f.select("Priority", ["LOW", "NORMAL", "HIGH", "URGENT"], { required: true, default: "NORMAL" }),
          roomOutOfOrder: f.bool("Take the room out of order until fixed"),
          description: f.textarea("Details", { max: 1000 }),
        }}
        onSubmit={async (v) => { await api("/stay/maintenance", { body: { ...v, description: v.description ?? undefined } }); toast("Issue reported"); await list.reload(); }} />
      <FormModal open={!!resolving} title={`Resolve - ${resolving?.title ?? ""}`} submitLabel="Mark resolved" onClose={() => setResolving(null)}
        fields={{ resolution: f.textarea("What was done", { required: true, max: 1000 }), cost: f.money("Cost") }}
        onSubmit={async (v) => { await api(`/stay/maintenance/${resolving.id}`, { method: "PATCH", body: { status: "RESOLVED", resolution: v.resolution, cost: v.cost ?? 0 } }); toast("Job resolved"); await list.reload(); }} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function StayReports() {
  const range = useRange("30d");
  const r = useApi<any>(`/stay/reports/occupancy?${range.query}`);
  return (
    <>
      <PageHeader title="Occupancy report" description="Rooms sold each night, arrivals and departures." />
      <RangePicker state={range} print />
      <Loadable state={r}>
        {(d) => (
          <div className={r.refreshing ? "opacity-60" : ""}>
            <KpiRow cols={4}>
              <StatTile label="Average occupancy" value={`${d.summary.avgOccupancyPct}%`} />
              <StatTile label="Room nights sold" value={d.summary.roomNightsSold} />
              <StatTile label="Room nights available" value={d.summary.capacity} />
              <StatTile label="Guests" value={d.summary.guests} />
            </KpiRow>
            <ChartCard title="Occupancy by night" subtitle="Percent of rooms sold" table={{ columns: ["Date", "Rooms sold", "Occupancy", "Arrivals", "Departures"], rows: d.days.map((x: any) => [fmtDate(x.date), `${x.occupied} / ${x.rooms}`, `${x.occupancyPct}%`, x.arrivals, x.departures]) }}>
              <ColumnChart data={d.days.map((x: any) => ({ label: fmtDate(x.date).slice(0, 6), value: x.occupancyPct }))} format={(n) => `${n}%`} emptyText="No rooms sold in this period" />
            </ChartCard>
          </div>
        )}
      </Loadable>
    </>
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function StayAnalytics() {
  const range = useRange("30d");
  const a = useApi<any>(`/stay/analytics?${range.query}`);
  return (
    <>
      <PageHeader title="Occupancy analytics" description="Rate, yield and booking behaviour for the selected period." />
      <RangePicker state={range} print />
      <Loadable state={a}>
        {(d) => (
          <div className={a.refreshing ? "opacity-60" : ""}>
            <KpiRow cols={5}>
              <StatTile label="Occupancy" value={`${d.kpis.occupancyPct}%`} />
              <StatTile label="Average daily rate (ADR)" value={formatINR(d.kpis.adr, { whole: true })} />
              <StatTile label="Revenue per available room" value={formatINR(d.kpis.revpar, { whole: true })} sub="RevPAR" />
              <StatTile label="Room revenue" value={formatINR(d.kpis.roomRevenue, { whole: true })} sub={`${d.kpis.roomNightsSold} room nights`} />
              <StatTile label="Average length of stay" value={`${d.kpis.avgLengthOfStay} nights`} />
              <StatTile label="Booking lead time" value={`${d.kpis.avgLeadTimeDays} days`} />
              <StatTile label="Cancellations" value={`${d.kpis.cancellationPct}%`} />
              <StatTile label="No-shows" value={`${d.kpis.noShowPct}%`} />
              <StatTile label="Repeat guests" value={`${d.kpis.repeatGuestPct}%`} />
            </KpiRow>
            <div className="grid gap-4 xl:grid-cols-3">
              <ChartCard title="Occupancy by weekday" table={{ columns: ["Day", "Sold", "Available", "Occupancy"], rows: d.byWeekday.map((x: any) => [WEEKDAYS[x.day], x.sold, x.capacity, `${x.occupancyPct}%`]) }}>
                <ColumnChart data={d.byWeekday.map((x: any) => ({ label: WEEKDAYS[x.day], value: x.occupancyPct }))} format={(n) => `${n}%`} />
              </ChartCard>
              <ChartCard title="Room revenue by category" table={{ columns: ["Category", "Nights", "Revenue"], rows: d.byRoomType.map((x: any) => [x.name, x.nights, formatINR(x.revenue)]) }}>
                <BarList data={d.byRoomType.map((x: any) => ({ label: x.name, value: x.revenue, sub: `${x.nights} nights` }))} format={(n) => formatINR(n, { whole: true })} />
              </ChartCard>
              <ChartCard title="Booking sources" subtitle="Reservations" table={{ columns: ["Source", "Reservations"], rows: d.sources.map((x: any) => [humanize(x.source), x.count]) }}>
                <BarList data={d.sources.map((x: any) => ({ label: humanize(x.source), value: x.count }))} format={(n) => `${n}`} />
              </ChartCard>
            </div>
          </div>
        )}
      </Loadable>
    </>
  );
}

export function StayRevenue() {
  const range = useRange("30d");
  const r = useApi<any>(`/stay/reports/revenue?${range.query}`);
  return (
    <>
      <PageHeader title="Revenue report" description="Charges posted, money collected and expenses." />
      <RangePicker state={range} print />
      <Loadable state={r}>
        {(d) => (
          <div className={r.refreshing ? "opacity-60" : ""}>
            <KpiRow cols={5}>
              <StatTile label="Revenue (before GST)" value={formatINR(d.totals.revenue, { whole: true })} />
              <StatTile label="GST charged" value={formatINR(d.totals.tax, { whole: true })} />
              <StatTile label="Collected" value={formatINR(d.totals.collected, { whole: true })} />
              <StatTile label="Expenses" value={formatINR(d.totals.expenses, { whole: true })} />
              <StatTile label="Revenue less expenses" value={formatINR(d.totals.netOperating, { whole: true })} tone={d.totals.netOperating < 0 ? "bad" : undefined} />
            </KpiRow>
            <div className="grid gap-4 xl:grid-cols-3">
              <ChartCard className="xl:col-span-3" title="Daily revenue" subtitle="Charges posted, before GST" table={{ columns: ["Date", "Revenue", "Collected", "Expenses"], rows: d.daily.map((x: any) => [fmtDate(x.date), formatINR(x.revenue), formatINR(x.collected), formatINR(x.expenses)]) }}>
                <ColumnChart data={d.daily.map((x: any) => ({ label: fmtDate(x.date).slice(0, 6), value: x.revenue }))} format={(n) => formatINR(n, { whole: true })} axisFormat={fmtCompactINR} />
              </ChartCard>
              <ChartCard title="Revenue by charge type" table={{ columns: ["Type", "Revenue"], rows: d.byChargeType.map((x: any) => [humanize(x.type), formatINR(x.amount)]) }}>
                <BarList data={d.byChargeType.map((x: any) => ({ label: humanize(x.type), value: x.amount }))} format={(n) => formatINR(n, { whole: true })} />
              </ChartCard>
              <ChartCard title="Collections by method" table={{ columns: ["Method", "Amount"], rows: d.byMethod.map((x: any) => [humanize(x.method), formatINR(x.amount)]) }}>
                <BarList data={d.byMethod.map((x: any) => ({ label: humanize(x.method), value: x.amount }))} format={(n) => formatINR(n, { whole: true })} />
              </ChartCard>
              <ChartCard title="Expenses by category" table={{ columns: ["Category", "Amount"], rows: d.expensesByCategory.map((x: any) => [humanize(x.category), formatINR(x.amount)]) }}>
                <BarList data={d.expensesByCategory.map((x: any) => ({ label: humanize(x.category), value: x.amount }))} format={(n) => formatINR(n, { whole: true })} emptyText="No expenses recorded" />
              </ChartCard>
            </div>
          </div>
        )}
      </Loadable>
    </>
  );
}

export function StayOperations() {
  const range = useRange("30d");
  const r = useApi<any>(`/stay/reports/operations?${range.query}`);
  return (
    <>
      <PageHeader title="Operations report" description="Housekeeping turnaround, maintenance and reservation outcomes." />
      <RangePicker state={range} print />
      <Loadable state={r}>
        {(d) => (
          <div className={r.refreshing ? "opacity-60" : ""}>
            <h2 className="mb-2 text-sm font-semibold text-slate-900">Housekeeping</h2>
            <KpiRow cols={4}>
              <StatTile label="Tasks created" value={d.housekeeping.created} />
              <StatTile label="Completed" value={d.housekeeping.completed} />
              <StatTile label="Still open" value={d.housekeeping.open} tone={d.housekeeping.open ? "warn" : undefined} />
              <StatTile label="Average turnaround" value={d.housekeeping.avgTurnaroundMinutes === null ? "-" : `${d.housekeeping.avgTurnaroundMinutes} min`} sub="created to completed" />
            </KpiRow>
            <h2 className="mb-2 text-sm font-semibold text-slate-900">Maintenance</h2>
            <KpiRow cols={5}>
              <StatTile label="Issues reported" value={d.maintenance.reported} />
              <StatTile label="Resolved" value={d.maintenance.resolved} />
              <StatTile label="Open" value={d.maintenance.open} tone={d.maintenance.open ? "warn" : undefined} />
              <StatTile label="Average time to resolve" value={d.maintenance.avgResolutionHours === null ? "-" : `${d.maintenance.avgResolutionHours} h`} />
              <StatTile label="Repair cost" value={formatINR(d.maintenance.totalCost, { whole: true })} />
            </KpiRow>
            <div className="grid gap-4 xl:grid-cols-2">
              <Card pad={false} title="Housekeeping by staff member">
                <DataTable dense rows={d.housekeeping.byStaff} rowKey={(x: any) => x.name} empty={<Empty title="No completed tasks in this period" />}
                  columns={[{ key: "n", label: "Staff", render: (x: any) => x.name }, { key: "d", label: "Tasks done", align: "right", render: (x: any) => x.done }, { key: "a", label: "Average time", align: "right", render: (x: any) => `${x.avgMinutes} min` }]} />
              </Card>
              <Card title="Reservations by outcome" subtitle="Arrivals in this period">
                {!Object.keys(d.reservations).length ? <p className="py-6 text-center text-sm text-slate-500">No reservations in this period</p> : (
                  <ul className="space-y-2 text-sm">{Object.entries(d.reservations).map(([k, v]) => <li key={k} className="flex items-center justify-between"><StatusBadge value={k} /><span className="tnum font-semibold">{String(v)}</span></li>)}</ul>
                )}
              </Card>
            </div>
          </div>
        )}
      </Loadable>
    </>
  );
}
