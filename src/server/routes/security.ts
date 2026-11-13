/**
 * Security Center.
 *
 *  /admin/security/*      SAF platform view (platform.security.read / .manage).
 *                         Cross-tenant; only explicitly authorised SAF staff.
 *  /:product/security/*   Business view (managers with staff.manage). Runs in the
 *                         tenant's RLS scope, so it can only ever see that
 *                         business's users, sessions and audit events.
 *
 * Session token hashes are never returned by any endpoint here.
 */
import { z } from "zod";
import { SUPER_ADMIN_ROLE } from "@/config/platform";
import { route, type Ctx } from "../http/router";
import { badRequest, forbidden, notFound } from "../http/errors";
import type { Tx } from "../db";
import { revokeUserSessions } from "../auth/session";
import { mfaRequiredFor } from "../auth/mfa";
import { appSecretConfigured } from "../core/keys";
import { isCashfreeConfigured } from "../payments/cashfree";

const H = 3_600_000;
const FAILED = ["auth.login_failed", "auth.account_locked", "auth.login_blocked_locked", "auth.mfa_failed", "auth.step_up_failed"];
const SIGN_IN = ["auth.login", ...FAILED, "auth.logout", "auth.logout_all", "auth.password_changed", "auth.password_reset_completed"];
const SECURITY_ACTIONS = [
  ...SIGN_IN, "auth.mfa_enabled", "auth.mfa_disabled", "auth.mfa_recovery_code_used", "auth.mfa_recovery_codes_regenerated",
  "auth.step_up", "security.access_denied", "security.mfa_reset", "security.sessions_revoked", "team.user.mfa_reset",
  "team.user.create", "team.user.invite", "team.user.update", "team.user.enable", "team.user.disable", "team.user.reset_password",
  "team.user.reset_password_email", "security.session_revoked", "billing.payment_amount_mismatch",
];

const sessionView = (s: any, currentId?: string) => ({
  id: s.id, userId: s.userId, user: s.user ? { fullName: s.user.fullName, username: s.user.username } : undefined,
  ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt,
  mfaVerified: !!s.mfaVerifiedAt, current: s.id === currentId,
});
const SESSION_SELECT = {
  id: true, userId: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true, mfaVerifiedAt: true,
  user: { select: { fullName: true, username: true } },
} as const;

function liveSessionWhere(now: Date) {
  return { revokedAt: null, mfaPending: false, expiresAt: { gt: now } };
}

// ===========================================================================
// SAF platform Security Center
// ===========================================================================

type Alert = { severity: "critical" | "high" | "medium" | "low"; title: string; detail: string };

route({
  method: "GET", path: "/admin/security/overview", tag: "security", summary: "Platform security status, alerts and trends",
  auth: { platform: "platform.security.read" },
  handler: async ({ db }) => {
    const now = new Date();
    const d1 = new Date(now.getTime() - 24 * H), d7 = new Date(now.getTime() - 7 * 24 * H), h1 = new Date(now.getTime() - H);
    const [failed24, failed7, denied24, locked, liveSessions, platformUsers, owners, ipsLastHour, adminActivity, mismatches, trendRows, tenants] = await Promise.all([
      db.auditLog.count({ where: { action: { in: FAILED }, createdAt: { gt: d1 } } }),
      db.auditLog.count({ where: { action: { in: FAILED }, createdAt: { gt: d7 } } }),
      db.auditLog.count({ where: { action: "security.access_denied", createdAt: { gt: d1 } } }),
      db.user.count({ where: { lockedUntil: { gt: now } } }),
      db.session.count({ where: liveSessionWhere(now) }),
      db.user.findMany({ where: { kind: "PLATFORM", isActive: true }, select: { id: true, fullName: true, platformRole: true, mfaEnabledAt: true } }),
      db.user.findMany({ where: { kind: "TENANT", isTenantOwner: true, isActive: true }, select: { mfaEnabledAt: true } }),
      db.auditLog.groupBy({ by: ["ip"], where: { action: { in: FAILED }, createdAt: { gt: h1 }, ip: { not: null } }, _count: { _all: true } }),
      db.auditLog.findMany({
        where: { OR: [{ action: { startsWith: "platform." } }, { action: { startsWith: "security." } }, { action: { startsWith: "admin." } }], createdAt: { gt: d7 } },
        orderBy: { createdAt: "desc" }, take: 25,
        select: { id: true, action: true, actorName: true, entityType: true, entityId: true, tenantId: true, ip: true, createdAt: true },
      }),
      db.auditLog.count({ where: { action: "billing.payment_amount_mismatch", createdAt: { gt: d7 } } }),
      db.$queryRaw<{ day: Date; failed: bigint; ok: bigint }[]>`
        SELECT date_trunc('day', created_at) AS day,
               count(*) FILTER (WHERE action = ANY(${FAILED})) AS failed,
               count(*) FILTER (WHERE action = 'auth.login') AS ok
        FROM audit_logs WHERE created_at > ${d7} AND action = ANY(${[...FAILED, "auth.login"]})
        GROUP BY 1 ORDER BY 1`,
      db.tenant.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);

    const alerts: Alert[] = [];
    const noMfaAdmins = platformUsers.filter((u) => !u.mfaEnabledAt);
    if (noMfaAdmins.some((u) => u.platformRole === SUPER_ADMIN_ROLE))
      alerts.push({ severity: "critical", title: "Super Admin without two-step verification", detail: "Turn on two-step verification for every Super Admin account." });
    if (noMfaAdmins.length)
      alerts.push({ severity: "high", title: `${noMfaAdmins.length} SAF Team account(s) without two-step verification`, detail: noMfaAdmins.slice(0, 5).map((u) => u.fullName).join(", ") });
    for (const r of ipsLastHour.filter((x) => x._count._all >= 20))
      alerts.push({ severity: "high", title: "Possible password guessing / credential stuffing", detail: `${r._count._all} failed sign-ins from ${r.ip} in the last hour.` });
    if (mismatches) alerts.push({ severity: "high", title: "Payment amount mismatches", detail: `${mismatches} online payment(s) did not match their order in the last 7 days. Investigate before settling manually.` });
    if (process.env.NODE_ENV === "production" && !appSecretConfigured())
      alerts.push({ severity: "critical", title: "SAF_APP_SECRET is not set", detail: "Two-step verification and employee photo links are disabled until it is configured." });
    if (process.env.NODE_ENV === "production" && !(process.env.APP_URL || "").startsWith("https://"))
      alerts.push({ severity: "critical", title: "Not served over HTTPS", detail: "Set APP_URL to the https:// address so cookies are Secure and HSTS is sent." });
    if (locked >= 10) alerts.push({ severity: "medium", title: `${locked} accounts are locked`, detail: "Many lockouts usually mean an attack on several accounts." });
    if (denied24 >= 50) alerts.push({ severity: "medium", title: "Many access denials", detail: `${denied24} permission denials in 24 hours: a client may be probing endpoints.` });

    const required = (k: string) => mfaRequiredFor({ kind: k === "platform" ? "PLATFORM" : "TENANT", isTenantOwner: true });
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    alerts.sort((a, b) => order[a.severity] - order[b.severity]);
    return {
      status: alerts.some((a) => a.severity === "critical") ? "critical" : alerts.some((a) => a.severity === "high") ? "attention" : "ok",
      alerts,
      signIns: { failed24h: failed24, failed7d: failed7, accessDenied24h: denied24, lockedAccounts: locked, liveSessions },
      trend: trendRows.map((r) => ({ day: r.day, failed: Number(r.failed), ok: Number(r.ok) })),
      suspiciousIps: ipsLastHour.filter((x) => x._count._all >= 5).sort((a, b) => b._count._all - a._count._all).slice(0, 10).map((x) => ({ ip: x.ip, failures: x._count._all })),
      mfa: {
        policy: { platform: required("platform"), owners: required("owners") },
        platform: { total: platformUsers.length, enabled: platformUsers.length - noMfaAdmins.length },
        owners: { total: owners.length, enabled: owners.filter((o) => o.mfaEnabledAt).length },
      },
      tenants: Object.fromEntries(tenants.map((t) => [t.status, t._count._all])),
      adminActivity: adminActivity.map((a) => ({ ...a, id: a.id.toString() })),
      configuration: [
        { check: "HTTPS (APP_URL)", ok: (process.env.APP_URL || "").startsWith("https://") },
        { check: "Application secret (MFA, signed photo links)", ok: appSecretConfigured() || process.env.NODE_ENV !== "production" },
        { check: "Rate limiting active", ok: !(process.env.SAF_DISABLE_RATE_LIMIT === "1" && process.env.NODE_ENV !== "production") },
        { check: "Two-step verification required for SAF Team", ok: required("platform") },
        { check: "Two-step verification required for business owners", ok: required("owners") },
        { check: "Payment gateway configured", ok: isCashfreeConfigured() },
        { check: "Scheduled jobs secret (CRON_SECRET)", ok: (process.env.CRON_SECRET || "").length >= 12 },
      ],
      // Not observable from inside the application; reported honestly.
      external: {
        vulnerabilityScans: "Run in CI (.github/workflows/security.yml): see the latest workflow run.",
        backups: "Not monitored by the application. Verify the database provider's backup and restore status.",
      },
    };
  },
});

route({
  method: "GET", path: "/admin/security/events", tag: "security", summary: "Security-relevant audit events across the platform",
  auth: { platform: "platform.security.read" },
  query: z.object({
    kind: z.enum(["all", "failed", "signin", "denied", "mfa", "admin"]).default("all"),
    tenantId: z.uuid().optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
  }),
  handler: async ({ db, query }) => {
    const actions =
      query.kind === "failed" ? FAILED
      : query.kind === "signin" ? SIGN_IN
      : query.kind === "denied" ? ["security.access_denied"]
      : query.kind === "mfa" ? SECURITY_ACTIONS.filter((a) => a.includes("mfa"))
      : null;
    const where: any = {
      ...(actions ? { action: { in: actions } } : query.kind === "admin"
        ? { OR: [{ action: { startsWith: "platform." } }, { action: { startsWith: "admin." } }, { action: { startsWith: "security." } }] }
        : { action: { in: SECURITY_ACTIONS } }),
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
    };
    const [items, total] = await Promise.all([
      db.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * 50, take: 50 }),
      db.auditLog.count({ where }),
    ]);
    return { items: items.map((i) => ({ ...i, id: i.id.toString() })), total, page: query.page, pageSize: 50 };
  },
});

route({
  method: "GET", path: "/admin/security/users/:id/sessions", tag: "security", summary: "A user's active sessions",
  auth: { platform: "platform.security.read" },
  handler: async ({ db, params }) => {
    const rows = await db.session.findMany({ where: { userId: params.id, ...liveSessionWhere(new Date()) }, select: SESSION_SELECT, orderBy: { lastSeenAt: "desc" } });
    return { items: rows.map((s) => sessionView(s)) };
  },
});

route({
  method: "POST", path: "/admin/security/users/:id/revoke-sessions", tag: "security", summary: "Sign a user out of every device (incident response)",
  auth: { platform: "platform.security.manage", elevated: true }, stepUp: true,
  body: z.object({ reason: z.string().trim().min(5).max(300) }),
  handler: async (ctx) => {
    const u = await ctx.db.user.findUnique({ where: { id: ctx.params.id }, select: { id: true, tenantId: true, platformRole: true } });
    if (!u) throw notFound("User");
    if (u.platformRole === SUPER_ADMIN_ROLE && !ctx.platform.isSuperAdmin && u.id !== ctx.user.id)
      throw forbidden("PRIVILEGE_ESCALATION", "Only a Super Admin can sign out a Super Admin.");
    await revokeUserSessions(ctx.db, u.id, u.id === ctx.user.id ? ctx.session!.id : undefined);
    await ctx.audit("security.sessions_revoked", { type: "user", id: u.id, tenantId: u.tenantId }, { reason: ctx.body.reason });
    return { ok: true };
  },
});

// ===========================================================================
// Business (tenant) Security Center
// ===========================================================================

const TENANT_SEC = { product: ":product", permission: "staff.manage" } as const;

async function tenantUserGuard(ctx: Ctx, db: Tx, userId: string) {
  const u = await db.user.findFirst({ where: { id: userId, tenantId: ctx.tenantId }, select: { id: true, isTenantOwner: true } });
  if (!u) throw notFound("Staff member");
  if (u.id !== ctx.user.id && !ctx.user.isTenantOwner) {
    const isManager = (await db.userProductAccess.count({ where: { userId: u.id, isActive: true, role: { code: "manager" } } })) > 0;
    if (u.isTenantOwner || isManager) throw forbidden("PERMISSION_DENIED", "Only the business owner can sign out another manager.");
  }
  return u;
}

route({
  method: "GET", path: "/:product/security/overview", tag: "security", summary: "Your business: staff access, MFA, sessions and sign-in activity",
  auth: TENANT_SEC,
  handler: async (ctx) => {
    const { db, tenantId } = ctx;
    const now = new Date();
    const [users, sessions, recent, failed7d, branches] = await Promise.all([
      db.user.findMany({
        where: { tenantId },
        orderBy: [{ isTenantOwner: "desc" }, { fullName: "asc" }],
        select: {
          id: true, fullName: true, username: true, isActive: true, isTenantOwner: true, lastLoginAt: true, lockedUntil: true,
          mfaEnabledAt: true, mustChangePassword: true, authUserId: true,
          productAccess: { where: { isActive: true }, select: { productCode: true, role: { select: { code: true, name: true } } } },
          branchAccess: { select: { branch: { select: { id: true, name: true } } } },
        },
      }),
      db.session.groupBy({ by: ["userId"], where: { tenantId, ...liveSessionWhere(now) }, _count: { _all: true } }),
      db.auditLog.findMany({
        where: { tenantId, action: { in: SECURITY_ACTIONS } }, orderBy: { createdAt: "desc" }, take: 40,
        select: { id: true, action: true, actorName: true, entityId: true, ip: true, userAgent: true, createdAt: true, meta: true },
      }),
      db.auditLog.count({ where: { tenantId, action: { in: FAILED }, createdAt: { gt: new Date(now.getTime() - 7 * 24 * H) } } }),
      db.branch.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true } }),
    ]);
    const live = new Map(sessions.map((s) => [s.userId, s._count._all]));
    const staff = users.map((u) => ({
      id: u.id, fullName: u.fullName, username: u.username, isActive: u.isActive, isOwner: u.isTenantOwner,
      lastLoginAt: u.lastLoginAt, locked: !!u.lockedUntil && u.lockedUntil > now, mfaEnabled: !!u.mfaEnabledAt,
      mfaRequired: mfaRequiredFor({ kind: "TENANT", isTenantOwner: u.isTenantOwner }),
      temporaryPassword: u.mustChangePassword, signIn: u.authUserId ? "email" : "login_id",
      roles: u.productAccess.map((a) => ({ product: a.productCode, role: a.role.name, code: a.role.code })),
      branches: u.branchAccess.length ? u.branchAccess.map((b) => b.branch) : "all",
      activeSessions: live.get(u.id) ?? 0,
    }));
    const notes: string[] = [];
    const owner = staff.find((s) => s.isOwner);
    if (owner && !owner.mfaEnabled) notes.push("Turn on two-step verification for the owner account.");
    const managersNoMfa = staff.filter((s) => s.isActive && !s.mfaEnabled && s.roles.some((r) => r.code === "manager") && !s.isOwner);
    if (managersNoMfa.length) notes.push(`${managersNoMfa.length} manager account(s) without two-step verification.`);
    const temp = staff.filter((s) => s.isActive && s.temporaryPassword);
    if (temp.length) notes.push(`${temp.length} account(s) still use a temporary password.`);
    const inactive = staff.filter((s) => s.isActive && !s.isOwner && (!s.lastLoginAt || now.getTime() - new Date(s.lastLoginAt).getTime() > 60 * 24 * H));
    if (inactive.length) notes.push(`${inactive.length} active account(s) have not signed in for 60 days: disable them if they are no longer needed.`);
    if (failed7d >= 20) notes.push(`${failed7d} failed sign-ins in the last 7 days.`);
    return {
      summary: {
        accounts: staff.length, active: staff.filter((s) => s.isActive).length, locked: staff.filter((s) => s.locked).length,
        mfaEnabled: staff.filter((s) => s.mfaEnabled).length, liveSessions: sessions.reduce((a, s) => a + s._count._all, 0), failedSignIns7d: failed7d,
      },
      notes, staff, branches,
      events: recent.map((e) => ({ ...e, id: e.id.toString(), meta: undefined, newDevice: (e.meta as any)?.newDevice === true })),
    };
  },
});

route({
  method: "GET", path: "/:product/security/sessions", tag: "security", summary: "Signed-in devices of your business's accounts",
  auth: TENANT_SEC,
  handler: async (ctx) => {
    const rows = await ctx.db.session.findMany({
      where: { tenantId: ctx.tenantId, ...liveSessionWhere(new Date()) }, select: SESSION_SELECT, orderBy: { lastSeenAt: "desc" }, take: 500,
    });
    return { items: rows.map((s) => sessionView(s, ctx.session!.id)) };
  },
});

route({
  method: "POST", path: "/:product/security/sessions/:id/revoke", tag: "security", summary: "Sign one device out",
  auth: TENANT_SEC, stepUp: true,
  handler: async (ctx) => {
    const s = await ctx.db.session.findFirst({ where: { id: ctx.params.id, tenantId: ctx.tenantId }, select: { id: true, userId: true, revokedAt: true } });
    if (!s || s.revokedAt) throw notFound("Session");
    await tenantUserGuard(ctx, ctx.db, s.userId);
    if (s.id === ctx.session!.id) throw badRequest("Use Sign out to end your current session.");
    await ctx.db.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
    await ctx.audit("security.session_revoked", { type: "session", id: s.id }, { userId: s.userId });
    return { ok: true };
  },
});

route({
  method: "POST", path: "/:product/security/users/:userId/revoke-sessions", tag: "security", summary: "Sign a staff member out of every device",
  auth: TENANT_SEC, stepUp: true,
  handler: async (ctx) => {
    const u = await tenantUserGuard(ctx, ctx.db, ctx.params.userId);
    await revokeUserSessions(ctx.db, u.id, u.id === ctx.user.id ? ctx.session!.id : undefined);
    await ctx.audit("security.sessions_revoked", { type: "user", id: u.id });
    return { ok: true };
  },
});
