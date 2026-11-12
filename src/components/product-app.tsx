"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { PRODUCTS, type ProductCode } from "@/config/catalog";
import { PRODUCT_NAV } from "@/config/nav";
import { fmtDate } from "@/lib/dates";
import { setActiveBranch, useApi } from "@/lib/client";
import { asList, ProductContext, type ProductCtx, type ProductData } from "./product-context";
import { Notifications, Shell, UserMenu, themeVars, type ShellNavItem } from "./shell";
import { UpgradeNotice } from "./forms";
import { Badge, Button, Card, Empty, Notice, Select, Spinner } from "./ui";

export type ScreenComponent = ComponentType<{ rest: string[] }>;

function FullPage({ code, title, children }: { code: ProductCode; title: string; children: React.ReactNode }) {
  return (
    <div style={themeVars(PRODUCTS[code].theme)} className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wider text-brand">{PRODUCTS[code].name}</p>
        <h1 className="mt-2 text-lg font-semibold text-slate-900">{title}</h1>
        <div className="mt-2 text-sm text-slate-600">{children}</div>
        <Link href="/" className="mt-5 inline-flex h-10 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink">Back to applications</Link>
      </div>
    </div>
  );
}

export function ProductApp({ code, path, screens }: { code: ProductCode; path: string[]; screens: Record<string, ScreenComponent> }) {
  const router = useRouter();
  const slug = path[0] ?? "";
  const base = `/${code}`;
  const state = useApi<ProductData>(`/me/products/${code}`);
  const data = state.data;
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (state.error?.code === "PRODUCT_NOT_SUBSCRIBED") router.replace(`/activate/${code}`);
  }, [state.error, code, router]);

  const storageKey = data ? `saf.branch.${data.tenant.id}.${code}` : "";
  useEffect(() => {
    if (storageKey) setPicked(window.localStorage.getItem(storageKey));
  }, [storageKey]);

  const ctx = useMemo<ProductCtx | null>(() => {
    if (!data) return null;
    const main = data.branches.find((b) => b.isMain) ?? data.branches[0];
    const chosen = data.multiBranch ? data.branches.find((b) => b.id === picked) : undefined;
    const has = (f: string | readonly string[]) => asList(f).some((k) => data.features.includes(`${code}.${k}`));
    const can = (p: string | readonly string[]) => asList(p).some((k) => data.permissions.includes(`${code}.${k}`));
    return { ...data, code, base, has, can, branchId: (chosen ?? main)?.id ?? "", reload: state.reload };
  }, [data, picked, code, base, state.reload]);

  // Role landing: staff without the manager dashboard go to their own screen.
  const needsHome = !!ctx && slug === "" && !(ctx.has("dashboard") && ctx.can("dashboard.view"));
  const firstAllowed = useMemo(() => {
    if (!ctx) return null;
    for (const s of PRODUCT_NAV[code]) for (const i of s.items) if (i.slug && (!i.feature || ctx.has(i.feature)) && (!i.permission || ctx.can(i.permission))) return i.slug;
    return null;
  }, [ctx, code]);
  useEffect(() => {
    if (!needsHome || !ctx) return;
    const home = ctx.role?.homeScreen || firstAllowed;
    if (home) router.replace(`${base}/${home}`);
  }, [needsHome, ctx, firstAllowed, base, router]);

  if (state.error && !data) {
    const e = state.error;
    if (e.code === "PRODUCT_NOT_SUBSCRIBED" || e.status === 401) return <Spinner />;
    const title = e.code === "TENANT_SUSPENDED" ? "Account suspended" : e.code === "PRODUCT_ACCESS_DENIED" ? "No access to this application" : e.code === "PRODUCT_DISABLED" ? "Temporarily unavailable" : "Cannot open this application";
    return <FullPage code={code} title={title}>{e.message}</FullPage>;
  }
  if (!ctx) return <div style={themeVars(PRODUCTS[code].theme)}><Spinner label={`Opening ${PRODUCTS[code].name}`} /></div>;

  setActiveBranch(ctx.branchId || null);

  const moduleKeys = new Set(PRODUCTS[code].features.map((f) => f.key.slice(code.length + 1)));
  const seesBilling = ctx.can("subscription.view");
  const sections = PRODUCT_NAV[code]
    .map((s) => ({
      title: s.title,
      items: s.items.flatMap<ShellNavItem>((i) => {
        const feats = asList(i.feature);
        if (feats.length && !feats.some((f) => moduleKeys.has(f))) return []; // this product has no such module
        if (i.permission && !ctx.can(i.permission)) return [];
        if (feats.length && !ctx.has(feats)) return seesBilling ? [{ ...i, locked: true }] : [];
        return [i];
      }),
    }))
    .filter((s) => s.items.length);

  const sub = ctx.subscription;
  const usable = sub?.state === "ACTIVE" || sub?.state === "GRACE";
  const navItem = PRODUCT_NAV[code].flatMap((s) => s.items).find((i) => i.slug === slug);
  const Screen = screens[`${code}/${slug}`] ?? screens[`*/${slug}`];

  let body: React.ReactNode;
  if (!usable && slug !== "subscription" && slug !== "support") {
    body = (
      <Card>
        <Empty
          title={sub?.state === "EXPIRED" ? `Your ${ctx.product.name} subscription has expired` : `Your ${ctx.product.name} subscription is ${sub?.state.toLowerCase() ?? "inactive"}`}
          hint={seesBilling ? "Renew to restore access for your whole team. Your data is safe." : "Please ask your manager to renew the subscription."}
          action={seesBilling ? <Link href={`${base}/subscription`} className="inline-flex h-10 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink">View subscription</Link> : undefined}
        />
      </Card>
    );
  } else if (needsHome && (ctx.role?.homeScreen || firstAllowed)) {
    body = <Spinner />;
  } else if (!Screen) {
    body = <Card><Empty title="Page not found" hint="This screen does not exist." action={<Link className="text-sm font-medium text-brand underline" href={base}>Go to the home screen</Link>} /></Card>;
  } else if (navItem?.permission && !ctx.can(navItem.permission)) {
    body = <Card><Empty title="You do not have access to this screen" hint={`Your role (${ctx.role?.name}) does not include ${navItem.label}. Ask your manager if you need it.`} /></Card>;
  } else if (navItem?.feature && !ctx.has(navItem.feature)) {
    body = <UpgradeNotice feature={navItem.label} />;
  } else {
    body = <Screen key={ctx.branchId} rest={path.slice(1)} />;
  }

  const banner = (
    <>
      {sub?.state === "GRACE" && (
        <Notice tone="warn" title="Subscription expired - grace period" action={seesBilling ? <Link href={`${base}/subscription`}><Button size="sm">Renew</Button></Link> : undefined}>
          {ctx.product.name} expired on {fmtDate(sub.currentPeriodEnd)}. Access continues until {fmtDate(sub.graceEndsAt)}.
        </Notice>
      )}
      {sub?.state === "ACTIVE" && sub.daysLeft <= 7 && seesBilling && (
        <Notice tone="info" action={<Link href={`${base}/subscription`}><Button size="sm">View</Button></Link>}>
          Your {ctx.product.name} subscription renews in {Math.max(0, sub.daysLeft)} day{sub.daysLeft === 1 ? "" : "s"} ({fmtDate(sub.currentPeriodEnd)}).
        </Notice>
      )}
    </>
  );

  return (
    <ProductContext.Provider value={ctx}>
      <Shell
        theme={PRODUCTS[code].theme}
        appName={ctx.product.name}
        appTag={ctx.product.tagline}
        base={base}
        sections={sections}
        activeSlug={slug}
        banner={banner}
        top={
          <>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 truncate text-sm font-semibold text-slate-900">
                <span className="truncate">{ctx.tenant.name}</span>
                {sub && <Badge tone={sub.tier === "GROWTH" ? "brand" : "neutral"}>{sub.planName}</Badge>}
              </p>
            </div>
            {ctx.multiBranch && ctx.branches.length > 1 && (
              <Select
                aria-label="Branch" className="!h-9 w-36 sm:w-44" value={ctx.branchId}
                onChange={(e) => {
                  window.localStorage.setItem(storageKey, e.target.value);
                  setPicked(e.target.value);
                }}
              >
                {ctx.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            )}
            <Notifications />
            <UserMenu name={ctx.user.fullName} sub={`${ctx.role?.name ?? ""} - ${ctx.user.username}`} />
          </>
        }
      >
        {body}
      </Shell>
    </ProductContext.Provider>
  );
}
