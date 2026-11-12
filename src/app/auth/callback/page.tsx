"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/client";
import { Button, Field, Input, Notice } from "@/components/ui";

/**
 * Landing page for Supabase invitation and password-reset emails.
 * Supabase puts a short-lived access token in the URL fragment (never sent to
 * any server by the browser). This page removes it from the address bar,
 * keeps it in memory only, and hands it to the SAF API, which verifies it
 * with Supabase before anything happens.
 */
type Info = { purpose: "invite" | "recovery"; email: string; fullName: string; organization: string | null };

export default function AuthCallbackPage() {
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, "", window.location.pathname);
    const desc = params.get("error_description");
    if (desc) return setError(`${desc.replace(/\+/g, " ")}. Ask for a new link.`);
    const t = params.get("access_token");
    if (!t) return setError("This link is incomplete or has already been used. Ask for a new one.");
    setToken(t);
    api<Info>("/auth/link/inspect", { body: { accessToken: t } }).then(setInfo, (e) => setError(errorMessage(e)));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError("The passwords do not match.");
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ redirect: string }>("/auth/link/complete", { body: { accessToken: token, password } });
      window.location.href = res.redirect;
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const invite = info?.purpose === "invite";
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{invite ? "Welcome to SAF Flow" : "Choose a new password"}</h1>
        {info && (
          <p className="mt-1 text-sm text-slate-600">
            {invite ? <>Hi {info.fullName}, set a password to activate your account{info.organization ? <> for <span className="font-medium text-slate-800">{info.organization}</span></> : null}.</> : null}
            {" "}You will sign in with <span className="font-medium text-slate-800">{info.email}</span>.
          </p>
        )}
        <div className="mt-5 space-y-4">
          {!info && !error && <p className="text-sm text-slate-500">Checking your link...</p>}
          {info && (
            <>
              <Field label="New password" required help="At least 8 characters with letters and numbers.">
                <Input type="password" autoComplete="new-password" required minLength={8} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <Field label="Confirm new password" required>
                <Input type="password" autoComplete="new-password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </Field>
            </>
          )}
          {error && <Notice tone="bad">{error}</Notice>}
          {info && <Button type="submit" variant="primary" className="w-full" loading={busy}>{invite ? "Activate account" : "Save password"}</Button>}
          <p className="text-sm"><a href="/login" className="font-medium text-brand hover:underline">Back to sign in</a></p>
        </div>
      </form>
    </main>
  );
}
