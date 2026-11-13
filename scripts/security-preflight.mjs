#!/usr/bin/env node
/**
 * Production configuration pre-flight. Run in the deployment pipeline with
 * the PRODUCTION environment loaded (never in a shared log with values):
 *
 *   NODE_ENV=production node scripts/security-preflight.mjs
 *
 * Prints only variable NAMES and pass/fail - never a value. Exits 1 on any
 * blocking problem so the deploy stops.
 */
const env = process.env;
const errors = [];
const warnings = [];
const isProd = env.NODE_ENV === "production";

const need = (name, test, why) => {
  const v = env[name];
  if (!v || (test && !test(v))) errors.push(`${name}: ${why}`);
};

if (!isProd) warnings.push("NODE_ENV is not 'production' (debug behaviour and dev fallbacks stay on).");
need("APP_URL", (v) => v.startsWith("https://"), "must be the https:// address (Secure cookies, HSTS, invite links)");
const dbUser = (() => {
  try {
    return decodeURIComponent(new URL(env.DATABASE_URL || "").username);
  } catch {
    return "";
  }
})();
// Supabase logins look like "postgres.<project-ref>"; that role can bypass RLS.
need("DATABASE_URL", () => !!dbUser && !/^(saf_owner|postgres|supabase_admin|service_role)(\.|$)/.test(dbUser) && !/@localhost/.test(env.DATABASE_URL), "must use the least-privilege runtime role (saf_app), not the owner / postgres / Supabase admin role or localhost");
need("DATABASE_URL", (v) => /sslmode=(require|verify-ca|verify-full)/.test(v) || /@(app|postgres|db)[:/]/.test(v), "should enforce TLS (sslmode=require) unless the database is on a private network");
need("SAF_APP_SECRET", (v) => v.length >= 32 && !/change|dev|test|example/i.test(v), "at least 32 random characters (MFA secret encryption, signed photo links)");
need("CRON_SECRET", (v) => v.length >= 24 && v !== "change-me", "at least 24 random characters");
if (env.SAF_DISABLE_RATE_LIMIT === "1") errors.push("SAF_DISABLE_RATE_LIMIT must not be set in production");
if (env.PUBLIC_API_DOCS === "1") warnings.push("PUBLIC_API_DOCS=1 publishes the endpoint inventory");
if (env.PRISMA_LOG === "1") warnings.push("PRISMA_LOG=1 writes every SQL query to the logs");
if (env.SAF_MFA_REQUIRED !== undefined && !/platform/.test(env.SAF_MFA_REQUIRED)) errors.push("SAF_MFA_REQUIRED must include 'platform' (SAF Team accounts must use MFA)");
if (env.CASHFREE_CLIENT_ID && env.CASHFREE_ENV !== "production") warnings.push("CASHFREE_ENV is not 'production' (sandbox keys)");
if (env.VERCEL && env.STORAGE_DRIVER !== "s3") errors.push("STORAGE_DRIVER must be s3 on Vercel (no permanent disk): use Supabase Storage's S3 endpoint");
else if (env.STORAGE_DRIVER !== "s3") warnings.push("STORAGE_DRIVER is not s3: files live on one server's disk (backups and scaling)");
if (env.NEXT_PUBLIC_SUPABASE_URL && !env.SUPABASE_SECRET_KEY) warnings.push("SUPABASE_SECRET_KEY missing: invitations and admin resets are disabled");
for (const k of Object.keys(env)) {
  if (k.startsWith("NEXT_PUBLIC_") && /SECRET|SERVICE_ROLE|PRIVATE|PASSWORD/i.test(k)) errors.push(`${k}: secrets must never use the NEXT_PUBLIC_ prefix (it is shipped to browsers)`);
}
const hops = Number(env.TRUSTED_PROXY_HOPS ?? 1);
if (!Number.isInteger(hops) || hops < 0 || hops > 5) errors.push("TRUSTED_PROXY_HOPS must be an integer 0-5 matching the proxies in front of the app");

for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`FAIL  ${e}`);
if (errors.length) {
  console.error(`\nSecurity pre-flight failed: ${errors.length} blocking problem(s).`);
  process.exit(1);
}
console.log(`Security pre-flight passed (${warnings.length} warning(s)).`);
