"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api, errorMessage } from "@/lib/client";
import { SafLogo } from "@/components/brand";
import { Button, Field, Input, Notice } from "@/components/ui";

/** Second step of signing in when two-step verification is on. */
export default function MfaPage() {
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ redirect: string; usedRecoveryCode: boolean }>("/auth/mfa/verify", { body: { code }, noRedirect: true });
      window.location.href = res.usedRecoveryCode ? "/account/security?recovery=1" : res.redirect;
    } catch (err) {
      const msg = errorMessage(err);
      // The attempt ended (too many wrong codes or it expired): start again.
      if ((err as { status?: number }).status === 401 && !/not correct/.test(msg)) window.location.href = "/login";
      setError(msg);
      setBusy(false);
    }
  };

  const signOut = async () => {
    await api("/auth/logout", { method: "POST", noRedirect: true }).catch(() => undefined);
    window.location.href = "/login";
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <SafLogo className="h-8" />
        <h1 className="mt-5 flex items-center gap-2 text-xl font-semibold tracking-tight text-slate-900">
          <ShieldCheck className="h-5 w-5 text-brand" aria-hidden /> Two-step verification
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {useRecovery ? "Enter one of the recovery codes you saved when you turned on two-step verification. Each code works once." : "Open your authenticator app and enter the 6-digit code for SAF Flow."}
        </p>
        <div className="mt-5 space-y-4">
          <Field label={useRecovery ? "Recovery code" : "Authentication code"} required>
            <Input
              required autoFocus value={code} onChange={(e) => setCode(e.target.value)}
              {...(useRecovery
                ? { autoComplete: "off", placeholder: "xxxxx-xxxxx", maxLength: 20 }
                : { inputMode: "numeric" as const, autoComplete: "one-time-code", pattern: "[0-9 ]{6,7}", maxLength: 7, placeholder: "123456" })}
            />
          </Field>
          {error && <Notice tone="bad">{error}</Notice>}
          <Button type="submit" variant="primary" className="w-full" loading={busy}>Verify</Button>
          <Button variant="ghost" className="w-full" onClick={() => { setUseRecovery((v) => !v); setCode(""); setError(null); }}>
            {useRecovery ? "Use my authenticator app instead" : "Lost your phone? Use a recovery code"}
          </Button>
          <Button variant="ghost" className="w-full" onClick={signOut}>Cancel and sign out</Button>
        </div>
      </form>
    </main>
  );
}
