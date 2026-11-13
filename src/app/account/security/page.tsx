"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { api, errorMessage, useApi } from "@/lib/client";
import { signOut } from "@/components/shell";
import { SafLogo } from "@/components/brand";
import { Badge, Button, Card, Field, Input, Notice, Spinner } from "@/components/ui";
import { fmtDateTime } from "@/lib/dates";

interface Status { enabled: boolean; enabledAt: string | null; required: boolean; recoveryCodesLeft: number }

/** Personal security: set up, use and manage two-step verification (TOTP). */
export default function AccountSecurityPage() {
  const me = useApi<{ user: { kind: string; fullName: string; username: string } }>("/me");
  const st = useApi<Status>("/auth/mfa");
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const forced = params?.get("required") === "1";
  const usedRecovery = params?.get("recovery") === "1";
  const home = me.data?.user.kind === "PLATFORM" ? "/admin" : "/";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const start = () => run(async () => setSetup(await api("/auth/mfa/setup", { method: "POST" })));
  const enable = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const r = await api<{ recoveryCodes: string[] }>("/auth/mfa/enable", { body: { code } });
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode("");
      await st.reload();
    });
  };
  const regenerate = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const r = await api<{ recoveryCodes: string[] }>("/auth/mfa/recovery-codes", { body: { code } });
      setCodes(r.recoveryCodes);
      setCode("");
      await st.reload();
    });
  };
  const disable = () => run(async () => {
    await api("/auth/mfa/disable", { body: { code } });
    setCode("");
    await st.reload();
  });

  const s = st.data;
  return (
    <main className="mx-auto max-w-xl p-4 sm:p-8">
      <div className="mb-6 flex items-center justify-between">
        <SafLogo className="h-8" />
        {s?.enabled || !forced ? (
          <Link href={home} className="flex items-center gap-1 text-sm font-medium text-brand"><ArrowLeft className="h-4 w-4" /> Back</Link>
        ) : (
          <Button variant="ghost" onClick={signOut}>Sign out</Button>
        )}
      </div>
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-slate-900"><ShieldCheck className="h-6 w-6 text-brand" aria-hidden /> Two-step verification</h1>
      <p className="mt-1 text-sm text-slate-600">After your password, SAF Flow asks for a 6-digit code from an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, Authy, 1Password...). A stolen password alone is then not enough to get in.</p>

      <div className="mt-6 space-y-4">
        {forced && !s?.enabled && <Notice tone="warn" title="Required for your account">Your account must use two-step verification. Set it up below to continue.</Notice>}
        {usedRecovery && <Notice tone="warn" title="You signed in with a recovery code">That code no longer works. If you lost your phone, create new recovery codes below and set up the authenticator again with SAF support.</Notice>}
        {!s ? <Spinner /> : codes ? (
          <Card title="Save your recovery codes" subtitle="Each code signs you in once if you lose your phone. They are shown only now.">
            <ul className="grid grid-cols-2 gap-2 font-mono text-sm">
              {codes.map((c) => <li key={c} className="rounded-lg bg-slate-100 px-3 py-2 text-center">{c}</li>)}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => navigator.clipboard?.writeText(codes.join("\n"))}>Copy</Button>
              <Button variant="primary" onClick={() => { setCodes(null); if (forced) window.location.href = home; }}>I have saved them</Button>
            </div>
          </Card>
        ) : s.enabled ? (
          <Card title={<span className="flex items-center gap-2">Status <Badge tone="good">On</Badge></span>} subtitle={`Turned on ${fmtDateTime(s.enabledAt)}. ${s.recoveryCodesLeft} recovery code(s) left.`}>
            <form onSubmit={regenerate} className="space-y-3">
              <Field label="Current authenticator code" help="Needed to create new recovery codes or to turn two-step verification off." required>
                <Input inputMode="numeric" autoComplete="one-time-code" maxLength={7} required value={code} onChange={(e) => setCode(e.target.value)} />
              </Field>
              {error && <Notice tone="bad">{error}</Notice>}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" loading={busy}>New recovery codes</Button>
                {!s.required && <Button variant="danger" loading={busy} onClick={disable}>Turn off</Button>}
              </div>
              {s.required && <p className="text-xs text-slate-500">Two-step verification is required for your account and cannot be turned off.</p>}
            </form>
          </Card>
        ) : setup ? (
          <Card title="Scan this QR code" subtitle="Use your authenticator app's 'Add account' / scan option.">
            <form onSubmit={enable} className="space-y-4">
              <img src={setup.qrDataUrl} alt="QR code for your authenticator app" className="mx-auto h-52 w-52 rounded-lg border border-slate-200" />
              <p className="text-center text-xs text-slate-500">Cannot scan? Enter this key: <span className="select-all break-all font-mono text-slate-800">{setup.secret}</span></p>
              <Field label="Code shown in the app" required>
                <Input inputMode="numeric" autoComplete="one-time-code" maxLength={7} required autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
              </Field>
              {error && <Notice tone="bad">{error}</Notice>}
              <Button type="submit" variant="primary" className="w-full" loading={busy}>Turn on two-step verification</Button>
            </form>
          </Card>
        ) : (
          <Card title={<span className="flex items-center gap-2">Status <Badge tone="warn">Off</Badge></span>}>
            {error && <div className="mb-3"><Notice tone="bad">{error}</Notice></div>}
            <Button variant="primary" loading={busy} onClick={start}>Set up an authenticator app</Button>
          </Card>
        )}
      </div>
    </main>
  );
}
