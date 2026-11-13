"use client";

import { SafLogo } from "@/components/brand";
import Link from "next/link";
import { useEffect } from "react";
import { ArrowRight, BedDouble, Lock, ScanBarcode, UtensilsCrossed } from "lucide-react";
import { PRODUCTS, type ProductCode } from "@/config/catalog";
import { fmtDate } from "@/lib/dates";
import { useApi } from "@/lib/client";
import { UserMenu, themeVars } from "@/components/shell";
import { Badge, Notice, Spinner, StatusBadge } from "@/components/ui";

const ICONS = { dine: UtensilsCrossed, stay: BedDouble, bill: ScanBarcode } as const;

interface PortalProduct {
  code: ProductCode;
  name: string;
  tagline: string;
  productActive: boolean;
  subscription: { tier: string; planName: string; state: string; billingCycle: string; currentPeriodEnd: string; daysLeft: number } | null;
  role: { code: string; name: string; homeScreen: string } | null;
}

export default function PortalPage() {
  const me = useApi<{ user: any; tenant: any; products: PortalProduct[] | null }>("/me");

  useEffect(() => {
    if (me.data?.user.kind === "PLATFORM") window.location.replace("/admin");
  }, [me.data]);

  if (!me.data || me.data.user.kind === "PLATFORM") return <Spinner />;
  const { user, tenant, products } = me.data;

  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <SafLogo className="h-8" decorative />
          <span className="text-sm font-semibold tracking-tight text-slate-900">SAF Flow</span>
        </div>
        <UserMenu name={user.fullName} sub={user.username} showPortal={false} />
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Welcome to SAF Flow</h1>
        <p className="mt-1 text-sm text-slate-600">{tenant?.name} - choose an application to open.</p>
        {tenant?.status !== "ACTIVE" && (
          <div className="mt-4"><Notice tone="bad" title="This business account is suspended">Please contact SmartAutoFlex support.</Notice></div>
        )}

        <h2 className="mt-8 text-xs font-semibold uppercase tracking-wider text-slate-500">Available applications</h2>
        <ul className="mt-3 grid gap-4 md:grid-cols-3">
          {products?.map((p) => {
            const Icon = ICONS[p.code];
            const sub = p.subscription;
            const usable = sub && (sub.state === "ACTIVE" || sub.state === "GRACE");
            const canOpen = !!sub && !!p.role && p.productActive;
            const href = !sub ? `/activate/${p.code}` : `/${p.code}`;
            return (
              <li key={p.code} style={themeVars(PRODUCTS[p.code].theme)}>
                <Link
                  href={canOpen || !sub ? href : "#"}
                  aria-disabled={!!sub && !canOpen}
                  className={`group flex h-full flex-col rounded-2xl border bg-white p-5 shadow-sm transition ${sub ? "border-slate-200 hover:border-brand hover:shadow-md" : "border-dashed border-slate-300 hover:border-slate-400"} ${sub && !canOpen ? "pointer-events-none opacity-60" : ""}`}
                >
                  <span className={`flex h-11 w-11 items-center justify-center rounded-xl ${sub ? "bg-brand text-brand-ink" : "bg-slate-100 text-slate-500"}`}><Icon className="h-5 w-5" aria-hidden /></span>
                  <span className="mt-4 block text-base font-semibold text-slate-900">{p.name}</span>
                  <span className="mt-0.5 block text-sm text-slate-600">{p.tagline}</span>
                  <span className="mt-4 flex flex-wrap items-center gap-1.5">
                    {sub ? (
                      <>
                        <StatusBadge value={sub.state} label={sub.state === "GRACE" ? "Grace period" : undefined} />
                        <Badge tone={sub.tier === "GROWTH" ? "brand" : "neutral"}>{sub.planName}</Badge>
                      </>
                    ) : (
                      <Badge><Lock className="h-3 w-3" aria-hidden /> Not subscribed</Badge>
                    )}
                  </span>
                  <span className="mt-2 block min-h-9 text-xs text-slate-500">
                    {!sub ? "Add this application to your SAF account." : !p.productActive ? "Temporarily unavailable." : !p.role ? "Your account has no access. Ask your manager." : usable ? `Signed in as ${p.role.name}. ${sub.state === "GRACE" ? "Expired" : "Renews"} ${fmtDate(sub.currentPeriodEnd)}.` : "Subscription needs attention."}
                  </span>
                  <span className={`mt-3 flex items-center gap-1 text-sm font-medium ${sub ? "text-brand" : "text-slate-700"}`}>
                    {!sub ? "View plans" : usable ? "Open" : "View subscription"} <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" aria-hidden />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </main>
    </div>
  );
}
