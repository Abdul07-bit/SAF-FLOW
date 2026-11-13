"use client";

import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { PLATFORM_THEME } from "@/config/catalog";
import { ADMIN_NAV } from "@/config/nav";
import { useApi } from "@/lib/client";
import { AdminBusinessDetail, AdminBusinesses, AdminNewBusiness, AdminOverview } from "@/screens/admin-core";
import { AdminFeatures, AdminInvoice, AdminPayments, AdminPlans, AdminProducts, AdminRevenue, AdminSubscriptions } from "@/screens/admin-commercial";
import { AdminAudit, AdminEmployees, AdminManagers, AdminSettings, AdminSupport, AdminSystemHealth } from "@/screens/admin-ops";
import { AdminRoles, AdminTeam, AdminTeamMember } from "@/screens/admin-team";
import { Shell, UserMenu, themeVars } from "./shell";
import { Card, Empty, Spinner } from "./ui";

function screenFor(path: string[]): { node: ReactNode; active: string } | null {
  const [a = "", b] = path;
  if (path.length > 2) return null;
  switch (a) {
    case "": return { node: <AdminOverview />, active: "" };
    case "businesses":
      if (b === "new") return { node: <AdminNewBusiness />, active: "businesses/new" };
      return { node: b ? <AdminBusinessDetail key={b} id={b} /> : <AdminBusinesses />, active: "businesses" };
    case "invoices": return b ? { node: <AdminInvoice key={b} id={b} />, active: "payments" } : null;
    case "team": return { node: b ? <AdminTeamMember key={b} id={b} /> : <AdminTeam />, active: "team" };
  }
  if (b) return null;
  const simple: Record<string, ReactNode> = {
    products: <AdminProducts />, subscriptions: <AdminSubscriptions />, plans: <AdminPlans />, features: <AdminFeatures />, payments: <AdminPayments />,
    revenue: <AdminRevenue />, managers: <AdminManagers />, employees: <AdminEmployees />, support: <AdminSupport />, audit: <AdminAudit />,
    settings: <AdminSettings />, roles: <AdminRoles />, system: <AdminSystemHealth />,
  };
  return a in simple ? { node: simple[a], active: a } : null;
}

/**
 * SAF Flow administration (SmartAutoFlex team). The menu only lists what the
 * member's platform role allows; the API enforces the same permissions on
 * every request, so hiding is a convenience, not the security boundary.
 */
export function AdminApp({ path }: { path: string[] }) {
  const me = useApi<{ user: { kind: string; fullName: string; username: string } }>("/me");
  const isPlatform = me.data?.user.kind === "PLATFORM";
  const scope = useApi<{ role: { name: string; allTenants: boolean } | null; permissions: string[] }>(isPlatform ? "/admin/me" : null);

  useEffect(() => {
    if (me.data && !isPlatform) window.location.replace("/");
  }, [me.data, isPlatform]);

  if (!me.data || !isPlatform || (!scope.data && !scope.error)) return <div style={themeVars(PLATFORM_THEME)}><Spinner label="Opening SAF Flow admin" /></div>;

  const perms = new Set(scope.data?.permissions ?? []);
  const sections = ADMIN_NAV
    .map((s) => ({ ...s, items: s.items.filter((i) => !i.platform || perms.has(i.platform)) }))
    .filter((s) => s.items.length);
  const screen = screenFor(path);
  const roleName = scope.data?.role?.name ?? "No role";
  const scopeNote = scope.data?.role ? (scope.data.role.allTenants ? "all businesses" : "assigned businesses") : "no access";

  return (
    <Shell
      theme={PLATFORM_THEME} appName="SAF Flow Admin" appTag="SmartAutoFlex platform" base="/admin" sections={sections} activeSlug={screen?.active ?? ""}
      top={
        <>
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">SAF Flow <span className="font-normal text-slate-500">· {scopeNote}</span></p>
          <UserMenu name={me.data.user.fullName} sub={`${roleName} - ${me.data.user.username}`} showPortal={false} />
        </>
      }
    >
      {!scope.data?.role ? (
        <Card><Empty title="No platform role" hint="Ask a SAF Flow administrator to give your account a role." /></Card>
      ) : screen?.node ?? <Card><Empty title="Page not found" hint="This screen does not exist." action={<Link className="text-sm font-medium text-brand underline" href="/admin">Go to the overview</Link>} /></Card>}
    </Shell>
  );
}
