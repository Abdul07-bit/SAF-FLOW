"use client";

import { useEffect, useState } from "react";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

declare global {
  interface Window {
    __safInstallPrompt?: InstallPromptEvent | null;
  }
}

/**
 * Registers the service worker (installable app + offline page, production
 * only) and keeps the browser's install offer so the Download page can show
 * an "Install" button even if the offer arrived before that page opened.
 */
export function PwaRegister() {
  useEffect(() => {
    const keep = (e: Event) => {
      e.preventDefault();
      window.__safInstallPrompt = e as InstallPromptEvent;
      window.dispatchEvent(new Event("saf-install-available"));
    };
    const installed = () => {
      window.__safInstallPrompt = null;
      window.dispatchEvent(new Event("saf-install-available"));
    };
    window.addEventListener("beforeinstallprompt", keep);
    window.addEventListener("appinstalled", installed);
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      // A new build id means a new worker script URL, so the browser installs a
      // fresh worker (and its own cache) on every deploy.
      navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(BUILD_ID)}`, { scope: "/" }).catch(() => undefined);
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", keep);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);
  return null;
}

const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || "dev";
const CHECK_EVERY_MS = 5 * 60_000;
const CHUNK_ERROR = /ChunkLoadError|Loading (CSS )?chunk [^ ]+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i;

/**
 * Keeps long-open screens (POS, kitchen display, reception) on the current
 * release. After a deploy:
 *  - a tab that tries to load code the new deploy no longer has reloads itself
 *    once, instead of showing a broken screen;
 *  - every tab learns from /api/health that a newer build is live and offers a
 *    Refresh. It never reloads by itself, so a bill being typed is never lost.
 */
export function UpdateNotice() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (BUILD_ID === "dev") return;

    const recover = (message: string) => {
      if (!CHUNK_ERROR.test(message)) return;
      const key = `saf-chunk-reload-${BUILD_ID}`;
      if (sessionStorage.getItem(key)) { setStale(true); return; } // already tried once: ask instead of looping
      sessionStorage.setItem(key, "1");
      window.location.reload();
    };
    const onError = (e: ErrorEvent) => recover(String(e.message || e.error?.message || ""));
    const onRejection = (e: PromiseRejectionEvent) => recover(String(e.reason?.message ?? e.reason ?? ""));

    let stopped = false;
    const check = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const body = (await res.json()) as { commit?: string | null };
        if (body.commit && body.commit !== BUILD_ID) setStale(true);
      } catch {
        // Offline or the server is busy: try again later.
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    return () => {
      stopped = true;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, []);

  if (!stale) return null;
  return (
    <div className="no-print fixed inset-x-0 top-2 z-[70] flex justify-center px-4" role="status">
      <div className="flex max-w-md items-center gap-3 rounded-lg bg-slate-800 px-4 py-2.5 text-sm font-medium text-white shadow-lg">
        <span>A new version of SAF Flow is available.</span>
        <button type="button" onClick={() => window.location.reload()} className="rounded-md bg-accent px-3 py-1 text-slate-900">
          Refresh
        </button>
        <button type="button" onClick={() => setStale(false)} aria-label="Later" className="text-slate-300 hover:text-white">
          Later
        </button>
      </div>
    </div>
  );
}

/** The browser's install offer (Chrome / Edge on Android and computers), if available. */
export function useInstallPrompt() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  useEffect(() => {
    const sync = () => setPrompt(window.__safInstallPrompt ?? null);
    sync();
    window.addEventListener("saf-install-available", sync);
    return () => window.removeEventListener("saf-install-available", sync);
  }, []);
  const install = async () => {
    if (!prompt) return false;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    window.__safInstallPrompt = null;
    setPrompt(null);
    return outcome === "accepted";
  };
  return { canInstall: !!prompt, install };
}
