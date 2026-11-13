"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Building2, MailCheck, Plus, ShieldCheck, UserPlus } from "lucide-react";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { api, errorMessage, useApi } from "@/lib/client";
import { humanize } from "@/shared/fields";
import { PRODUCTS } from "@/config/catalog";
import {
  Badge, Button, Card, DataTable, Empty, Field, Input, KeyValue, Loadable, Modal, Notice, PageHeader, Select, StatusBadge, Textarea, toast, useAction,
} from "@/components/ui";
import { CopyButton, SearchBox, productShort, useDebounced } from "./admin-shared";

const linkCls = "font-medium text-brand underline-offset-2 hover:underline";

interface Member {
  id: string; fullName: string; email: string | null; phone: string | null; isActive: boolean;
  role: { code: string; name: string; allTenants: boolean } | null;
  employeeCode: string | null; department: string | null; designation: string | null;
  lastLoginAt: string | null; lockedUntil: string | null; identity: "email" | "login_id";
  invitation: { status: string; sentAt: string; expiresAt: string; delivery: string } | null;
  assignedBusinesses?: number | null;
}
interface Role { code: string; name: string; description: string; allTenants: boolean; isSystem: boolean; editable: boolean; members: number; permissions: string[] }
interface Perm { key: string; area: string; description: string }
interface RolesData { roles: Role[]; permissions: Perm[] }

/** The signed-in member's own platform permissions (drives which buttons show). */
export function useMyPlatform() {
  return useApi<{ role: { code: string; name: string; allTenants: boolean } | null; permissions: string[]; assignedBusinesses: string[] | null }>("/admin/me");
}

function MemberStatus({ m }: { m: Member }) {
  if (m.invitation?.status === "PENDING") return <Badge tone="warn">Invitation pending</Badge>;
  const locked = m.lockedUntil && new Date(m.lockedUntil) > new Date();
  return (
    <span className="flex flex-wrap gap-1">
      <StatusBadge value={m.isActive ? "ACTIVE" : "SUSPENDED"} label={m.isActive ? "Active" : "Suspended"} />
      {locked && <Badge tone="bad">Locked</Badge>}
    </span>
  );
}

function InviteLinkNotice({ link, who }: { link: string; who: string }) {
  return (
    <Notice tone="info" title="Share this invitation link">
      <p className="break-all font-mono text-xs">{link}</p>
      <p className="mt-2">Send it to {who} (for example on WhatsApp). It opens a page where they choose their own password. Links expire after 24 hours; you can always send a fresh one.</p>
      <div className="mt-2"><CopyButton text={link} label="Copy link" /></div>
    </Notice>
  );
}

// ---------------------------------------------------------------------------
// Team list
// ---------------------------------------------------------------------------

export function AdminTeam() {
  const [q, setQ] = useState("");
  const dq = useDebounced(q).toLowerCase();
  const list = useApi<{ items: Member[]; inviteConfigured: boolean }>("/admin/team");
  const mine = useMyPlatform();
  const [inviting, setInviting] = useState(false);
  const can = (p: string) => !!mine.data?.permissions.includes(p);

  return (
    <>
      <PageHeader
        title="SAF Team"
        description="SmartAutoFlex employees who manage clients. Each member sees only the businesses they are assigned to, unless their role covers every business."
        actions={<>
          <SearchBox value={q} onChange={setQ} placeholder="Name, email or employee ID" label="Search team" />
          {can("platform.staff.create") && <Button variant="primary" onClick={() => setInviting(true)}><UserPlus className="h-4 w-4" aria-hidden /> Invite member</Button>}
        </>}
      />
      <Loadable state={list}>
        {(d) => {
          const rows = d.items.filter((m) => !dq || [m.fullName, m.email, m.employeeCode].some((v) => v?.toLowerCase().includes(dq)));
          return (
            <>
              {!d.inviteConfigured && <div className="mb-4"><Notice tone="warn" title="Email invitations are awaiting credentials">Add SUPABASE_SECRET_KEY to the server environment to invite team members.</Notice></div>}
              <Card pad={false}>
                <DataTable
                  rows={rows} rowKey={(r) => r.id}
                  empty={<Empty title={dq ? "No team members match" : "No team members yet"} hint="Invite your first SmartAutoFlex employee." />}
                  onRowClick={(r) => (window.location.href = `/admin/team/${r.id}`)}
                  columns={[
                    { key: "n", label: "Member", render: (r) => <span className="block"><Link className={linkCls} href={`/admin/team/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.fullName}</Link><span className="block text-xs text-slate-500">{r.email ?? "Login ID account"}</span></span> },
                    { key: "e", label: "Employee ID", render: (r) => <span className="font-mono text-[13px]">{r.employeeCode ?? "-"}</span> },
                    { key: "d", label: "Department", render: (r) => <span className="block">{r.department ?? "-"}<span className="block text-xs text-slate-500">{r.designation ?? ""}</span></span> },
                    { key: "r", label: "Role", render: (r) => r.role ? <Badge tone={r.role.allTenants ? "brand" : "neutral"}>{r.role.name}</Badge> : <Badge tone="bad">No role</Badge> },
                    { key: "c", label: "Clients", render: (r) => (r.role?.allTenants ? <span className="text-slate-600">All businesses</span> : `${r.assignedBusinesses ?? 0} assigned`) },
                    { key: "l", label: "Last sign-in", render: (r) => (r.lastLoginAt ? fmtDateTime(r.lastLoginAt) : "Never") },
                    { key: "s", label: "Status", render: (r) => <MemberStatus m={r} /> },
                  ]}
                />
              </Card>
            </>
          );
        }}
      </Loadable>
      {inviting && <InviteMemberModal onClose={() => setInviting(false)} onDone={() => void list.reload()} />}
    </>
  );
}

function InviteMemberModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const roles = useApi<RolesData>("/admin/platform-roles");
  const [v, setV] = useState({ fullName: "", email: "", phone: "", employeeCode: "", department: "", designation: "", roleCode: "", delivery: "email" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ delivery: string; inviteLink: string | null } | null>(null);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((x) => ({ ...x, [k]: e.target.value }));
  const role = roles.data?.roles.find((r) => r.code === v.roleCode);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ""));
      const r = await api<{ delivery: string; inviteLink: string | null }>("/admin/team", { body });
      setDone(r);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Modal open title="Invitation created" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        {done.inviteLink ? <InviteLinkNotice link={done.inviteLink} who={v.fullName} /> : (
          <Notice tone="good" title="Invitation email sent"><span className="flex items-center gap-2"><MailCheck className="h-4 w-4" aria-hidden /> {v.fullName} will get an email at {v.email} to set their password.</span></Notice>
        )}
      </Modal>
    );
  }

  return (
    <Modal open title="Invite a SAF Team member" onClose={onClose} size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="invite-member" loading={busy}>Send invitation</Button></>}>
      <form id="invite-member" onSubmit={submit} className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <Field label="Full name" required><Input required minLength={2} maxLength={100} value={v.fullName} onChange={set("fullName")} /></Field>
        <Field label="Work email" required help="They sign in with this email."><Input required type="email" maxLength={200} value={v.email} onChange={set("email")} /></Field>
        <Field label="Employee ID" required><Input required maxLength={20} className="font-mono uppercase" value={v.employeeCode} onChange={set("employeeCode")} placeholder="SAF-014" /></Field>
        <Field label="Phone"><Input type="tel" maxLength={20} value={v.phone} onChange={set("phone")} /></Field>
        <Field label="Department"><Input maxLength={60} value={v.department} onChange={set("department")} placeholder="Operations" /></Field>
        <Field label="Designation"><Input maxLength={60} value={v.designation} onChange={set("designation")} placeholder="Senior Executive" /></Field>
        <Field label="Platform role" required className="sm:col-span-2" help={role ? `${role.description} ${role.allTenants ? "Sees every business." : "Sees only businesses you assign."}` : undefined}>
          <Select required value={v.roleCode} onChange={set("roleCode")}>
            <option value="">Choose a role...</option>
            {roles.data?.roles.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
          </Select>
        </Field>
        <Field label="How to send the invitation" className="sm:col-span-2">
          <Select value={v.delivery} onChange={set("delivery")}>
            <option value="email">Email it to them (needs SMTP set up in Supabase)</option>
            <option value="link">Give me a link to share myself</option>
          </Select>
        </Field>
        {error && <div className="sm:col-span-2"><Notice tone="bad">{error}</Notice></div>}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Member detail
// ---------------------------------------------------------------------------

interface Assignment {
  id: string; isActive: boolean; note: string | null; createdAt: string; revokedAt: string | null; assignedBy: string | null;
  business: { id: string; code: string; status: string; name: string; category: string | null };
  branches: { id: string; name: string }[]; products: string[]; permissions: string[];
}
interface MemberDetail { member: Member; assignments: Assignment[]; activity: { id: string; action: string; createdAt: string; tenantId: string | null; entityType: string | null; meta: any }[] }

export function AdminTeamMember({ id }: { id: string }) {
  const data = useApi<MemberDetail>(`/admin/team/${id}`);
  const roles = useApi<RolesData>("/admin/platform-roles");
  const mine = useMyPlatform();
  const can = (p: string) => !!mine.data?.permissions.includes(p);
  const [editing, setEditing] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const [assign, setAssign] = useState<Assignment | "new" | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, run] = useAction();

  return (
    <Loadable state={data}>
      {(d) => {
        const m = d.member;
        const role = roles.data?.roles.find((r) => r.code === m.role?.code);
        const active = d.assignments.filter((a) => a.isActive);
        const pending = m.invitation?.status === "PENDING";
        return (
          <>
            <PageHeader
              title={m.fullName}
              description={<span className="flex flex-wrap items-center gap-2">{m.email} <MemberStatus m={m} /></span>}
              actions={<>
                {pending && can("platform.staff.create") && <>
                  <Button loading={busy} onClick={() => run(async () => { await api(`/admin/team/${id}/resend-invite`, { body: { delivery: "email" } }); }, "Invitation email sent")}>Resend email</Button>
                  <Button loading={busy} onClick={() => run(async () => { const r = await api<{ inviteLink: string }>(`/admin/team/${id}/resend-invite`, { body: { delivery: "link" } }); setLink(r.inviteLink); })}>Get invite link</Button>
                </>}
                {can("platform.staff.update") && <Button onClick={() => setEditing(true)}>Edit</Button>}
                {can("platform.staff.update") && !pending && (m.isActive
                  ? <Button variant="danger" onClick={() => setSuspending(true)}>Suspend</Button>
                  : <Button loading={busy} onClick={() => run(async () => { await api(`/admin/team/${id}`, { method: "PATCH", body: { isActive: true } }); await data.reload(); }, "Access restored")}>Reactivate</Button>)}
              </>}
            />
            {link && <div className="mb-4"><InviteLinkNotice link={link} who={m.fullName} /></div>}
            <div className="grid gap-4 xl:grid-cols-[22rem_1fr]">
              <div className="space-y-4">
                <Card title="Profile">
                  <KeyValue items={[
                    ["Employee ID", <span key="e" className="font-mono">{m.employeeCode ?? "-"}</span>],
                    ["Department", m.department ?? "-"],
                    ["Designation", m.designation ?? "-"],
                    ["Phone", m.phone ?? "-"],
                    ["Sign-in", m.identity === "email" ? "Email (Supabase)" : "Login ID"],
                    ["Last sign-in", m.lastLoginAt ? fmtDateTime(m.lastLoginAt) : "Never"],
                    ...(pending ? [["Invited", `${fmtDateTime(m.invitation!.sentAt)} (${m.invitation!.delivery})`] as [string, string]] : []),
                  ]} />
                </Card>
                <Card title="Platform role" subtitle={m.role?.allTenants ? "Covers every business" : "Only assigned businesses"}>
                  {!m.role ? <p className="text-sm text-red-700">No role: this member cannot do anything.</p> : (
                    <>
                      <p className="text-sm font-semibold text-slate-900">{m.role.name}</p>
                      <ul className="mt-2 flex flex-wrap gap-1">{role?.permissions.map((p) => <li key={p}><Badge>{p.replace("platform.", "")}</Badge></li>)}</ul>
                    </>
                  )}
                </Card>
              </div>
              <div className="space-y-4">
                <Card
                  title="Client assignments"
                  subtitle={m.role?.allTenants ? "This role already sees every business; assignments are not needed." : "Businesses this member can see and manage. Limits narrow what the role allows."}
                  actions={!m.role?.allTenants && can("platform.staff.assign") && <Button size="sm" variant="primary" onClick={() => setAssign("new")}><Plus className="h-4 w-4" aria-hidden /> Assign business</Button>}
                  pad={false}
                >
                  <DataTable
                    rows={active} rowKey={(r) => r.id}
                    empty={<Empty title="No businesses assigned" hint={m.role?.allTenants ? undefined : "Assign a business so this member can work on it."} />}
                    columns={[
                      { key: "b", label: "Business", render: (r) => <span className="block"><Link className={linkCls} href={`/admin/businesses/${r.business.id}`}>{r.business.name}</Link><span className="block font-mono text-xs text-slate-500">{r.business.code}</span></span> },
                      { key: "m", label: "Modules", render: (r) => r.products.length ? <span className="flex flex-wrap gap-1">{r.products.map((p) => <Badge key={p}>{productShort(p)}</Badge>)}</span> : <span className="text-slate-500">All</span> },
                      { key: "br", label: "Branches", render: (r) => r.branches.length ? r.branches.map((b) => b.name).join(", ") : <span className="text-slate-500">All</span> },
                      { key: "p", label: "Permissions", render: (r) => r.permissions.length ? `${r.permissions.length} of role` : <span className="text-slate-500">Full role</span> },
                      { key: "s", label: "Since", render: (r) => <span className="block">{fmtDate(r.createdAt)}<span className="block text-xs text-slate-500">{r.assignedBy ? `by ${r.assignedBy}` : ""}</span></span> },
                      {
                        key: "x", label: "", align: "right", render: (r) => can("platform.staff.assign") && (
                          <span className="flex justify-end gap-2">
                            <Button size="sm" onClick={() => setAssign(r)}>Edit</Button>
                            <Button size="sm" variant="danger" loading={busy} onClick={() => {
                              if (!confirm(`Remove ${m.fullName}'s access to ${r.business.name}? It takes effect immediately.`)) return;
                              void run(async () => { await api(`/admin/team/${id}/assignments/${r.business.id}`, { method: "DELETE" }); await data.reload(); }, "Access revoked");
                            }}>Revoke</Button>
                          </span>
                        ),
                      },
                    ]}
                  />
                </Card>
                <Card title="Recent activity" subtitle="Everything this member did, newest first" pad={false}>
                  <DataTable
                    dense rows={d.activity} rowKey={(r) => r.id} empty={<Empty title="No activity yet" />}
                    columns={[
                      { key: "t", label: "When", render: (r) => fmtDateTime(r.createdAt) },
                      { key: "a", label: "Action", render: (r) => <span className="font-mono text-xs">{r.action}</span> },
                      { key: "e", label: "On", render: (r) => r.entityType ? humanize(r.entityType) : "-" },
                    ]}
                  />
                </Card>
              </div>
            </div>
            {editing && roles.data && <EditMemberModal member={m} roles={roles.data.roles} onClose={() => setEditing(false)} onDone={() => void data.reload()} />}
            {suspending && <SuspendModal member={m} onClose={() => setSuspending(false)} onDone={() => void data.reload()} />}
            {assign && role && (
              <AssignmentModal memberId={id} memberName={m.fullName} role={role} perms={roles.data!.permissions} existing={assign === "new" ? null : assign}
                taken={new Set(active.map((a) => a.business.id))} onClose={() => setAssign(null)} onDone={() => void data.reload()} />
            )}
          </>
        );
      }}
    </Loadable>
  );
}

function EditMemberModal({ member, roles, onClose, onDone }: { member: Member; roles: Role[]; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ fullName: member.fullName, phone: member.phone ?? "", department: member.department ?? "", designation: member.designation ?? "", roleCode: member.role?.code ?? "", reason: "" });
  const [busy, run] = useAction();
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV((x) => ({ ...x, [k]: e.target.value }));
  const roleChanged = v.roleCode !== (member.role?.code ?? "");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api(`/admin/team/${member.id}`, {
        method: "PATCH",
        body: { fullName: v.fullName, phone: v.phone || null, department: v.department || null, designation: v.designation || null, ...(roleChanged ? { roleCode: v.roleCode, reason: v.reason || undefined } : {}) },
      });
      onDone();
      onClose();
    }, "Saved");
  };
  return (
    <Modal open title={`Edit ${member.fullName}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="edit-member" loading={busy}>Save</Button></>}>
      <form id="edit-member" onSubmit={submit} className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <Field label="Full name" required><Input required minLength={2} value={v.fullName} onChange={set("fullName")} /></Field>
        <Field label="Phone"><Input value={v.phone} onChange={set("phone")} /></Field>
        <Field label="Department"><Input value={v.department} onChange={set("department")} /></Field>
        <Field label="Designation"><Input value={v.designation} onChange={set("designation")} /></Field>
        <Field label="Platform role" className="sm:col-span-2" help={roleChanged ? "Changing the role signs this member out everywhere." : undefined}>
          <Select value={v.roleCode} onChange={set("roleCode")}>{roles.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</Select>
        </Field>
        {roleChanged && <Field label="Reason for the role change" className="sm:col-span-2"><Input maxLength={300} value={v.reason} onChange={set("reason")} /></Field>}
      </form>
    </Modal>
  );
}

function SuspendModal({ member, onClose, onDone }: { member: Member; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, run] = useAction();
  return (
    <Modal open title={`Suspend ${member.fullName}?`} onClose={onClose} size="sm"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={!reason.trim()} onClick={() => run(async () => {
        await api(`/admin/team/${member.id}`, { method: "PATCH", body: { isActive: false, reason } });
        onDone();
        onClose();
      }, "Member suspended")}>Suspend now</Button></>}>
      <p className="text-sm text-slate-700">They are signed out of every device immediately and cannot sign in until reactivated. Their assignments are kept.</p>
      <Field label="Reason (recorded in the audit log)" required className="mt-3"><Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}

function AssignmentModal({ memberId, memberName, role, perms, existing, taken, onClose, onDone }: {
  memberId: string; memberName: string; role: Role; perms: Perm[]; existing: Assignment | null; taken: Set<string>; onClose: () => void; onDone: () => void;
}) {
  const businesses = useApi<{ items: { id: string; name: string; code: string }[] }>(existing ? null : "/admin/businesses?pageSize=500");
  const [tenantId, setTenantId] = useState(existing?.business.id ?? "");
  const detail = useApi<{ branches: { id: string; name: string; isMain: boolean; isActive: boolean }[]; subscriptions: { productCode: string }[] }>(tenantId ? `/admin/businesses/${tenantId}` : null);
  const [products, setProducts] = useState<string[]>(existing?.products ?? []);
  const [branches, setBranches] = useState<string[]>(existing?.branches.map((b) => b.id) ?? []);
  const [narrow, setNarrow] = useState<string[]>(existing?.permissions ?? []);
  const [note, setNote] = useState(existing?.note ?? "");
  const [busy, run] = useAction();
  const toggle = (list: string[], setList: (v: string[]) => void, key: string) => setList(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  const rolePerms = perms.filter((p) => role.permissions.includes(p.key));

  const submit = () => run(async () => {
    await api(`/admin/team/${memberId}/assignments/${tenantId}`, { method: "PUT", body: { products, branchIds: branches, permissions: narrow, note: note || undefined } });
    onDone();
    onClose();
  }, existing ? "Assignment updated" : "Business assigned");

  return (
    <Modal open size="lg" title={existing ? `${memberName} on ${existing.business.name}` : `Assign ${memberName} to a business`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!tenantId} onClick={() => void submit()}>{existing ? "Save" : "Assign"}</Button></>}>
      <div className="space-y-4">
        {!existing && (
          <Field label="Business" required>
            <Select value={tenantId} onChange={(e) => { setTenantId(e.target.value); setBranches([]); setProducts([]); }}>
              <option value="">Choose a business...</option>
              {businesses.data?.items.filter((b) => !taken.has(b.id)).map((b) => <option key={b.id} value={b.id}>{b.name} ({b.code})</option>)}
            </Select>
          </Field>
        )}
        {tenantId && detail.data && (
          <>
            <fieldset>
              <legend className="text-sm font-medium text-slate-800">Modules <span className="font-normal text-slate-500">(none ticked = every subscribed module)</span></legend>
              <div className="mt-1.5 flex flex-wrap gap-3">
                {detail.data.subscriptions.map((s) => (
                  <label key={s.productCode} className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={products.includes(s.productCode)} onChange={() => toggle(products, setProducts, s.productCode)} /> {PRODUCTS[s.productCode as keyof typeof PRODUCTS]?.name ?? s.productCode}</label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="text-sm font-medium text-slate-800">Branches <span className="font-normal text-slate-500">(none ticked = every branch)</span></legend>
              <div className="mt-1.5 flex flex-wrap gap-3">
                {detail.data.branches.filter((b) => b.isActive).map((b) => (
                  <label key={b.id} className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={branches.includes(b.id)} onChange={() => toggle(branches, setBranches, b.id)} /> {b.name}{b.isMain ? " (main)" : ""}</label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="text-sm font-medium text-slate-800">Permissions on this business <span className="font-normal text-slate-500">(none ticked = everything the {role.name} role allows)</span></legend>
              <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                {rolePerms.map((p) => (
                  <label key={p.key} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" checked={narrow.includes(p.key)} onChange={() => toggle(narrow, setNarrow, p.key)} /><span>{p.description}<span className="block font-mono text-[11px] text-slate-500">{p.key}</span></span></label>
                ))}
              </div>
            </fieldset>
            <Field label="Note"><Input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Account manager for onboarding" /></Field>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Roles and permissions
// ---------------------------------------------------------------------------

export function AdminRoles() {
  const data = useApi<RolesData>("/admin/platform-roles");
  const mine = useMyPlatform();
  const canManage = !!mine.data?.permissions.includes("platform.staff.permissions.manage");
  const [edit, setEdit] = useState<Role | "new" | null>(null);
  return (
    <>
      <PageHeader title="Roles & permissions" description="Platform roles decide what each SAF Team member can do. Assignments can narrow a role further for a single business."
        actions={canManage && <Button variant="primary" onClick={() => setEdit("new")}><Plus className="h-4 w-4" aria-hidden /> New role</Button>} />
      <Loadable state={data}>
        {(d) => (
          <div className="grid gap-4 lg:grid-cols-2">
            {d.roles.map((r) => (
              <Card key={r.code} title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-brand" aria-hidden /> {r.name}</span>}
                subtitle={<span className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs">{r.code}</span>{r.allTenants ? <Badge tone="brand">Every business</Badge> : <Badge>Assigned businesses</Badge>}<span className="text-xs">{r.members} member{r.members === 1 ? "" : "s"}</span></span>}
                actions={canManage && r.editable && <Button size="sm" onClick={() => setEdit(r)}>Edit</Button>}>
                <p className="text-sm text-slate-600">{r.description}</p>
                <p className="mt-2 text-xs text-slate-500">{r.permissions.length} of {d.permissions.length} permissions</p>
              </Card>
            ))}
          </div>
        )}
      </Loadable>
      {edit && data.data && <RoleModal role={edit === "new" ? null : edit} perms={data.data.permissions} onClose={() => setEdit(null)} onDone={() => void data.reload()} />}
    </>
  );
}

function RoleModal({ role, perms, onClose, onDone }: { role: Role | null; perms: Perm[]; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ code: "", name: role?.name ?? "", description: role?.description ?? "", allTenants: role?.allTenants ?? false, reason: "" });
  const [sel, setSel] = useState<string[]>(role?.permissions ?? ["platform.dashboard.read"]);
  const [busy, run] = useAction();
  const areas = useMemo(() => [...new Set(perms.map((p) => p.area))], [perms]);
  const submit = () => run(async () => {
    const body = { name: v.name, description: v.description, allTenants: v.allTenants, permissions: sel };
    if (role) await api(`/admin/platform-roles/${role.code}`, { method: "PUT", body: { ...body, reason: v.reason || undefined } });
    else await api("/admin/platform-roles", { body: { ...body, code: v.code } });
    onDone();
    onClose();
  }, role ? "Role updated" : "Role created");
  return (
    <Modal open size="xl" title={role ? `Edit ${role.name}` : "New platform role"} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>Save role</Button></>}>
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        {!role && <Field label="Code" required help="Letters, digits and _ (e.g. REGIONAL_LEAD)"><Input className="font-mono uppercase" maxLength={40} value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} /></Field>}
        <Field label="Name" required><Input maxLength={60} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Description" className="sm:col-span-2"><Input maxLength={300} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={v.allTenants} onChange={(e) => setV({ ...v, allTenants: e.target.checked })} /> Members with this role see <strong>every business</strong> (no assignments needed)</label>
        {role && <Field label="Reason for the change" className="sm:col-span-2"><Input maxLength={300} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>}
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {areas.map((area) => (
          <fieldset key={area} className="rounded-xl border border-slate-200 p-3">
            <legend className="px-1 text-sm font-semibold text-slate-900">{area}</legend>
            {perms.filter((p) => p.area === area).map((p) => (
              <label key={p.key} className="mt-1.5 flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" checked={sel.includes(p.key)} onChange={() => setSel((s) => (s.includes(p.key) ? s.filter((k) => k !== p.key) : [...s, p.key]))} />
                <span>{p.description}</span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Business detail: SAF Team card
// ---------------------------------------------------------------------------

export function BusinessTeamCard({ id }: { id: string }) {
  const team = useApi<{ memberId: string; fullName: string; email: string | null; role: string | null; products: string[]; branchCount: number; narrowed: boolean; isActive: boolean; invitePending: boolean }[]>(`/admin/businesses/${id}/team`);
  return (
    <Card title={<span className="flex items-center gap-2"><Building2 className="h-4 w-4 text-brand" aria-hidden /> SAF Team on this business</span>}
      subtitle="Members with client-scoped roles assigned here. Super Admins, Platform Admins and Auditors see every business." pad={false}>
      <Loadable state={team}>
        {(rows) => (
          <DataTable rows={rows} rowKey={(r) => r.memberId} empty={<Empty title="Nobody assigned yet" hint="Open a team member and use Assign business." />}
            columns={[
              { key: "n", label: "Member", render: (r) => <span className="block"><Link className={linkCls} href={`/admin/team/${r.memberId}`}>{r.fullName}</Link><span className="block text-xs text-slate-500">{r.email}</span></span> },
              { key: "r", label: "Role", render: (r) => r.role ?? "-" },
              { key: "m", label: "Modules", render: (r) => (r.products.length ? r.products.map(productShort).join(", ") : "All") },
              { key: "l", label: "Limits", render: (r) => [r.branchCount ? `${r.branchCount} branch(es)` : null, r.narrowed ? "narrowed permissions" : null].filter(Boolean).join(", ") || "None" },
              { key: "s", label: "", render: (r) => (r.invitePending ? <Badge tone="warn">Invitation pending</Badge> : !r.isActive ? <Badge tone="bad">Suspended</Badge> : null) },
            ]} />
        )}
      </Loadable>
    </Card>
  );
}

