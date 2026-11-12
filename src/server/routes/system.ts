import { timingSafeEqual } from "node:crypto";
import { route, listRoutes } from "../http/router";
import { HttpError, notFound } from "../http/errors";
import { withPlatform } from "../db";
import { storage } from "../core/storage";
import { runRenewalJob } from "../core/subscriptions";
import { writeAudit } from "../core/audit";
import { buildOpenApi } from "../openapi";

route({
  method: "GET", path: "/health", tag: "system", summary: "Liveness / readiness probe", auth: { public: true },
  handler: async () => {
    await withPlatform((db) => db.$queryRaw`SELECT 1`);
    return { ok: true, time: new Date() };
  },
});

route({
  method: "GET", path: "/files/*key", tag: "system", summary: "Serve an uploaded image (logo / employee photo)",
  auth: { public: true }, rateLimit: { limit: 600, windowMs: 60_000 },
  handler: async (ctx) => {
    const key = ctx.params.key;
    if (!/^t\/[0-9a-f-]{36}\/[a-z]+\/[0-9a-f-]{36}\.(png|jpg)$/.test(key)) throw notFound("File");
    const file = await storage().get(key);
    if (!file) throw notFound("File");
    return new Response(Buffer.from(file.body), {
      headers: { "content-type": file.contentType, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" },
    });
  },
});

route({
  method: "POST", path: "/jobs/renewals", tag: "system",
  summary: "Scheduled renewal job (expire lapsed subscriptions, raise renewal invoices, send reminders). Requires x-cron-secret.",
  auth: { public: true }, rateLimit: { limit: 10, windowMs: 60_000 }, audit: false,
  handler: async (ctx) => {
    const secret = process.env.CRON_SECRET || "";
    const given = ctx.req.headers.get("x-cron-secret") || "";
    const ok = secret.length >= 12 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
    if (!ok) throw new HttpError(401, "UNAUTHENTICATED", "Invalid cron secret.");
    return withPlatform(async (db) => {
      const result = await runRenewalJob(db);
      await writeAudit(db, { action: "jobs.renewals", meta: result });
      return result;
    });
  },
});

route({
  method: "GET", path: "/docs/openapi.json", tag: "system", summary: "OpenAPI 3.1 description of this API", auth: { public: true },
  handler: () => buildOpenApi(listRoutes()),
});
