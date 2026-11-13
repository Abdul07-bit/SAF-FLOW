/**
 * SAF Team management: SmartAutoFlex's own employees, their platform roles
 * and their assignments to client businesses.
 *
 * Every route here is `elevated` (runs with the RLS bypass, since assignments
 * are only writable in that scope) and therefore enforces its own guards:
 *  - nobody can grant a permission they do not hold themselves (except the
 *    Super Admin), so the panel cannot be used to escalate privileges;
 *  - SUPER_ADMIN accounts and the SUPER_ADMIN role can only be touched by a
 *    Super Admin; nobody changes their own role, status or assignments;
 *  - a member whose role is not platform-wide can only assign within the
 *    businesses they are assigned to themselves.
 */
import { logError } from "../core/log";
import { z } from "zod";
import { PRODUCT_CODES } from "@/config/catalog";
import { ALL_PLATFORM_PERMISSIONS, PLATFORM_PERMISSIONS, SUPER_ADMIN_ROLE } from "@/config/platform";
import { route, type Ctx } from "../http/router";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../http/errors";
import type { Tx } from "../db";
import { revokeUserSessions } from "../auth/session";
import { identity } from "../auth/identity";
import { inviteAccount, resendInvite } from "../core/invitations";
import type { PlatformScope } from "../core/platform-scope";

const permKey = z.string().refine((k) => (ALL_PLATFORM_PERMISSIONS as string[]).includes(k), "Unknown platform permission");

function assertCanGrant(scope: PlatformScope, perms: readonly string[]) {
  if (scope.isSuperAdmin) return;
  const missing = perms.filter((p) => !scope.permissions.includes(p));
  if (missing.length)
    throw forbidden("PRIVILEGE_ESCALATION", "You cannot grant permissions you do not have yourself.", { permissions: missing });
}

async function roleWithPerms(db: Tx, code: string) {
  const role = await db.platformRole.findUnique({ where: { code }, include: { permissions: true } });
  if (!role) throw badRequest(`Unknown platform role ${code}.`);
  return { ...role, keys: role.permissions.map((p) => p.permissionKey) };
}

async function assertCanUseRole(ctx: Ctx, code: string) {
  const role = await roleWithPerms(ctx.db, code);
  if (role.code === SUPER_ADMIN_ROLE && !ctx.platform.isSuperAdmin)
    throw forbidden("PRIVILEGE_ESCALATION", "Only a Super Admin can appoint another Super Admin.");
  if (role.allTenants && !ctx.platform.allTenants)
    throw forbidden("PRIVILEGE_ESCALATION", "You cannot grant access to every business.");
  assertCanGrant(ctx.platform, role.keys);
  return role;
}

async function loadMember(ctx: Ctx, id: string) {
  const m = await ctx.db.user.findFirst({ where: { id, kind: "PLATFORM" }, include: { staffProfile: true } });
  if (!m) throw notFound("Team member");
  if (m.platformRole === SUPER_ADMIN_ROLE && !ctx.platform.isSuperAdmin)
    throw forbidden("PRIVILEGE_ESCALATION", "Only a Super Admin can change a Super Admin account.");
  return m;
}

function assertNotSelf(ctx: Ctx, id: string, what: string) {
  if (id === ctx.user.id) throw badRequest(`You cannot change your own ${what}.`);
}

const memberView = (u: any) => ({
  id: u.id, fullName: u.fullName, email: u.email, phone: u.phone, isActive: u.isActive,
  role: u.platformRoleRef ? { code: u.platformRoleRef.code, name: u.platformRoleRef.name, allTenants: u.platformRoleRef.allTenants } : null,
  employeeCode: u.staffProfile?.employeeCode ?? null, department: u.staffProfile?.department ?? null,
  designation: u.staffProfile?.designation ?? null, lastLoginAt: u.lastLoginAt, lockedUntil: u.lockedUntil,
  identity: u.authUserId ? "email" : "login_id",
  invitation: u.invitations?.[0] ? { status: u.invitations[0].status, sentAt: u.invitations[0].sentAt, expiresAt: u.invitations[0].expiresAt, delivery: u.invitations[0].delivery } : null,
});

// ---------------------------------------------------------------------------
// Platform roles and permissions
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/admin/platform-roles", tag: "saf-team", summary: "Platform roles with their permissions, and the permission catalog",
  auth: { platform: "platform.staff.read", elevated: true },
  handler: async ({ db }) => {
    const roles = await db.platformRole.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { permissions: { select: { permissionKey: true } }, _count: { select: { users: true } } },
    });
    return {
      roles: roles.map((r) => ({
        code: r.code, name: r.name, description: r.description, allTenants: r.allTenants, isSystem: r.isSystem,
        editable: r.code !== SUPER_ADMIN_ROLE, members: r._count.users, permissions: r.permissions.map((p) => p.permissionKey).sort(),
      })),
      permissions: PLATFORM_PERMISSIONS,
    };
  },
});

const roleBody = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).default(""),
  allTenants: z.boolean().default(false),
  permissions: z.array(permKey).max(100),
});

route({
  method: "POST", path: "/admin/platform-roles", tag: "saf-team", summary: "Create a custom platform role",
  auth: { platform: "platform.staff.permissions.manage", elevated: true }, stepUp: true,
  body: roleBody.extend({ code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{2,39}$/, "Code: 3-40 letters, digits or _") }),
  handler: async (ctx) => {
    const b = ctx.body;
    assertCanGrant(ctx.platform, b.permissions);
    if (b.allTenants && !ctx.platform.allTenants) throw forbidden("PRIVILEGE_ESCALATION", "You cannot grant access to every business.");
    if (await ctx.db.platformRole.findUnique({ where: { code: b.code } })) throw conflict(`Role ${b.code} already exists.`);
    await ctx.db.platformRole.create({
      data: {
        code: b.code, name: b.name, description: b.description, allTenants: b.allTenants, customized: true, sortOrder: 100,
        permissions: { create: [...new Set(b.permissions)].map((permissionKey) => ({ permissionKey })) },
      },
    });
    await ctx.audit("platform.role.create", { type: "platform_role", id: b.code }, { after: b });
    ctx.status = 201;
    return { code: b.code };
  },
});

route({
  method: "PUT", path: "/admin/platform-roles/:code", tag: "saf-team", summary: "Edit a platform role's permissions and scope",
  auth: { platform: "platform.staff.permissions.manage", elevated: true }, stepUp: true,
  body: roleBody.extend({ reason: z.string().trim().max(300).optional() }),
  handler: async (ctx) => {
    const code = ctx.params.code;
    if (code === SUPER_ADMIN_ROLE) throw forbidden("ROLE_LOCKED", "The Super Admin role cannot be changed.");
    const before = await roleWithPerms(ctx.db, code);
    const b = ctx.body;
    // Granting AND removing both need the permission: you cannot reshape what you do not hold.
    const changed = [...b.permissions.filter((p) => !before.keys.includes(p)), ...before.keys.filter((p) => !b.permissions.includes(p))];
    assertCanGrant(ctx.platform, changed);
    if (b.allTenants !== before.allTenants && !ctx.platform.allTenants)
      throw forbidden("PRIVILEGE_ESCALATION", "You cannot change whether a role sees every business.");
    if (ctx.platform.roleCode === code) throw badRequest("You cannot change your own role.");
    await ctx.db.platformRolePermission.deleteMany({ where: { roleCode: code } });
    await ctx.db.platformRole.update({
      where: { code },
      data: {
        name: b.name, description: b.description, allTenants: b.allTenants, customized: true,
        permissions: { create: [...new Set(b.permissions)].map((permissionKey) => ({ permissionKey })) },
      },
    });
    await ctx.audit("platform.role.update", { type: "platform_role", id: code }, {
      before: { name: before.name, allTenants: before.allTenants, permissions: before.keys },
      after: { name: b.name, allTenants: b.allTenants, permissions: b.permissions }, reason: b.reason,
    });
    return { ok: true };
  },
});

route({
  method: "DELETE", path: "/admin/platform-roles/:code", tag: "saf-team", summary: "Delete an unused custom platform role",
  auth: { platform: "platform.staff.permissions.manage", elevated: true }, stepUp: true,
  handler: async (ctx) => {
    const role = await ctx.db.platformRole.findUnique({ where: { code: ctx.params.code }, include: { _count: { select: { users: true } } } });
    if (!role) throw notFound("Role");
    if (role.isSystem) throw badRequest("Built-in roles cannot be deleted.");
    if (role._count.users) throw conflict("Move the team members in this role to another role first.");
    await ctx.db.platformRole.delete({ where: { code: role.code } });
    await ctx.audit("platform.role.delete", { type: "platform_role", id: role.code });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Team members
// ---------------------------------------------------------------------------

const memberInclude = {
  staffProfile: true,
  platformRoleRef: true,
  invitations: { orderBy: { sentAt: "desc" as const }, take: 1 },
  _count: { select: { staffAssignments: { where: { isActive: true, revokedAt: null } } } },
};

route({
  method: "GET", path: "/admin/team", tag: "saf-team", summary: "SAF Team members",
  auth: { platform: "platform.staff.read", elevated: true },
  handler: async ({ db }) => {
    const users = await db.user.findMany({ where: { kind: "PLATFORM" }, include: memberInclude, orderBy: { fullName: "asc" } });
    return {
      items: users.map((u) => ({ ...memberView(u), assignedBusinesses: u.platformRoleRef?.allTenants ? null : u._count.staffAssignments })),
      inviteConfigured: identity().adminConfigured(),
    };
  },
});

const profileFields = {
  fullName: z.string().trim().min(2).max(100),
  phone: z.string().trim().max(20).optional(),
  employeeCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, "Employee ID: 2-20 letters, digits or -"),
  department: z.string().trim().max(60).optional(),
  designation: z.string().trim().max(60).optional(),
};

route({
  method: "POST", path: "/admin/team", tag: "saf-team", summary: "Invite a SAF Team member (email invitation, no password is ever set by an admin)",
  auth: { platform: "platform.staff.create", elevated: true }, stepUp: true,
  body: z.object({
    ...profileFields,
    email: z.string().trim().toLowerCase().email().max(200),
    roleCode: z.string().trim(),
    delivery: z.enum(["email", "link"]).default("email"),
  }),
  rateLimit: { limit: 10, windowMs: 60 * 60_000, by: "user" },
  handler: async (ctx) => {
    const b = ctx.body;
    await assertCanUseRole(ctx, b.roleCode);
    if (await ctx.db.platformStaffProfile.findUnique({ where: { employeeCode: b.employeeCode } }))
      throw conflict(`Employee ID ${b.employeeCode} is already in use.`);
    const { user, delivery, link } = await inviteAccount(ctx.db, {
      email: b.email, fullName: b.fullName, phone: b.phone, kind: "PLATFORM", tenantId: null, platformRole: b.roleCode,
      delivery: b.delivery, invitedById: ctx.user.id,
      extra: { staffProfile: { create: { employeeCode: b.employeeCode, department: b.department || null, designation: b.designation || null } } },
    });
    const sent = { delivery, link };
    await ctx.audit("platform.staff.invite", { type: "user", id: user.id }, {
      email: b.email, role: b.roleCode, employeeCode: b.employeeCode, delivery: sent.delivery,
    });
    ctx.status = 201;
    return { id: user.id, delivery: sent.delivery, inviteLink: sent.link };
  },
});

route({
  method: "POST", path: "/admin/team/:id/resend-invite", tag: "saf-team", summary: "Send a fresh invitation to a member who has not accepted yet",
  auth: { platform: "platform.staff.create", elevated: true },
  body: z.object({ delivery: z.enum(["email", "link"]).default("email") }),
  rateLimit: { limit: 10, windowMs: 60 * 60_000, by: "user" },
  handler: async (ctx) => {
    const m = await loadMember(ctx, ctx.params.id);
    const r = await resendInvite(ctx.db, m.id, ctx.body.delivery);
    const delivery = r.delivery;
    await ctx.audit("platform.staff.invite_resent", { type: "user", id: m.id }, { delivery });
    return { ok: true, delivery, inviteLink: r.link };
  },
});

route({
  method: "GET", path: "/admin/team/:id", tag: "saf-team", summary: "Team member with assignments and recent activity",
  auth: { platform: "platform.staff.read", elevated: true },
  handler: async (ctx) => {
    const m = await ctx.db.user.findFirst({ where: { id: ctx.params.id, kind: "PLATFORM" }, include: memberInclude });
    if (!m) throw notFound("Team member");
    const [assignments, activity] = await Promise.all([
      ctx.db.staffAssignment.findMany({
        where: { userId: m.id },
        orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
        include: {
          tenant: { select: { id: true, code: true, status: true, business: { select: { name: true, category: true } } } },
          branches: { include: { branch: { select: { id: true, name: true } } } },
          modules: { select: { productCode: true } },
          permissions: { select: { permissionKey: true } },
          assignedBy: { select: { fullName: true } },
        },
      }),
      ctx.db.auditLog.findMany({ where: { actorId: m.id }, orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    return {
      member: memberView(m),
      assignments: assignments.map((a) => ({
        id: a.id, isActive: a.isActive && !a.revokedAt, note: a.note, createdAt: a.createdAt, revokedAt: a.revokedAt,
        assignedBy: a.assignedBy?.fullName ?? null,
        business: { id: a.tenant.id, code: a.tenant.code, status: a.tenant.status, name: a.tenant.business?.name ?? a.tenant.code, category: a.tenant.business?.category ?? null },
        branches: a.branches.map((b) => b.branch),
        products: a.modules.map((x) => x.productCode),
        permissions: a.permissions.map((x) => x.permissionKey),
      })),
      activity: activity.map((l) => ({ ...l, id: l.id.toString() })),
    };
  },
});

route({
  method: "PATCH", path: "/admin/team/:id", tag: "saf-team", summary: "Edit, re-role, suspend or reactivate a team member",
  auth: { platform: "platform.staff.update", elevated: true }, stepUp: true,
  body: z.object({
    fullName: profileFields.fullName.optional(),
    phone: z.string().trim().max(20).nullable().optional(),
    department: z.string().trim().max(60).nullable().optional(),
    designation: z.string().trim().max(60).nullable().optional(),
    roleCode: z.string().trim().optional(),
    isActive: z.boolean().optional(),
    reason: z.string().trim().max(300).optional(),
  }),
  handler: async (ctx) => {
    const m = await loadMember(ctx, ctx.params.id);
    const b = ctx.body;
    if (b.roleCode !== undefined && b.roleCode !== m.platformRole) {
      assertNotSelf(ctx, m.id, "role");
      await assertCanUseRole(ctx, b.roleCode);
    }
    if (b.isActive !== undefined && b.isActive !== m.isActive) {
      assertNotSelf(ctx, m.id, "status");
      if (b.isActive && (await ctx.db.invitation.count({ where: { userId: m.id, status: "PENDING" } })))
        throw badRequest("This member has not accepted their invitation yet.");
      if (!b.isActive && !b.reason) throw badRequest("Give a reason for suspending this member.");
    }
    await ctx.db.user.update({
      where: { id: m.id },
      data: {
        fullName: b.fullName, phone: b.phone, platformRole: b.roleCode, isActive: b.isActive,
        ...(b.department !== undefined || b.designation !== undefined
          ? { staffProfile: { update: { department: b.department, designation: b.designation } } }
          : {}),
      },
    });
    if (b.isActive === false || (b.roleCode !== undefined && b.roleCode !== m.platformRole)) {
      // Suspension and role changes take effect immediately on every device.
      await revokeUserSessions(ctx.db, m.id);
    }
    if (b.isActive !== undefined && m.authUserId && identity().adminConfigured()) {
      await identity().setBanned(m.authUserId, !b.isActive).catch((e) => logError("team", "identity ban sync failed", e));
    }
    await ctx.audit(b.isActive === false ? "platform.staff.suspend" : b.isActive === true ? "platform.staff.reactivate" : "platform.staff.update",
      { type: "user", id: m.id }, {
        before: { role: m.platformRole, isActive: m.isActive, fullName: m.fullName },
        after: { role: b.roleCode ?? m.platformRole, isActive: b.isActive ?? m.isActive, fullName: b.fullName ?? m.fullName },
        reason: b.reason,
      });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Assignments to client businesses
// ---------------------------------------------------------------------------

route({
  method: "PUT", path: "/admin/team/:id/assignments/:tenantId", tag: "saf-team",
  summary: "Assign a member to a business, optionally limited to branches, modules and permissions",
  auth: { platform: "platform.staff.assign", elevated: true },
  body: z.object({
    branchIds: z.array(z.uuid()).max(100).default([]),
    products: z.array(z.enum(PRODUCT_CODES)).max(10).default([]),
    /** Narrows the member's role permissions for this business; [] = the role's permissions. */
    permissions: z.array(permKey).max(100).default([]),
    note: z.string().trim().max(300).optional(),
  }),
  handler: async (ctx) => {
    const { id, tenantId } = ctx.params;
    assertNotSelf(ctx, id, "assignments");
    const m = await loadMember(ctx, id);
    if (!ctx.platform.allTenants && !ctx.platform.assignments.has(tenantId)) throw notFound("Business");
    const tenant = await ctx.db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) throw notFound("Business");
    const b = ctx.body;
    const role = m.platformRole ? await roleWithPerms(ctx.db, m.platformRole) : null;
    if (!role) throw badRequest("Give this member a platform role first.");
    if (role.allTenants) throw badRequest(`${role.name} already sees every business; assignments do not apply.`);
    const outside = b.permissions.filter((p) => !role.keys.includes(p));
    if (outside.length) throw badRequest(`Not part of the ${role.name} role: ${outside.join(", ")}`);
    assertCanGrant(ctx.platform, b.permissions.length ? b.permissions : role.keys);
    if (b.branchIds.length) {
      const n = await ctx.db.branch.count({ where: { tenantId, id: { in: b.branchIds } } });
      if (n !== new Set(b.branchIds).size) throw badRequest("Unknown branch for this business.");
    }

    const before = await ctx.db.staffAssignment.findUnique({
      where: { userId_tenantId: { userId: m.id, tenantId } },
      include: { branches: true, modules: true, permissions: true },
    });
    const a = await ctx.db.staffAssignment.upsert({
      where: { userId_tenantId: { userId: m.id, tenantId } },
      create: { userId: m.id, tenantId, assignedById: ctx.user.id, note: b.note ?? null },
      update: { isActive: true, revokedAt: null, assignedById: ctx.user.id, note: b.note ?? undefined },
    });
    await ctx.db.staffAssignmentBranch.deleteMany({ where: { assignmentId: a.id } });
    await ctx.db.staffAssignmentModule.deleteMany({ where: { assignmentId: a.id } });
    await ctx.db.staffAssignmentPermission.deleteMany({ where: { assignmentId: a.id } });
    if (b.branchIds.length)
      await ctx.db.staffAssignmentBranch.createMany({ data: [...new Set(b.branchIds)].map((branchId) => ({ assignmentId: a.id, branchId, tenantId })) });
    if (b.products.length)
      await ctx.db.staffAssignmentModule.createMany({ data: [...new Set(b.products)].map((productCode) => ({ assignmentId: a.id, productCode, tenantId })) });
    if (b.permissions.length)
      await ctx.db.staffAssignmentPermission.createMany({ data: [...new Set(b.permissions)].map((permissionKey) => ({ assignmentId: a.id, permissionKey })) });

    await ctx.audit(before ? "platform.staff.assignment_update" : "platform.staff.assign", { type: "staff_assignment", id: a.id, tenantId }, {
      member: m.id,
      before: before && {
        isActive: before.isActive && !before.revokedAt, branchIds: before.branches.map((x) => x.branchId),
        products: before.modules.map((x) => x.productCode), permissions: before.permissions.map((x) => x.permissionKey),
      },
      after: { isActive: true, branchIds: b.branchIds, products: b.products, permissions: b.permissions },
    });
    return { id: a.id };
  },
});

route({
  method: "DELETE", path: "/admin/team/:id/assignments/:tenantId", tag: "saf-team", summary: "Revoke a member's access to a business (effective immediately)",
  auth: { platform: "platform.staff.assign", elevated: true },
  handler: async (ctx) => {
    const { id, tenantId } = ctx.params;
    assertNotSelf(ctx, id, "assignments");
    await loadMember(ctx, id);
    if (!ctx.platform.allTenants && !ctx.platform.assignments.has(tenantId)) throw notFound("Business");
    const a = await ctx.db.staffAssignment.findUnique({ where: { userId_tenantId: { userId: id, tenantId } } });
    if (!a || a.revokedAt) throw notFound("Assignment");
    await ctx.db.staffAssignment.update({ where: { id: a.id }, data: { isActive: false, revokedAt: new Date() } });
    await ctx.audit("platform.staff.unassign", { type: "staff_assignment", id: a.id, tenantId }, { member: id });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// The signed-in member's own scope (drives the admin UI)
// ---------------------------------------------------------------------------

route({
  method: "GET", path: "/admin/me", tag: "saf-team", summary: "Your platform role, permissions and assigned businesses",
  auth: { platform: "platform.dashboard.read" },
  handler: async (ctx) => ({
    role: ctx.platform.roleCode ? { code: ctx.platform.roleCode, name: ctx.platform.roleName, allTenants: ctx.platform.allTenants } : null,
    permissions: ctx.platform.permissions,
    assignedBusinesses: ctx.platform.allTenants ? null : [...ctx.platform.assignments.keys()],
  }),
});

route({
  method: "GET", path: "/admin/businesses/:id/team", tag: "saf-team", summary: "SAF Team members assigned to a business",
  auth: { platform: "platform.business.read", target: "business" },
  handler: async (ctx) => {
    // Assignments are only readable in the bypass scope; the target check above
    // already proved the caller may see this business.
    const { withPlatform } = await import("../db");
    return withPlatform(async (db) => {
      const rows = await db.staffAssignment.findMany({
        where: { tenantId: ctx.params.id, isActive: true, revokedAt: null },
        include: {
          user: { select: { id: true, fullName: true, email: true, isActive: true, platformRoleRef: { select: { name: true } }, invitations: { where: { status: "PENDING" }, select: { id: true }, take: 1 } } },
          modules: { select: { productCode: true } }, branches: { select: { branchId: true } }, permissions: { select: { permissionKey: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      return rows.map((a) => ({
        memberId: a.user.id, fullName: a.user.fullName, email: a.user.email, isActive: a.user.isActive, invitePending: a.user.invitations.length > 0, role: a.user.platformRoleRef?.name ?? null,
        products: a.modules.map((m) => m.productCode), branchCount: a.branches.length, narrowed: a.permissions.length > 0, since: a.createdAt,
      }));
    });
  },
});
