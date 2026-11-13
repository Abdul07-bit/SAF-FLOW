import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui";
import { PwaRegister } from "@/components/pwa";

export const metadata: Metadata = {
  title: { default: "SAF Flow", template: "%s | SAF Flow" },
  description: "SAF Flow by SmartAutoFlex - SAF Dine Flow, SAF Stay Flow and SAF Bill Flow business software.",
  applicationName: "SAF Flow",
  appleWebApp: { capable: true, title: "SAF Flow", statusBarStyle: "black-translucent" },
  icons: { icon: [{ url: "/icons/favicon-32.png", type: "image/png", sizes: "32x32" }, { url: "/icons/icon-192.png", type: "image/png", sizes: "192x192" }], apple: "/icons/apple-touch-icon.png" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#031527" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster />
        <PwaRegister />
      </body>
    </html>
  );
}
