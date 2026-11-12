"use client";

import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { PLATFORM_THEME } from "@/config/catalog";
import { ADMIN_NAV } from "@/config/nav";
import { useApi } from "@/lib/client";
import { AdminBusinessDetail, AdminBusinesses, AdminNewBusiness, AdminOverview } from "@/screens/admin-core";
import { AdminFeatures, AdminInvoice, AdminPayments, AdminPlans, AdminProducts, AdminRevenue, AdminSubscriptions } from "@/screens/admin-commercial";
import { AdminAudit, AdminEmployees, AdminManagers, AdminSettings, AdminSupport } from "@/screens/admin-ops";
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
  }
  if (b) return null;
  const simple: Record<string, ReactNode> = {
    products: <AdminProducts />, subscriptions: <AdminSubscriptions />, plans: <AdminPlans />, features: <AdminFeatures />, payments: <AdminPayments />,
    revenue: <AdminRevenue />, managers: <AdminManagers />, employees: <AdminEmployees />, support: <AdminSupport />, audit: <AdminAudit />, settings: <AdminSettings />,
  };
  return a in simple ? { node: simple[a], active: a } : null;
}

/**
 * SAF Super Admin application. The redirect for non-platform users is a
 * convenience only: every /api/admin/* route requires a platform session.
 */
export function AdminApp({ path }: { path: string[] }) {
  const me = useApi<{ user: { kind: string; fullName: string; username: string } }>("/me");
  const isPlatform = me.data?.user.kind === "PLATFORM";

  useEffect(() => {
    if (me.data && !isPlatform) window.location.replace("/");
  }, [me.data, isPlatform]);

  if (!me.data || !isPlatform) return <div style={themeVars(PLATFORM_THEME)}><Spinner label="Opening SAF Super Admin" /></div>;

  const screen = screenFor(path);
  return (
    <Shell
      theme={PLATFORM_THEME} appName="SAF Super Admin" appTag="SMARTAUTO FLEX platform" base="/admin" sections={ADMIN_NAV} activeSlug={screen?.active ?? ""}
      top={
        <>
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">SMARTAUTO FLEX</p>
          <UserMenu name={me.data.user.fullName} sub={`Super Admin - ${me.data.user.username}`} showPortal={false} />
        </>
      }
    >
      {screen?.node ?? <Card><Empty title="Page not found" hint="This screen does not exist." action={<Link className="text-sm font-medium text-brand underline" href="/admin">Go to the overview</Link>} /></Card>}
    </Shell>
  );
}
