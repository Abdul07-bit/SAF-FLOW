import path from "node:path";
import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";
const httpsApp = (process.env.APP_URL || "").startsWith("https://");

/**
 * Content-Security-Policy. The only third party the browser talks to is the
 * Cashfree JS checkout (script, its payment frame and its API). Next.js needs
 * inline bootstrap scripts, hence 'unsafe-inline' for scripts (no user content
 * is ever rendered as HTML: React escapes everything); 'unsafe-eval' is only
 * added in development for fast refresh.
 */
const CASHFREE = "https://sdk.cashfree.com https://*.cashfree.com";
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"} https://sdk.cashfree.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${CASHFREE}`,
  `frame-src ${CASHFREE}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  `form-action 'self' ${CASHFREE}`,
  "frame-ancestors 'none'",
  ...(httpsApp ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Camera is needed for barcode / staff QR scanning inside the app.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(self)" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // HSTS only once the deployment is actually served over HTTPS (APP_URL https://).
  ...(httpsApp ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the trace root to this project (a stray lockfile higher up would otherwise move it).
  outputFileTracingRoot: path.resolve(__dirname),
  poweredByHeader: false,
  // Never ship browser source maps in production (no source code disclosure).
  productionBrowserSourceMaps: false,
  serverExternalPackages: ["@node-rs/argon2", "@prisma/client", "pdf-lib", "qrcode"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The Android app download: correct type, always downloaded, short cache so new versions show up.
      {
        source: "/downloads/:file*.apk",
        headers: [
          { key: "Content-Type", value: "application/vnd.android.package-archive" },
          { key: "Content-Disposition", value: "attachment" },
          { key: "Cache-Control", value: "public, max-age=300" },
        ],
      },
    ];
  },
  async rewrites() {
    return [{ source: "/.well-known/assetlinks.json", destination: "/api/well-known/assetlinks" }];
  },
};

export default nextConfig;
