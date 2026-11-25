import { timingSafeEqual } from "node:crypto";
import { route, listRoutes } from "../http/router";
import { HttpError, notFound } from "../http/errors";
import { withPlatform } from "../db";
import { isPrivateKey, storage } from "../core/storage";
import { verifyFileUrl } from "../core/keys";
import { runRenewalJob } from "../core/subscriptions";
import { writeAudit } from "../core/audit";
import { buildOpenApi } from "../openapi";

route({
  method: "GET", path: "/health", tag: "system", summary: "Liveness / readiness probe", auth: { public: true },
  handler: async () => {
    await withPlatform((db) => db.$queryRaw`SELECT 1`);
    // Which build is serving: lets the deploy pipeline wait for the new version.
    const commit = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.SAF_COMMIT_SHA || "").slice(0, 12) || null;
    return { ok: true, time: new Date(), commit };
  },
});

route({
  method: "GET", path: "/files/*key", tag: "system", summary: "Serve an uploaded image (logo / employee photo)",
  auth: { public: true }, rateLimit: { limit: 300, windowMs: 60_000 },
  handler: async (ctx) => {
    const key = ctx.params.key;
    if (!/^t\/[0-9a-f-]{36}\/[a-z]+\/[0-9a-f-]{36}\.(png|jpg)$/.test(key)) throw notFound("File");
    const isPrivate = isPrivateKey(key);
    // Employee photos need the short-lived signature issued with the URL.
    if (isPrivate && !verifyFileUrl(key, Number(ctx.query.exp), String(ctx.query.sig ?? ""))) throw notFound("File");
    const file = await storage().get(key);
    if (!file) throw notFound("File");
    return new Response(Buffer.from(file.body), {
      headers: {
        "content-type": file.contentType,
        "cache-control": isPrivate ? "private, max-age=600" : "public, max-age=86400",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "same-origin",
      },
    });
  },
});

/**
 * Scheduled renewal job. Accepts the secret as `x-cron-secret` (docker cron
 * service) or `Authorization: Bearer <CRON_SECRET>` (Vercel Cron, which calls
 * with GET). Compared in constant time.
 */
async function renewalJob(ctx: { req: Request }) {
  const secret = process.env.CRON_SECRET || "";
  const bearer = (ctx.req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const given = ctx.req.headers.get("x-cron-secret") || bearer;
  const ok = secret.length >= 12 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) throw new HttpError(401, "UNAUTHENTICATED", "Invalid cron secret.");
  return withPlatform(async (db) => {
    const result = await runRenewalJob(db);
    await writeAudit(db, { action: "jobs.renewals", meta: result });
    return result;
  });
}

route({
  method: "POST", path: "/jobs/renewals", tag: "system",
  summary: "Scheduled renewal job (expire lapsed subscriptions, raise renewal invoices, send reminders). Requires the cron secret.",
  auth: { public: true }, rateLimit: { limit: 5, windowMs: 60_000 }, audit: false,
  handler: renewalJob,
});

route({
  method: "GET", path: "/jobs/renewals", tag: "system",
  summary: "Same job for Vercel Cron (GET with Authorization: Bearer <CRON_SECRET>).",
  auth: { public: true }, rateLimit: { limit: 5, windowMs: 60_000 }, audit: false,
  handler: renewalJob,
});

/**
 * Android app link verification (served at /.well-known/assetlinks.json via a
 * rewrite). Lets the SAF Flow APK open the site full-screen without a browser
 * bar. Configured with ANDROID_PACKAGE_NAME and ANDROID_CERT_SHA256 (the APK
 * signing certificate fingerprint; several may be given, comma separated).
 */
route({
  method: "GET", path: "/well-known/assetlinks", tag: "system", summary: "Digital Asset Links for the Android app",
  auth: { public: true },
  handler: () => {
    const pkg = (process.env.ANDROID_PACKAGE_NAME || "").trim();
    const prints = (process.env.ANDROID_CERT_SHA256 || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(s));
    if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(pkg) || !prints.length) return [];
    return [{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: prints },
    }];
  },
});

route({
  method: "GET", path: "/docs/openapi.json", tag: "system", summary: "OpenAPI 3.1 description of this API (not served in production unless PUBLIC_API_DOCS=1)",
  auth: { public: true },
  handler: () => {
    // The endpoint inventory helps attackers map the API; production keeps it private.
    if (process.env.NODE_ENV === "production" && process.env.PUBLIC_API_DOCS !== "1") throw notFound("Document");
    return buildOpenApi(listRoutes());
  },
});
