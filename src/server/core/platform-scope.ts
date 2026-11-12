import { withPlatform, type Tx } from "../db";
import type { SessionUser } from "../auth/session";
import { forbidden, notFound } from "../http/errors";

/**
 * What one SAF Team member may do on the platform.
 *
 * Effective permission for an action on business T:
 *   role grants it
 *   AND (role.allTenants OR an active assignment to T exists)
 *   AND (the assignment lists no permissions OR lists this one)
 *   AND (the assignment lists no modules OR lists the product concerned)
 *
 * The tenant part is ALSO enforced by PostgreSQL RLS (withStaffScope), so a
 * route that forgets a check still cannot read an unassigned business.
 */
export interface AssignmentScope {
  id: string;
  products: string[];
  branches: string[];
  permissions: string[];
}

export interface PlatformScope {
  userId: string;
  roleCode: string | null;
  roleName: string | null;
  allTenants: boolean;
  isSuperAdmin: boolean;
  permissions: string[];
  /** Keyed by tenant id. Empty for allTenants roles (they are not restricted). */
  assignments: Map<string, AssignmentScope>;
}

export async function loadPlatformScope(user: SessionUser): Promise<PlatformScope> {
  return withPlatform(async (db) => {
    const u = await db.user.findUnique({
      where: { id: user.id },
      select: {
        platformRoleRef: { include: { permissions: { select: { permissionKey: true } } } },
        staffAssignments: {
          where: { isActive: true, revokedAt: null },
          include: {
            modules: { select: { productCode: true } },
            branches: { select: { branchId: true } },
            permissions: { select: { permissionKey: true } },
          },
        },
      },
    });
    const role = u?.platformRoleRef ?? null;
    const assignments = new Map<string, AssignmentScope>();
    if (role && !role.allTenants) {
      for (const a of u!.staffAssignments) {
        assignments.set(a.tenantId, {
          id: a.id,
          products: a.modules.map((m) => m.productCode),
          branches: a.branches.map((b) => b.branchId),
          permissions: a.permissions.map((p) => p.permissionKey),
        });
      }
    }
    return {
      userId: user.id,
      roleCode: role?.code ?? null,
      roleName: role?.name ?? null,
      allTenants: role?.allTenants ?? false,
      isSuperAdmin: role?.code === "SUPER_ADMIN",
      permissions: role ? role.permissions.map((p) => p.permissionKey).sort() : [],
      assignments,
    };
  });
}

export function roleHas(scope: PlatformScope, perm: string): boolean {
  return scope.permissions.includes(perm);
}

/** Effective check for one business (and optionally one product module). */
export function canOnTenant(scope: PlatformScope, perm: string, tenantId: string, product?: string | null): boolean {
  if (!roleHas(scope, perm)) return false;
  if (scope.allTenants) return true;
  const a = scope.assignments.get(tenantId);
  if (!a) return false;
  if (a.permissions.length && !a.permissions.includes(perm)) return false;
  if (product && a.products.length && !a.products.includes(product)) return false;
  return true;
}

export function assertRole(scope: PlatformScope, perms: readonly string[]) {
  if (perms.some((p) => roleHas(scope, p))) return;
  throw forbidden("PLATFORM_PERMISSION_DENIED", "Your SAF Team role does not allow this action.", { permissions: perms });
}

export function assertOnTenant(scope: PlatformScope, perms: readonly string[], tenantId: string, product?: string | null) {
  if (perms.some((p) => canOnTenant(scope, p, tenantId, product))) return;
  // Unassigned businesses are indistinguishable from missing ones.
  if (!scope.allTenants && !scope.assignments.has(tenantId)) throw notFound("Business");
  throw forbidden("PLATFORM_PERMISSION_DENIED", "Your assignment for this business does not allow this action.", {
    permissions: perms, product: product ?? undefined,
  });
}

/** Tenant ids a scoped member may act on with `perm` (null = every tenant). */
export function tenantsWith(scope: PlatformScope, perm: string): string[] | null {
  if (!roleHas(scope, perm)) return [];
  if (scope.allTenants) return null;
  return [...scope.assignments.entries()].filter(([, a]) => !a.permissions.length || a.permissions.includes(perm)).map(([t]) => t);
}

// ---------------------------------------------------------------------------
// Route targets: which business a platform route acts on
// ---------------------------------------------------------------------------

export type PlatformTarget = "business" | "subscription" | "user" | "invoice" | "ticket" | "bodyTenant" | "bodyInvoice";

export async function resolveTarget(
  db: Tx,
  kind: PlatformTarget,
  params: Record<string, string>,
  body: any,
): Promise<{ tenantId: string; product: string | null } | null> {
  const productFromKey = (k?: string) => (k && k.includes(".") ? k.split(".")[0] : null);
  switch (kind) {
    case "business": {
      const t = await db.tenant.findUnique({ where: { id: params.id }, select: { id: true } });
      return t ? { tenantId: t.id, product: body?.productCode ?? productFromKey(params.key) } : null;
    }
    case "subscription": {
      const s = await db.productSubscription.findUnique({ where: { id: params.id }, select: { tenantId: true, productCode: true } });
      return s ? { tenantId: s.tenantId, product: s.productCode } : null;
    }
    case "user": {
      const u = await db.user.findUnique({ where: { id: params.id }, select: { tenantId: true } });
      return u?.tenantId ? { tenantId: u.tenantId, product: null } : null;
    }
    case "invoice": {
      const i = await db.invoice.findUnique({ where: { id: params.id }, select: { tenantId: true, productCode: true } });
      return i ? { tenantId: i.tenantId, product: i.productCode ?? null } : null;
    }
    case "ticket": {
      const t = await db.supportTicket.findUnique({ where: { id: params.id }, select: { tenantId: true, productCode: true } });
      return t ? { tenantId: t.tenantId, product: t.productCode ?? null } : null;
    }
    case "bodyTenant": {
      if (!body?.tenantId) return null;
      const t = await db.tenant.findUnique({ where: { id: body.tenantId }, select: { id: true } });
      return t ? { tenantId: t.id, product: body.productCode ?? null } : null;
    }
    case "bodyInvoice": {
      if (!body?.invoiceId) return null;
      const i = await db.invoice.findUnique({ where: { id: body.invoiceId }, select: { tenantId: true, productCode: true } });
      return i ? { tenantId: i.tenantId, product: i.productCode ?? null } : null;
    }
  }
}
