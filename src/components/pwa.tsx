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
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", keep);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);
  return null;
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
