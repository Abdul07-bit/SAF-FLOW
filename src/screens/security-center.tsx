"use client";

/**
 * Security Center screens.
 *  AdminSecurity   - SAF platform view (/admin/security), platform.security.read.
 *  SecurityScreen  - one business's view (/<product>/security), staff.manage.
 * The API enforces both; these screens only display what it returns.
 */
import { useState } from "react";
import { AlertTriangle, CheckCircle2, ShieldAlert, ShieldCheck } from "lucide-react";
import { api, useApi } from "@/lib/client";
import { fmtDateTime } from "@/lib/dates";
import { useProduct } from "@/components/product-context";
import { Badge, Button, Card, DataTable, Empty, Loadable, Notice, PageHeader, Tabs, useAction, type Tone } from "@/components/ui";

const SEV_TONE: Record<string, Tone> = { critical: "bad", high: "bad", medium: "warn", low: "info" };

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: Tone }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`tnum mt-1 text-2xl font-semibold ${tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : "text-slate-900"}`}>{value}</div>
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  "auth.login": "Signed in", "auth.login_failed": "Failed sign-in", "auth.account_locked": "Account locked",
  "auth.login_blocked_locked": "Sign-in while locked", "auth.mfa_failed": "Wrong 2-step code", "auth.step_up_failed": "Failed re-authentication",
  "auth.logout": "Signed out", "auth.logout_all": "Signed out everywhere", "auth.password_changed": "Password changed",
  "auth.password_reset_completed": "Password reset", "auth.mfa_enabled": "2-step verification on", "auth.mfa_disabled": "2-step verification off",
  "auth.mfa_recovery_code_used": "Recovery code used", "auth.step_up": "Re-authenticated", "security.access_denied": "Access denied", "security.rate_limited": "Too many requests (blocked)",
  "security.mfa_reset": "2-step verification reset", "security.sessions_revoked": "Signed out by admin", "security.session_revoked": "Device signed out",
  "team.user.create": "Staff login created", "team.user.invite": "Staff invited", "team.user.update": "Staff access changed",
  "team.user.enable": "Staff enabled", "team.user.disable": "Staff disabled", "team.user.reset_password": "Password reset by manager",
  "team.user.mfa_reset": "2-step verification reset", "billing.payment_amount_mismatch": "Payment amount mismatch",
};
const label = (a: string) => ACTION_LABEL[a] ?? a;
const BAD = new Set(["security.rate_limited", "auth.login_failed", "auth.account_locked", "auth.login_blocked_locked", "auth.mfa_failed", "auth.step_up_failed", "security.access_denied", "billing.payment_amount_mismatch"]);

// ===========================================================================
// SAF platform
// ===========================================================================

export function AdminSecurity() {
  const ov = useApi<any>("/admin/security/overview", { refreshMs: 60_000 });
  const [kind, setKind] = useState<"all" | "failed" | "denied" | "mfa" | "admin">("all");
  const ev = useApi<any>(`/admin/security/events?kind=${kind}`);

  return (
    <div className="space-y-6">
      <PageHeader title="Security Center" description="Platform-wide security status. Business data stays inside each business; this view shows security signals only." />
      <Loadable state={ov}>
        {(d) => (
          <>
            <Card>
              <div className="flex items-center gap-3">
                {d.status === "ok" ? <ShieldCheck className="h-8 w-8 text-emerald-600" aria-hidden /> : <ShieldAlert className={`h-8 w-8 ${d.status === "critical" ? "text-red-600" : "text-amber-600"}`} aria-hidden />}
                <div>
                  <div className="text-lg font-semibold text-slate-900">{d.status === "ok" ? "No open alerts" : d.status === "critical" ? "Critical issues need attention" : "Items need attention"}</div>
                  <div className="text-sm text-slate-500">{d.alerts.length} alert(s) · {d.signIns.liveSessions} live sessions · {d.signIns.lockedAccounts} locked account(s)</div>
                </div>
              </div>
              {d.alerts.length > 0 && (
                <ul className="mt-4 space-y-2">
                  {d.alerts.map((a: any, i: number) => (
                    <li key={i} className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">{a.title} <Badge tone={SEV_TONE[a.severity]}>{a.severity}</Badge></div>
                        <div className="text-sm text-slate-600">{a.detail}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Failed sign-ins (24h)" value={d.signIns.failed24h} tone={d.signIns.failed24h > 50 ? "warn" : undefined} />
              <Stat label="Failed sign-ins (7d)" value={d.signIns.failed7d} />
              <Stat label="Access denied (24h)" value={d.signIns.accessDenied24h} />
              <Stat label="SAF Team with 2-step" value={`${d.mfa.platform.enabled} / ${d.mfa.platform.total}`} tone={d.mfa.platform.enabled < d.mfa.platform.total ? "bad" : undefined} />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Sign-in trend (7 days)">
                <DataTable dense rows={d.trend} rowKey={(r: any) => String(r.day)}
                  empty={<Empty title="No sign-ins in the last 7 days" />}
                  columns={[
                    { key: "day", label: "Day", render: (r: any) => new Date(r.day).toLocaleDateString() },
                    { key: "ok", label: "Successful", align: "right", render: (r: any) => r.ok },
                    { key: "failed", label: "Failed", align: "right", render: (r: any) => <span className={r.failed > r.ok ? "font-semibold text-red-700" : ""}>{r.failed}</span> },
                  ]} />
                {d.suspiciousIps.length > 0 && (
                  <div className="mt-4">
                    <div className="mb-2 text-sm font-medium text-slate-900">Addresses with repeated failures (last hour)</div>
                    <ul className="space-y-1 text-sm">{d.suspiciousIps.map((x: any) => <li key={x.ip} className="flex justify-between"><span className="font-mono">{x.ip}</span><span className="tnum">{x.failures}</span></li>)}</ul>
                  </div>
                )}
              </Card>
              <Card title="Configuration checks">
                <ul className="space-y-2 text-sm">
                  {d.configuration.map((c: any) => (
                    <li key={c.check} className="flex items-center gap-2">
                      {c.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden /> : <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden />}
                      <span className={c.ok ? "text-slate-700" : "font-medium text-slate-900"}>{c.check}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 space-y-1 text-xs text-slate-500">
                  <p>Business owners with 2-step verification: {d.mfa.owners.enabled} / {d.mfa.owners.total}</p>
                  <p>Vulnerability scans: {d.external.vulnerabilityScans}</p>
                  <p>Backups: {d.external.backups}</p>
                </div>
              </Card>
            </div>

            <Card title="Recent administrator activity (7 days)" pad={false}>
              <DataTable dense rows={d.adminActivity} rowKey={(r: any) => r.id} empty={<Empty title="No administrator activity" />}
                columns={[
                  { key: "at", label: "When", render: (r: any) => fmtDateTime(r.createdAt) },
                  { key: "who", label: "Who", render: (r: any) => r.actorName ?? "system" },
                  { key: "action", label: "Action", render: (r: any) => <span className="font-mono text-xs">{r.action}</span> },
                  { key: "ip", label: "IP", render: (r: any) => <span className="font-mono text-xs">{r.ip ?? ""}</span> },
                ]} />
            </Card>
          </>
        )}
      </Loadable>

      <Card title="Security events" pad={false}>
        <div className="px-4 pt-3">
          <Tabs value={kind} onChange={setKind} tabs={[
            { key: "all", label: "All" }, { key: "failed", label: "Failed sign-ins" }, { key: "denied", label: "Access denied" },
            { key: "mfa", label: "2-step" }, { key: "admin", label: "Admin actions" },
          ]} />
        </div>
        <Loadable state={ev}>
          {(d) => (
            <DataTable dense rows={d.items} rowKey={(r: any) => r.id} empty={<Empty title="No events" />}
              columns={[
                { key: "at", label: "When", render: (r: any) => fmtDateTime(r.createdAt) },
                { key: "event", label: "Event", render: (r: any) => <span className={BAD.has(r.action) ? "font-medium text-red-700" : ""}>{label(r.action)}</span> },
                { key: "who", label: "Account", render: (r: any) => r.actorName ?? (r.meta?.username ? `${r.meta.username} (unknown)` : "") },
                { key: "ip", label: "IP", render: (r: any) => <span className="font-mono text-xs">{r.ip ?? ""}</span> },
              ]} />
          )}
        </Loadable>
      </Card>
    </div>
  );
}

// ===========================================================================
// One business
// ===========================================================================

export function SecurityScreen() {
  const p = useProduct();
  const ov = useApi<any>(`${p.base}/security/overview`);
  const sessions = useApi<any>(`${p.base}/security/sessions`);
  const [tab, setTab] = useState<"staff" | "sessions" | "activity">("staff");
  const [busy, act] = useAction();
  const reload = async () => { await Promise.all([ov.reload(), sessions.reload()]); };

  const signOutUser = (id: string, name: string) =>
    confirm(`Sign ${name} out of every device?`) && act(async () => { await api(`${p.base}/security/users/${id}/revoke-sessions`, { method: "POST" }); await reload(); }, `${name} was signed out everywhere`);
  const signOutSession = (id: string) =>
    act(async () => { await api(`${p.base}/security/sessions/${id}/revoke`, { method: "POST" }); await reload(); }, "Device signed out");
  const resetMfa = (id: string, name: string) =>
    confirm(`Reset two-step verification for ${name}? They will set it up again at next sign-in.`) && act(async () => { await api(`${p.base}/team/${id}/mfa-reset`, { method: "POST" }); await reload(); }, "Two-step verification reset");

  return (
    <div className="space-y-6">
      <PageHeader title="Security Center" description="Who can sign in to your business, from where, and what happened recently. Only your business's accounts are shown." />
      <Loadable state={ov}>
        {(d) => (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Stat label="Active accounts" value={d.summary.active} />
              <Stat label="Live sessions" value={d.summary.liveSessions} />
              <Stat label="With 2-step" value={`${d.summary.mfaEnabled} / ${d.summary.accounts}`} />
              <Stat label="Locked" value={d.summary.locked} tone={d.summary.locked ? "warn" : undefined} />
              <Stat label="Failed sign-ins (7d)" value={d.summary.failedSignIns7d} tone={d.summary.failedSignIns7d >= 20 ? "warn" : undefined} />
            </div>
            {d.notes.length > 0 && <Notice tone="warn" title="Recommendations"><ul className="list-disc pl-5">{d.notes.map((n: string) => <li key={n}>{n}</li>)}</ul></Notice>}
            <Card pad={false}>
              <div className="px-4 pt-3">
                <Tabs value={tab} onChange={setTab} tabs={[
                  { key: "staff", label: "Accounts & access", count: d.staff.length },
                  { key: "sessions", label: "Signed-in devices", count: sessions.data?.items.length },
                  { key: "activity", label: "Recent activity" },
                ]} />
              </div>
              {tab === "staff" && (
                <DataTable rows={d.staff} rowKey={(r: any) => r.id}
                  columns={[
                    { key: "name", label: "Account", render: (r: any) => <div><div className="font-medium">{r.fullName} {r.isOwner && <Badge tone="brand">Owner</Badge>}</div><div className="text-xs text-slate-500">{r.username}</div></div> },
                    { key: "roles", label: "Roles", render: (r: any) => r.roles.map((x: any) => `${x.product}: ${x.role}`).join(", ") || "-" },
                    { key: "branches", label: "Branches", render: (r: any) => (r.branches === "all" ? "All" : r.branches.map((b: any) => b.name).join(", ")) },
                    { key: "mfa", label: "2-step", render: (r: any) => (r.mfaEnabled ? <Badge tone="good">On</Badge> : <Badge tone={r.mfaRequired ? "bad" : "neutral"}>Off</Badge>) },
                    { key: "status", label: "Status", render: (r: any) => (!r.isActive ? <Badge tone="neutral">Disabled</Badge> : r.locked ? <Badge tone="warn">Locked</Badge> : r.temporaryPassword ? <Badge tone="info">Temp. password</Badge> : <Badge tone="good">Active</Badge>) },
                    { key: "last", label: "Last sign-in", render: (r: any) => (r.lastLoginAt ? fmtDateTime(r.lastLoginAt) : "Never") },
                    { key: "sessions", label: "Devices", align: "right", render: (r: any) => r.activeSessions },
                    {
                      key: "actions", label: "", align: "right", render: (r: any) => (
                        <div className="flex justify-end gap-1">
                          {r.activeSessions > 0 && r.id !== p.user.id && <Button size="sm" loading={busy} onClick={() => signOutUser(r.id, r.fullName)}>Sign out</Button>}
                          {p.user.isTenantOwner && r.mfaEnabled && r.id !== p.user.id && <Button size="sm" variant="ghost" loading={busy} onClick={() => resetMfa(r.id, r.fullName)}>Reset 2-step</Button>}
                        </div>
                      ),
                    },
                  ]} />
              )}
              {tab === "sessions" && (
                <Loadable state={sessions}>
                  {(s) => (
                    <DataTable rows={s.items} rowKey={(r: any) => r.id} empty={<Empty title="Nobody is signed in" />}
                      columns={[
                        { key: "user", label: "Account", render: (r: any) => <div><div className="font-medium">{r.user?.fullName}</div><div className="text-xs text-slate-500">{r.user?.username}</div></div> },
                        { key: "device", label: "Device", render: (r: any) => <span className="line-clamp-1 max-w-xs text-xs text-slate-600" title={r.userAgent ?? ""}>{r.userAgent ?? "Unknown"}</span> },
                        { key: "ip", label: "IP", render: (r: any) => <span className="font-mono text-xs">{r.ip ?? ""}</span> },
                        { key: "since", label: "Signed in", render: (r: any) => fmtDateTime(r.createdAt) },
                        { key: "seen", label: "Last active", render: (r: any) => fmtDateTime(r.lastSeenAt) },
                        { key: "x", label: "", align: "right", render: (r: any) => (r.current ? <Badge tone="info">This device</Badge> : <Button size="sm" loading={busy} onClick={() => signOutSession(r.id)}>Sign out</Button>) },
                      ]} />
                  )}
                </Loadable>
              )}
              {tab === "activity" && (
                <DataTable dense rows={d.events} rowKey={(r: any) => r.id} empty={<Empty title="No security activity yet" />}
                  columns={[
                    { key: "at", label: "When", render: (r: any) => fmtDateTime(r.createdAt) },
                    { key: "event", label: "Event", render: (r: any) => <span className={BAD.has(r.action) ? "font-medium text-red-700" : ""}>{label(r.action)}{r.newDevice ? " (new device)" : ""}</span> },
                    { key: "who", label: "Account", render: (r: any) => r.actorName ?? "" },
                    { key: "ip", label: "IP", render: (r: any) => <span className="font-mono text-xs">{r.ip ?? ""}</span> },
                  ]} />
              )}
            </Card>
          </>
        )}
      </Loadable>
    </div>
  );
}
