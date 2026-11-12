"use client";

import { useState } from "react";
import { BedDouble, ScanBarcode, ShieldCheck, UtensilsCrossed } from "lucide-react";
import { PRODUCT_LIST } from "@/config/catalog";
import { api, errorMessage } from "@/lib/client";
import { Button, Field, Input, Notice } from "@/components/ui";

const ICONS = { dine: UtensilsCrossed, stay: BedDouble, bill: ScanBarcode } as const;

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ redirect: string; mustChangePassword: boolean }>("/auth/login", { body: { username, password }, noRedirect: true });
      const next = new URLSearchParams(window.location.search).get("next");
      // Only follow same-site relative paths.
      const safeNext = next && /^\/(?!\/)[\w\-/[\].]*$/.test(next) ? next : null;
      window.location.href = res.mustChangePassword ? res.redirect : res.redirect === "/admin" ? "/admin" : safeNext ?? res.redirect;
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden flex-col justify-between bg-sidebar p-10 text-white lg:flex">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/15 text-sm font-bold">SAF</span>
          <span className="text-lg font-semibold tracking-tight">SMARTAUTO FLEX</span>
        </div>
        <div>
          <h1 className="max-w-md text-3xl font-semibold leading-tight tracking-tight">One account for your restaurant, hotel and shop.</h1>
          <p className="mt-3 max-w-md text-sm text-sidebar-ink">Sign in once and open every SAF application your business has subscribed to.</p>
          <ul className="mt-8 space-y-3">
            {PRODUCT_LIST.map((p) => {
              const Icon = ICONS[p.code];
              return (
                <li key={p.code} className="flex items-center gap-3 rounded-xl bg-white/5 px-4 py-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: p.theme.brand }}><Icon className="h-4 w-4" aria-hidden /></span>
                  <span>
                    <span className="block text-sm font-semibold">{p.name}</span>
                    <span className="block text-xs text-sidebar-muted">{p.tagline}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
        <p className="flex items-center gap-2 text-xs text-sidebar-muted"><ShieldCheck className="h-4 w-4" aria-hidden /> Your business data is isolated from every other business.</p>
      </section>

      <main className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2 lg:hidden">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand text-xs font-bold text-brand-ink">SAF</span>
            <span className="text-base font-semibold">SMARTAUTO FLEX</span>
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Sign in</h2>
          <p className="mt-1 text-sm text-slate-600">Use the login ID given by your manager, for example <span className="font-medium text-slate-800">SGV@manager</span>.</p>
          <div className="mt-6 space-y-4">
            <Field label="Login ID" required>
              <Input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} placeholder="BUSINESSCODE@name" />
            </Field>
            <Field label="Password" required>
              <Input name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error && <Notice tone="bad">{error}</Notice>}
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Sign in</Button>
          </div>
          <p className="mt-6 text-xs text-slate-500">Forgot your password? Ask your manager to reset it. Managers can contact SMARTAUTO FLEX support.</p>
        </form>
      </main>
    </div>
  );
}
