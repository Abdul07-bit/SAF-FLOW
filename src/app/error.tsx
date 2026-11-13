"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { SafLogo } from "@/components/brand";
import { Button } from "@/components/ui";

/**
 * Friendly page for unexpected errors while showing a screen. Users see a
 * plain message and a reference; the details stay in the server / browser
 * logs (Next.js never sends stack traces to the browser in production).
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[page] unexpected error", error.digest ?? "");
  }, [error]);
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <SafLogo className="mx-auto h-9" />
        <h1 className="mt-6 text-xl font-semibold text-slate-900">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate-600">This page could not be shown. Please try again. If it keeps happening, contact SAF support.</p>
        {error.digest && <p className="mt-3 text-xs text-slate-500">Reference: <span className="font-mono">{error.digest}</span></p>}
        <div className="mt-6 flex justify-center gap-2">
          <Button variant="primary" onClick={reset}><RefreshCw className="h-4 w-4" aria-hidden /> Try again</Button>
          <Link href="/" className="inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium text-slate-700 hover:bg-slate-100">Go to start</Link>
        </div>
      </div>
    </main>
  );
}
