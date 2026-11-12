import path from "node:path";
import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Camera is needed for barcode / staff QR scanning inside the app.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the trace root to this project (a stray lockfile higher up would otherwise move it).
  outputFileTracingRoot: path.resolve(__dirname),
  poweredByHeader: false,
  serverExternalPackages: ["@node-rs/argon2", "@prisma/client", "pdf-lib", "qrcode"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
