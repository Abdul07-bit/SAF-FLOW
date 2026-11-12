"use client";

import { useState } from "react";
import { api, errorMessage, useApi } from "@/lib/client";
import { signOut } from "@/components/shell";
import { Button, Field, Input, Notice } from "@/components/ui";

export default function ChangePasswordPage() {
  const me = useApi<{ user: { username: string; mustChangePassword: boolean; kind: string } }>("/me");
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const forced = me.data?.user.mustChangePassword;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirm) return setError("The new passwords do not match.");
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ redirect: string }>("/auth/change-password", { body: { currentPassword, newPassword } });
      window.location.href = res.redirect;
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{forced ? "Set your own password" : "Change password"}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {forced ? "You signed in with a temporary password. Choose a new one to continue." : "Other devices will be signed out."}
          {me.data && <> Login ID: <span className="font-medium text-slate-800">{me.data.user.username}</span></>}
        </p>
        <div className="mt-5 space-y-4">
          <Field label={forced ? "Temporary password" : "Current password"} required>
            <Input type="password" autoComplete="current-password" required autoFocus value={currentPassword} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password" required help="At least 8 characters with letters and numbers.">
            <Input type="password" autoComplete="new-password" required minLength={8} value={newPassword} onChange={(e) => setNew(e.target.value)} />
          </Field>
          <Field label="Confirm new password" required>
            <Input type="password" autoComplete="new-password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          {error && <Notice tone="bad">{error}</Notice>}
          <Button type="submit" variant="primary" className="w-full" loading={busy}>Save password</Button>
          {forced ? (
            <Button variant="ghost" className="w-full" onClick={signOut}>Sign out</Button>
          ) : (
            <Button variant="ghost" className="w-full" onClick={() => window.history.back()}>Cancel</Button>
          )}
        </div>
      </form>
    </main>
  );
}
