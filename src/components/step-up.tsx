"use client";

import { useEffect, useRef, useState } from "react";
import { api, errorMessage, setStepUpHandler } from "@/lib/client";
import { Button, Field, Input, Modal, Notice } from "./ui";

/**
 * "Confirm it's you" dialog for sensitive actions. Mounted once in the root
 * layout; the API client calls it when the server answers STEP_UP_REQUIRED and
 * retries the original request after a successful confirmation.
 */
export function StepUpPrompt() {
  const [open, setOpen] = useState(false);
  const [mfa, setMfa] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    setStepUpHandler(async () => {
      const me = await api<{ user: { mfaEnabled?: boolean } }>("/me").catch(() => null);
      setMfa(!!me?.user.mfaEnabled);
      setValue("");
      setError(null);
      setOpen(true);
      return new Promise<boolean>((resolve) => {
        resolver.current = resolve;
      });
    });
    return () => setStepUpHandler(null);
  }, []);

  const finish = (ok: boolean) => {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/step-up", { body: mfa ? { code: value } : { password: value } });
      finish(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="Confirm it's you" onClose={() => finish(false)} size="sm">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-600">
          This is a sensitive action. {mfa ? "Enter the 6-digit code from your authenticator app." : "Enter your password to continue."}
        </p>
        <Field label={mfa ? "Authenticator code" : "Password"} required>
          {mfa ? (
            <Input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <Input type="password" autoComplete="current-password" required autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
          )}
        </Field>
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => finish(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Confirm</Button>
        </div>
      </form>
    </Modal>
  );
}
