/**
 * Runs once when the server starts (Next.js instrumentation hook).
 *
 * In production it refuses to start with the well-known development
 * credentials that docker-compose.yml falls back to when variables are
 * missing, because a server running with them is open to anyone who has read
 * this repository. Other weak settings are reported as warnings; run
 * `npm run security:preflight` for the full check.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  const fatal: string[] = [];
  const warn: string[] = [];
  const dev = /_dev_password|saf_minio_dev|change-me/;
  for (const name of ["DATABASE_URL", "DIRECT_URL", "S3_SECRET_ACCESS_KEY", "CRON_SECRET"]) {
    if (dev.test(process.env[name] || "")) fatal.push(`${name} uses a development default value`);
  }
  if ((process.env.SAF_APP_SECRET || "").length < 32) warn.push("SAF_APP_SECRET is missing or short: two-step verification and employee photos are disabled");
  if (!(process.env.APP_URL || "").startsWith("https://")) warn.push("APP_URL is not https://");
  if (process.env.VERCEL && process.env.STORAGE_DRIVER !== "s3") warn.push("STORAGE_DRIVER must be s3 on Vercel");
  for (const w of warn) console.warn(`[startup] WARNING: ${w}`);
  if (fatal.length) {
    for (const f of fatal) console.error(`[startup] REFUSING TO START: ${f}. Set a real value (see SECURITY_CHECKLIST.md).`);
    process.exit(1);
  }
}
