"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Bell, ChevronDown, Grid2x2, KeyRound, Lock, LogOut, Menu, ShieldCheck, Smartphone, X } from "lucide-react";
import type { ProductTheme } from "@/config/catalog";
import type { NavItem, NavSection } from "@/config/nav";
import { fmtDateTime } from "@/lib/dates";
import { api, useApi } from "@/lib/client";
import { cx } from "./ui";
import { SafLogo } from "./brand";

export function themeVars(t: ProductTheme): CSSProperties {
  return {
    "--brand": t.brand, "--brand-ink": t.brandInk, "--brand-soft": t.brandSoft, "--accent": t.accent,
    "--sidebar": t.sidebar, "--sidebar-ink": t.sidebarInk, "--sidebar-muted": t.sidebarMuted,
  } as CSSProperties;
}

export async function signOut() {
  try {
    await api("/auth/logout", { method: "POST", noRedirect: true });
  } finally {
    window.location.href = "/login";
  }
}

function useClickAway(onAway: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onAway();
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onAway]);
  return ref;
}

export function UserMenu({ name, sub, showPortal = true }: { name: string; sub: string; showPortal?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu" className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-slate-100">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-sm font-semibold text-brand-ink" aria-hidden>{name.slice(0, 1).toUpperCase()}</span>
        <span className="hidden min-w-0 sm:block">
          <span className="block max-w-40 truncate text-sm font-medium text-slate-900">{name}</span>
          <span className="block max-w-40 truncate text-xs text-slate-500">{sub}</span>
        </span>
        <ChevronDown className="h-4 w-4 text-slate-500" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-1 w-56 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
          {showPortal && <Link role="menuitem" href="/" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"><Grid2x2 className="h-4 w-4" /> All applications</Link>}
          <Link role="menuitem" href="/change-password" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"><KeyRound className="h-4 w-4" /> Change password</Link>
          <Link role="menuitem" href="/account/security" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"><ShieldCheck className="h-4 w-4" /> Two-step verification</Link>
          <Link role="menuitem" href="/download" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"><Smartphone className="h-4 w-4" /> Get the app</Link>
          <button role="menuitem" onClick={signOut} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-700 hover:bg-red-50"><LogOut className="h-4 w-4" /> Sign out</button>
        </div>
      )}
    </div>
  );
}

export function Notifications() {
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  const n = useApi<{ items: any[]; unread: number }>("/me/notifications", { refreshMs: 60_000 });
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && n.data?.unread) {
      await api("/me/notifications/read-all", { method: "POST" }).catch(() => undefined);
      n.setData({ items: n.data.items, unread: 0 });
    }
  };
  return (
    <div className="relative" ref={ref}>
      <button onClick={toggle} aria-label={`Notifications${n.data?.unread ? `, ${n.data.unread} unread` : ""}`} className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100">
        <Bell className="h-5 w-5" />
        {!!n.data?.unread && <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">{n.data.unread}</span>}
      </button>
      {open && (
        <div className="fixed inset-x-3 top-14 z-40 max-h-[70vh] overflow-y-auto sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-1 sm:max-h-96 sm:w-80 rounded-xl border border-slate-200 bg-white shadow-lg">
          <p className="border-b border-slate-100 px-4 py-2 text-sm font-semibold text-slate-900">Notifications</p>
          {!n.data?.items.length && <p className="px-4 py-6 text-center text-sm text-slate-500">You are all caught up.</p>}
          {n.data?.items.map((i) => (
            <a key={i.id} href={i.link ?? "#"} className="block border-b border-slate-50 px-4 py-2.5 hover:bg-slate-50">
              <p className="text-sm font-medium text-slate-900">{i.title}</p>
              <p className="mt-0.5 text-xs text-slate-600">{i.body}</p>
              <p className="mt-1 text-[11px] text-slate-400">{fmtDateTime(i.createdAt)}</p>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export interface ShellNavItem extends NavItem {
  locked?: boolean;
}

export function Shell({ theme, appName, appTag, base, sections, activeSlug, top, banner, children }: {
  theme: ProductTheme;
  appName: string;
  appTag: string;
  base: string;
  sections: { title: string; items: ShellNavItem[] }[];
  activeSlug: string;
  /** Right side of the top bar (branch switcher, bell, user menu). */
  top: ReactNode;
  banner?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [activeSlug]);
  const href = (slug: string) => (slug ? `${base}/${slug}` : base || "/");

  const nav = (
    <nav aria-label={`${appName} navigation`} className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {sections.map((s) => (
        <div key={s.title}>
          <p className="px-2 text-[11px] font-semibold uppercase tracking-wider text-sidebar-muted">{s.title}</p>
          <ul className="mt-1.5 space-y-0.5">
            {s.items.map((i) => {
              const active = i.slug === activeSlug;
              return (
                <li key={i.slug}>
                  <Link
                    href={i.locked ? `${base}/subscription` : href(i.slug)}
                    aria-current={active ? "page" : undefined}
                    title={i.locked ? "Available on the Growth plan" : undefined}
                    className={cx(
                      "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition",
                      active ? "bg-white/15 font-semibold text-white" : i.locked ? "text-sidebar-muted hover:bg-white/5" : "text-sidebar-ink hover:bg-white/10",
                    )}
                  >
                    <i.icon className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{i.label}</span>
                    {i.locked && <><Lock className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="sr-only">(Growth plan)</span></>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  const brand = (
    <div className="flex items-center gap-2.5 border-b border-white/10 px-4 py-3.5">
      <SafLogo tone="light" className="h-7" decorative />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-white">{appName}</span>
        <span className="block truncate text-[11px] text-sidebar-muted">{appTag}</span>
      </span>
    </div>
  );

  return (
    <div style={themeVars(theme)} className="min-h-screen">
      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-60 flex-col bg-sidebar lg:flex">{brand}{nav}</aside>
      {open && (
        <div className="no-print fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col bg-sidebar shadow-xl">
            <button onClick={() => setOpen(false)} aria-label="Close menu" className="absolute right-2 top-3 rounded-md p-1 text-white/80 hover:bg-white/10"><X className="h-5 w-5" /></button>
            {brand}{nav}
          </aside>
        </div>
      )}
      <div className="lg:pl-60">
        <header className="no-print sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-slate-200 bg-white/95 px-3 backdrop-blur sm:px-5">
          <button onClick={() => setOpen(true)} aria-label="Open menu" className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"><Menu className="h-5 w-5" /></button>
          {top}
        </header>
        {banner && <div className="no-print space-y-2 px-3 pt-3 sm:px-5">{banner}</div>}
        <main className="mx-auto max-w-[1400px] px-3 py-5 sm:px-5">{children}</main>
      </div>
    </div>
  );
}
