"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { CheckCircle2, Download, Laptop, MonitorDown, Share, Smartphone, SquarePlus } from "lucide-react";
import { SafLogo } from "@/components/brand";
import { useInstallPrompt } from "@/components/pwa";
import { Button } from "@/components/ui";

/** Where the Android app is published (a file in public/downloads by default). */
const APK_URL = process.env.NEXT_PUBLIC_APK_URL || "/downloads/saf-flow.apk";

type Platform = "android" | "ios" | "desktop";

function detect(): Platform {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  return "desktop";
}

export default function DownloadPage() {
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [apkReady, setApkReady] = useState<boolean | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const { canInstall, install } = useInstallPrompt();

  useEffect(() => {
    setPlatform(detect());
    setStandalone(window.matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true);
    fetch(APK_URL, { method: "HEAD", cache: "no-store" }).then((r) => setApkReady(r.ok)).catch(() => setApkReady(false));
    QRCode.toDataURL(`${window.location.origin}/download`, { margin: 1, width: 180 }).then(setQr).catch(() => undefined);
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-b from-sidebar to-[#0b2a3a] px-4 py-10 text-white sm:py-16">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-col items-center text-center">
          <SafLogo tone="light" className="h-16 sm:h-20" />
          <p className="mt-3 text-sm font-medium tracking-wide text-accent">DINE FLOW · STAY FLOW · BILL FLOW</p>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">Get the SAF Flow app</h1>
          <p className="mt-2 max-w-xl text-sidebar-ink">Restaurant, hotel and shop management on your phone, tablet or computer. One account, always up to date.</p>
        </div>

        {standalone && (
          <div className="mx-auto mt-8 flex max-w-xl items-center gap-3 rounded-xl bg-white/10 p-4">
            <CheckCircle2 className="h-6 w-6 shrink-0 text-accent" aria-hidden />
            <p className="text-sm">SAF Flow is already installed on this device. <Link href="/" className="font-semibold underline">Open the app</Link></p>
          </div>
        )}

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {/* Android */}
          <section className={`rounded-2xl bg-white p-5 text-slate-900 shadow-lg ${platform === "android" ? "ring-4 ring-accent" : ""}`}>
            <Smartphone className="h-7 w-7 text-brand" aria-hidden />
            <h2 className="mt-3 text-lg font-semibold">Android</h2>
            {apkReady ? (
              <>
                <p className="mt-1 text-sm text-slate-600">Download and open the file. If asked, allow installing from your browser.</p>
                <a href={APK_URL} download className="mt-4 flex h-11 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-brand-ink hover:brightness-110">
                  <Download className="h-4 w-4" aria-hidden /> Download APK
                </a>
              </>
            ) : (
              <p className="mt-1 text-sm text-slate-600">{apkReady === null ? "Checking…" : "The Android app file is being prepared. Meanwhile install straight from Chrome below."}</p>
            )}
            {platform === "android" && canInstall && (
              <Button variant={apkReady ? "secondary" : "primary"} className="mt-2 w-full" onClick={install}>
                <MonitorDown className="h-4 w-4" aria-hidden /> Install from Chrome
              </Button>
            )}
          </section>

          {/* Computer */}
          <section className={`rounded-2xl bg-white p-5 text-slate-900 shadow-lg ${platform === "desktop" ? "ring-4 ring-accent" : ""}`}>
            <Laptop className="h-7 w-7 text-brand" aria-hidden />
            <h2 className="mt-3 text-lg font-semibold">Windows, Mac, Linux</h2>
            <p className="mt-1 text-sm text-slate-600">Install from Chrome or Edge: it opens in its own window with the SAF icon on your desktop.</p>
            {platform === "desktop" && canInstall ? (
              <Button variant="primary" className="mt-4 w-full" onClick={install}>
                <MonitorDown className="h-4 w-4" aria-hidden /> Install SAF Flow
              </Button>
            ) : (
              <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">In Chrome or Edge, click the <b>install icon</b> at the right end of the address bar, or menu <b>⋮ → Install SAF Flow</b>.</p>
            )}
          </section>

          {/* iPhone / iPad */}
          <section className={`rounded-2xl bg-white p-5 text-slate-900 shadow-lg ${platform === "ios" ? "ring-4 ring-accent" : ""}`}>
            <SquarePlus className="h-7 w-7 text-brand" aria-hidden />
            <h2 className="mt-3 text-lg font-semibold">iPhone &amp; iPad</h2>
            <ol className="mt-2 space-y-2 text-sm text-slate-600">
              <li><span className="mr-1.5 font-semibold text-slate-900">1.</span>Open this page in <b>Safari</b>.</li>
              <li><span className="mr-1.5 font-semibold text-slate-900">2.</span>Tap <Share className="inline h-4 w-4 align-text-bottom" aria-label="Share" /> <b>Share</b>.</li>
              <li><span className="mr-1.5 font-semibold text-slate-900">3.</span>Tap <b>Add to Home Screen</b>.</li>
            </ol>
          </section>
        </div>

        <div className="mt-10 flex flex-col items-center gap-6 sm:flex-row sm:justify-center">
          {qr && platform === "desktop" && (
            <div className="flex items-center gap-4 rounded-2xl bg-white/10 p-4">
              <img src={qr} alt="QR code to open this download page on a phone" className="h-28 w-28 rounded-lg bg-white p-1" />
              <p className="max-w-[12rem] text-sm text-sidebar-ink">Scan with your phone camera to install SAF Flow on it.</p>
            </div>
          )}
          <Link href="/login" className="text-sm font-semibold text-white underline underline-offset-4">Or use SAF Flow in the browser →</Link>
        </div>

        <p className="mt-12 text-center text-xs text-sidebar-muted">The app always loads the latest version: there is nothing to update by hand. Your data stays on SAF Flow&apos;s secure servers.</p>
      </div>
    </main>
  );
}
