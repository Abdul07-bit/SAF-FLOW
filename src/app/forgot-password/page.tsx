"use client";

import { useState } from "react";
import { api, errorMessage } from "@/lib/client";
import { Button, Field, Input, Notice } from "@/components/ui";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>("/auth/password-reset", { body: { email } });
      setSent(res.message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Reset your password</h1>
        <p className="mt-1 text-sm text-slate-600">Enter the email address you sign in with. We will email you a link to choose a new password.</p>
        <div className="mt-5 space-y-4">
          {sent ? (
            <Notice tone="good">{sent}</Notice>
          ) : (
            <>
              <Field label="Email" required>
                <Input type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              {error && <Notice tone="bad">{error}</Notice>}
              <Button type="submit" variant="primary" className="w-full" loading={busy}>Email me a reset link</Button>
            </>
          )}
          <p className="text-sm"><a href="/login" className="font-medium text-brand hover:underline">Back to sign in</a></p>
        </div>
      </form>
    </main>
  );
}
