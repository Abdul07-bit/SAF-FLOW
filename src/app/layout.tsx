import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui";

export const metadata: Metadata = {
  title: { default: "SMARTAUTO FLEX", template: "%s | SMARTAUTO FLEX" },
  description: "SMARTAUTO FLEX - SAF Dine Flow, SAF Stay Flow and SAF Bill Flow business software.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b1730" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
