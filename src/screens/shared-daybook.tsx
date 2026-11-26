"use client";

/**
 * Day book (every product) and the Expenses screen for Dine and Bill.
 * The day book shows sales, the number of orders / bills and the expenses for
 * each business day of any date range, with a PDF download. On the Growth
 * plan the same report goes to the owner's WhatsApp when the shop closes.
 */
import { useState } from "react";
import { BookOpen, Download, MessageCircle, Send } from "lucide-react";
import { formatDailyNo } from "@/lib/business-day";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { api, qs, useApi } from "@/lib/client";
import { humanize } from "@/shared/fields";
import { billExpenses, dineExpenses, stayExpenses } from "@/shared/resources";
import { BarList, ChartCard, fmtCompactINR, KpiRow, Legend, SERIES_COLORS, StackedColumnChart, StatTile } from "@/components/charts";
import { ResourcePage } from "@/components/forms";
import { useProduct } from "@/components/product-context";
import { RangePicker, useRange } from "@/components/range";
import { Badge, Button, Card, DataTable, Empty, Loadable, Notice, PageHeader, Select, StatusBadge, useAction } from "@/components/ui";

const EXPENSES = { dine: dineExpenses, bill: billExpenses, stay: stayExpenses } as const;

export function ExpensesScreen() {
  const p = useProduct();
  const hours = `${p.settings.openingTime ?? "09:00"} - ${p.settings.closingTime ?? "23:00"}`;
  return (
    <ResourcePage
      def={EXPENSES[p.code]}
      description={`Everything the shop spends day to day: gas, vegetables, salaries, rent... Left without a date, an expense goes on the current business day (shop hours ${hours}).`}
      headerActions={p.has("day_book") && p.can("dashboard.view") ? <a href={`${p.base}/day-book`}><Button><BookOpen className="h-4 w-4" /> Day book</Button></a> : undefined}
    />
  );
}

interface Book {
  from: string; to: string; today: string; allBranches: boolean;
  hours: { openingTime: string; closingTime: string };
  countLabel: string;
  totals: { count: number; sales: number; expenses: number; net: number; avgTicket: number; cancelled: number; discount: number; tax: number };
  daily: { date: string; count: number; sales: number; expenses: number; net: number }[];
  byMethod: { method: string; amount: number }[];
  expensesByCategory: { category: string; amount: number }[];
  expenses: { id: string; date: string; category: string; description: string; amount: number; method: string; paidTo: string | null }[];
  topItems: { name: string; qty: number; revenue: number }[];
  branches: { id: string; name: string; count: number; sales: number; expenses: number }[];
}

const money = (n: number) => formatINR(n, { whole: true });

export function DayBookScreen() {
  const p = useProduct();
  const range = useRange("today", p.settings);
  const canAll = p.branches.length > 1;
  const [scope, setScope] = useState<"branch" | "all">("branch");
  const query = `${range.query}${scope === "all" ? "&all=1" : ""}`;
  const book = useApi<Book>(`${p.base}/day-book?${query}`);
  const pdfHref = `/api${p.base}/day-book/pdf${qs({ from: range.range.from, to: range.range.to, all: scope === "all" ? 1 : undefined, branch: scope === "all" ? undefined : p.branchId })}`;
  const sold = p.code === "stay" ? "Payments received" : "Sales";

  return (
    <>
      <PageHeader
        title="Day book"
        description={<>Sales, {p.code === "stay" ? "check-ins" : p.code === "dine" ? "orders" : "bills"} and expenses for each business day. The shop opens at <strong>{p.settings.openingTime ?? "09:00"}</strong> and closes at <strong>{p.settings.closingTime ?? "23:00"}</strong>{p.can("settings.manage") ? " (change it in Settings)" : ""}; anything before closing time after midnight counts for the day before.</>}
      />
      <RangePicker state={range}>
        {canAll && (
          <Select aria-label="Branches" className="w-40" value={scope} onChange={(e) => setScope(e.target.value as "branch" | "all")}>
            <option value="branch">This branch</option>
            <option value="all">All branches</option>
          </Select>
        )}
        <a href={pdfHref}><Button><Download className="h-4 w-4" /> Download PDF</Button></a>
      </RangePicker>
      <Loadable state={book}>
        {(d) => (
          <div className={book.refreshing ? "space-y-4 opacity-60" : "space-y-4"}>
            <KpiRow cols={5}>
              <StatTile label={sold} value={money(d.totals.sales)} sub={p.code === "stay" ? "money received" : "incl. GST"} />
              <StatTile label={d.countLabel} value={d.totals.count} sub={d.from === d.to ? fmtDate(d.from) : `${d.daily.length} days`} />
              <StatTile label="Expenses" value={money(d.totals.expenses)} />
              <StatTile label={`${sold} less expenses`} value={money(d.totals.net)} tone={d.totals.net < 0 ? "bad" : undefined} />
              {p.code === "stay"
                ? <StatTile label="Cancellations" value={d.totals.cancelled} />
                : <StatTile label={`Average ${p.code === "dine" ? "order" : "bill"}`} value={money(d.totals.avgTicket)} sub={d.totals.cancelled ? `${d.totals.cancelled} ${p.code === "dine" ? "cancelled" : "voided"}` : undefined} />}
            </KpiRow>

            <ChartCard
              title="Day by day"
              subtitle={`${sold} and expenses per business day`}
              legend={<Legend items={[{ label: sold, color: SERIES_COLORS[0] }, { label: "Expenses", color: SERIES_COLORS[1] }]} />}
              table={{
                columns: ["Date", d.countLabel, sold, "Expenses", "Net"],
                rows: d.daily.map((x) => [fmtDate(x.date), x.count, formatINR(x.sales), formatINR(x.expenses), formatINR(x.net)]),
              }}
            >
              <StackedColumnChart
                data={d.daily.map((x) => ({ label: fmtDate(x.date).slice(0, 6), values: { sales: x.sales, expenses: x.expenses } }))}
                series={[{ key: "sales", label: sold, color: SERIES_COLORS[0] }, { key: "expenses", label: "Expenses", color: SERIES_COLORS[1] }]}
                format={money} axisFormat={fmtCompactINR}
              />
            </ChartCard>

            <Card pad={false} title="Daily totals">
              <DataTable
                dense rowKey={(r) => r.date}
                rows={[...d.daily].reverse()}
                empty={<Empty title="No days in this range" />}
                columns={[
                  { key: "date", label: "Business day", render: (r) => fmtDate(r.date) },
                  { key: "count", label: d.countLabel, render: (r) => <span className="tnum">{r.count}</span> },
                  { key: "sales", label: sold, render: (r) => <span className="tnum">{formatINR(r.sales)}</span> },
                  { key: "expenses", label: "Expenses", render: (r) => <span className="tnum">{formatINR(r.expenses)}</span> },
                  { key: "net", label: "Net", render: (r) => <span className={r.net < 0 ? "tnum font-medium text-red-700" : "tnum font-medium"}>{formatINR(r.net)}</span> },
                ]}
              />
            </Card>

            <div className="grid gap-4 xl:grid-cols-2">
              <ChartCard title="Payments by method" table={{ columns: ["Method", "Amount"], rows: d.byMethod.map((m) => [humanize(m.method), formatINR(m.amount)]) }}>
                <BarList data={d.byMethod.map((m) => ({ label: humanize(m.method), value: m.amount }))} format={money} emptyText="No sales in this period" />
              </ChartCard>
              <ChartCard title="Expenses by category" table={{ columns: ["Category", "Amount"], rows: d.expensesByCategory.map((c) => [humanize(c.category), formatINR(c.amount)]) }}>
                <BarList data={d.expensesByCategory.map((c) => ({ label: humanize(c.category), value: c.amount }))} format={money} emptyText="No expenses in this period" />
              </ChartCard>
            </div>

            {d.branches.length > 1 && (
              <Card pad={false} title="By branch">
                <DataTable dense rowKey={(r) => r.id} rows={d.branches} columns={[
                  { key: "name", label: "Branch", render: (r) => r.name },
                  { key: "count", label: d.countLabel, render: (r) => <span className="tnum">{r.count}</span> },
                  { key: "sales", label: sold, render: (r) => <span className="tnum">{formatINR(r.sales)}</span> },
                  { key: "expenses", label: "Expenses", render: (r) => <span className="tnum">{formatINR(r.expenses)}</span> },
                ]} />
              </Card>
            )}

            <Card pad={false} title="Expenses" subtitle={d.expenses.length ? `${d.expenses.length} entries` : undefined}
              actions={p.has("expenses") && p.can("expenses.manage") ? <a href={`${p.base}/expenses`}><Button size="sm">Add expense</Button></a> : undefined}>
              <DataTable dense rowKey={(r) => r.id} rows={d.expenses}
                empty={<Empty title="No expenses in this period" />}
                columns={[
                  { key: "date", label: "Date", render: (r) => fmtDate(r.date) },
                  { key: "category", label: "Category", render: (r) => <Badge>{humanize(r.category)}</Badge> },
                  { key: "description", label: "Description", render: (r) => r.description },
                  { key: "method", label: "Paid by", render: (r) => humanize(r.method) },
                  { key: "paidTo", label: "Paid to", render: (r) => r.paidTo ?? "-" },
                  { key: "amount", label: "Amount", render: (r) => <span className="tnum">{formatINR(r.amount)}</span> },
                ]} />
            </Card>
          </div>
        )}
      </Loadable>
      <div className="mt-4">
        {p.has("daily_report_whatsapp") ? <DailyReportCard /> : (
          <Notice title="Daily report on WhatsApp (Growth plan)">
            On the Growth plan, this report goes to the owner&apos;s WhatsApp as a PDF every day when the shop closes.
          </Notice>
        )}
      </div>
    </>
  );
}

interface ReportList {
  enabled: boolean;
  sendTo: string | null;
  hours: { openingTime: string; closingTime: string };
  lastClosed: string;
  whatsappReady: boolean;
  items: { id: string; businessDate: string; status: string; sentTo: string | null; attempts: number; error: string | null; summary: { count?: number; sales?: number; expenses?: number }; sentAt: string | null }[];
}

function DailyReportCard() {
  const p = useProduct();
  const r = useApi<ReportList>(`${p.base}/daily-reports`);
  const [busy, run] = useAction();
  const send = (date?: string) => run(async () => {
    const res = await api<{ status: string; error: string | null }>(`${p.base}/daily-reports/send`, { method: "POST", body: date ? { date } : {} });
    await r.reload();
    if (res.status !== "SENT") throw new Error(res.error ?? "The report was not sent.");
  }, "Report sent on WhatsApp");
  return (
    <Loadable state={r}>
      {(d) => (
        <Card
          title={<span className="inline-flex items-center gap-2"><MessageCircle className="h-4 w-4" /> Daily report on WhatsApp</span>}
          subtitle={d.enabled
            ? <>Sent as a PDF to <strong>{d.sendTo ?? "no number"}</strong> every day at closing time ({d.hours.closingTime}).</>
            : "Turned off in Settings."}
          actions={<Button loading={busy} onClick={() => void send(d.lastClosed)}><Send className="h-4 w-4" /> Send {fmtDate(d.lastClosed)} now</Button>}
          pad={false}
        >
          {!d.whatsappReady && <div className="p-4 pb-0"><Notice tone="warn">WhatsApp sending is not set up on the server yet. Reports are kept here and you get an in-app notification instead.</Notice></div>}
          <DataTable dense rowKey={(x) => x.id} rows={d.items}
            empty={<Empty title="No reports yet" hint="The first one goes out after the shop's next closing time." />}
            columns={[
              { key: "businessDate", label: "Business day", render: (x) => fmtDate(x.businessDate) },
              { key: "status", label: "Status", render: (x) => <StatusBadge value={x.status} /> },
              { key: "sales", label: "Sales", render: (x) => <span className="tnum">{formatINR(x.summary?.sales ?? 0)}</span> },
              { key: "expenses", label: "Expenses", render: (x) => <span className="tnum">{formatINR(x.summary?.expenses ?? 0)}</span> },
              { key: "sentAt", label: "Sent", render: (x) => (x.sentAt ? fmtDateTime(x.sentAt) : x.error ?? "-") },
              { key: "again", label: "", render: (x) => <Button size="sm" variant="ghost" loading={busy} onClick={() => void send(x.businessDate)}>Resend</Button> },
            ]} />
        </Card>
      )}
    </Loadable>
  );
}

/** Daily order / bill number for screens: "#003". */
export const dailyLabel = (n: number | null | undefined) => `#${formatDailyNo(n)}`;
