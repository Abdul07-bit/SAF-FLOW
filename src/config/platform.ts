/**
 * SAF Flow platform (SmartAutoFlex internal) permissions and default roles.
 *
 * These are PLATFORM-level permissions, used only by SAF Team accounts in the
 * Super Admin panel. Customer (business) permissions live per product in
 * catalog.ts and are never mixed with these.
 *
 * The seed syncs this file into platform_permissions / platform_roles /
 * platform_role_permissions. Roles are editable from the admin panel after
 * seeding (except SUPER_ADMIN); re-seeding never overwrites an edited role.
 */

export interface PlatformPermissionDef {
  key: string;
  area: string;
  description: string;
}

export const PLATFORM_PERMISSIONS = [
  { key: "platform.dashboard.read", area: "Overview", description: "View the platform overview and health" },

  { key: "platform.business.read", area: "Businesses", description: "View businesses, branches and their status" },
  { key: "platform.business.create", area: "Businesses", description: "Onboard new businesses" },
  { key: "platform.business.update", area: "Businesses", description: "Edit business profiles and branches" },
  { key: "platform.business.suspend", area: "Businesses", description: "Suspend or reactivate businesses" },

  { key: "platform.catalog.read", area: "Products & plans", description: "View products, modules, plans and features" },
  { key: "platform.catalog.manage", area: "Products & plans", description: "Edit products, plans, pricing and plan features" },
  { key: "platform.entitlements.manage", area: "Products & plans", description: "Enable/disable modules and feature overrides for a business" },

  { key: "platform.subscription.read", area: "Subscriptions", description: "View subscriptions and their history" },
  { key: "platform.subscription.manage", area: "Subscriptions", description: "Renew, extend, change plan, suspend or reactivate subscriptions" },

  { key: "platform.billing.read", area: "Billing", description: "View invoices and payments" },
  { key: "platform.billing.manage", area: "Billing", description: "Raise invoices, record payments, void invoices" },
  { key: "platform.revenue.read", area: "Billing", description: "View revenue analytics" },

  { key: "platform.users.read", area: "Customer accounts", description: "View business manager and staff accounts" },
  { key: "platform.users.manage", area: "Customer accounts", description: "Reset passwords, unlock, enable or disable customer accounts" },

  { key: "platform.staff.read", area: "SAF Team", description: "View SAF Team members and their assignments" },
  { key: "platform.staff.create", area: "SAF Team", description: "Invite SAF Team members" },
  { key: "platform.staff.update", area: "SAF Team", description: "Edit, suspend or reactivate SAF Team members" },
  { key: "platform.staff.assign", area: "SAF Team", description: "Assign SAF Team members to businesses, branches and modules" },
  { key: "platform.staff.permissions.manage", area: "SAF Team", description: "Configure platform roles and per-assignment permissions" },

  { key: "platform.support.read", area: "Support", description: "View support tickets" },
  { key: "platform.support.manage", area: "Support", description: "Reply to and update support tickets" },

  { key: "platform.audit.read", area: "Audit", description: "View audit logs" },

  { key: "platform.security.read", area: "Security", description: "View the Security Center: alerts, sign-in activity, sessions, MFA coverage" },
  { key: "platform.security.manage", area: "Security", description: "Revoke sessions, reset MFA and unlock accounts during security incidents" },

  { key: "platform.settings.read", area: "Settings", description: "View global settings and integration status" },
  { key: "platform.settings.manage", area: "Settings", description: "Change global settings" },
  { key: "platform.jobs.run", area: "Settings", description: "Run scheduled jobs manually" },
] as const satisfies readonly PlatformPermissionDef[];

export type PlatformPermissionKey = (typeof PLATFORM_PERMISSIONS)[number]["key"];

export const ALL_PLATFORM_PERMISSIONS: PlatformPermissionKey[] = PLATFORM_PERMISSIONS.map((p) => p.key);

export function isPlatformPermission(k: string): k is PlatformPermissionKey {
  return (ALL_PLATFORM_PERMISSIONS as string[]).includes(k);
}

const READ_ONLY = ALL_PLATFORM_PERMISSIONS.filter((k) => k.endsWith(".read"));

export interface PlatformRoleDef {
  code: string;
  name: string;
  description: string;
  /** true: sees every business. false: only businesses explicitly assigned. */
  allTenants: boolean;
  /** System roles cannot be deleted; SUPER_ADMIN cannot be edited at all. */
  isSystem: boolean;
  permissions: PlatformPermissionKey[];
}

export const SUPER_ADMIN_ROLE = "SUPER_ADMIN";

export const PLATFORM_ROLES: PlatformRoleDef[] = [
  {
    code: SUPER_ADMIN_ROLE, name: "Platform Super Admin", isSystem: true, allTenants: true,
    description: "Full control of SAF Flow, including SAF Team roles and permissions.",
    permissions: ALL_PLATFORM_PERMISSIONS,
  },
  {
    code: "PLATFORM_ADMIN", name: "Platform Administrator", isSystem: true, allTenants: true,
    description: "Runs the platform day to day. Cannot change platform roles.",
    permissions: ALL_PLATFORM_PERMISSIONS.filter((k) => k !== "platform.staff.permissions.manage"),
  },
  {
    code: "OPERATIONS_MANAGER", name: "Operations Manager", isSystem: true, allTenants: false,
    description: "Manages assigned clients: onboarding, configuration, accounts and support.",
    permissions: [
      "platform.dashboard.read", "platform.business.read", "platform.business.update", "platform.catalog.read",
      "platform.entitlements.manage", "platform.subscription.read", "platform.billing.read", "platform.users.read",
      "platform.users.manage", "platform.support.read", "platform.support.manage", "platform.audit.read",
    ],
  },
  {
    code: "CLIENT_SUCCESS", name: "Client Success Manager", isSystem: true, allTenants: false,
    description: "Looks after assigned clients' health, renewals and support.",
    permissions: [
      "platform.dashboard.read", "platform.business.read", "platform.catalog.read", "platform.subscription.read",
      "platform.billing.read", "platform.users.read", "platform.support.read", "platform.support.manage",
    ],
  },
  {
    code: "TECH_SUPPORT", name: "Technical Support", isSystem: true, allTenants: false,
    description: "Resolves assigned clients' technical issues and account problems.",
    permissions: [
      "platform.dashboard.read", "platform.business.read", "platform.catalog.read", "platform.users.read",
      "platform.users.manage", "platform.support.read", "platform.support.manage",
    ],
  },
  {
    code: "BILLING_MANAGER", name: "Billing Manager", isSystem: true, allTenants: false,
    description: "Handles invoices, payments and subscriptions for assigned clients.",
    permissions: [
      "platform.dashboard.read", "platform.business.read", "platform.catalog.read", "platform.subscription.read",
      "platform.subscription.manage", "platform.billing.read", "platform.billing.manage", "platform.revenue.read",
    ],
  },
  {
    code: "IMPLEMENTATION_EXEC", name: "Implementation Executive", isSystem: true, allTenants: false,
    description: "Onboards new clients and sets up their workspace. New businesses they create are assigned to them.",
    permissions: [
      "platform.dashboard.read", "platform.business.read", "platform.business.create", "platform.business.update",
      "platform.catalog.read", "platform.entitlements.manage", "platform.subscription.read", "platform.users.read",
      "platform.users.manage",
    ],
  },
  {
    code: "SECURITY_ADMIN", name: "Security Administrator", isSystem: true, allTenants: true,
    description: "Monitors platform security, investigates incidents, revokes sessions and resets MFA. No billing or catalog changes.",
    permissions: [
      "platform.dashboard.read", "platform.business.read", "platform.users.read", "platform.staff.read",
      "platform.audit.read", "platform.settings.read", "platform.security.read", "platform.security.manage",
    ],
  },
  {
    code: "AUDITOR", name: "Read-only Auditor", isSystem: true, allTenants: true,
    description: "Read-only access to every business, billing record and audit log.",
    permissions: READ_ONLY,
  },
];
