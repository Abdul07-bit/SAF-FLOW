import { z, type ZodType } from "zod";
import type { RouteDef } from "./http/router";

function schemaOf(s: ZodType | undefined) {
  if (!s) return undefined;
  try {
    return z.toJSONSchema(s, { io: "input", unrepresentable: "any" });
  } catch {
    return { type: "object" };
  }
}

export function describePolicy(r: RouteDef): string {
  const a = r.auth;
  if ("public" in a) return "Public (no session).";
  if ("session" in a) return "Any signed-in user.";
  if ("platform" in a) return "SAF Super Admin only.";
  const product = a.product === ":product" ? "the product in the URL" : a.product;
  const list = (v?: string | readonly string[]) => (v ? (typeof v === "string" ? v : v.join(" | ")) : null);
  const parts = [`Tenant user of ${product} with a usable subscription${a.allowInactive ? " (expired/suspended allowed)" : ""}`];
  if (a.feature) parts.push(`plan feature: ${list(a.feature)}`);
  if (a.permission) parts.push(`role permission: ${list(a.permission)}`);
  return `${parts.join("; ")}.`;
}

export function buildOpenApi(routes: RouteDef[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  const sorted = [...routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  for (const r of sorted) {
    const p = "/api" + r.path.replace(/:(\w+)/g, "{$1}").replace(/\*(\w+)/g, "{$1}");
    const params = [...r.path.matchAll(/[:*](\w+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    const q = schemaOf(r.query) as { properties?: Record<string, unknown>; required?: string[] } | undefined;
    const queryParams = q?.properties
      ? Object.entries(q.properties).map(([name, schema]) => ({ name, in: "query", required: q.required?.includes(name) ?? false, schema }))
      : [];
    const op: Record<string, unknown> = {
      summary: r.summary,
      description: `**Authorization:** ${describePolicy(r)}` + (r.method !== "GET" && !("public" in r.auth) ? "\n\nMutations require header `x-saf-request: 1` (CSRF guard)." : ""),
      tags: [r.tag ?? "api"],
      parameters: [...params, ...queryParams],
      responses: {
        "200": { description: "Success" },
        "400": { description: "Validation error" },
        "401": { description: "Not signed in" },
        "402": { description: "Subscription expired" },
        "403": { description: "Not permitted (plan feature, role permission, tenant suspended...)" },
        "404": { description: "Not found" },
      },
      ...("public" in r.auth ? { security: [] } : {}),
      "x-saf-auth": r.auth,
    };
    if (r.body) op.requestBody = { required: true, content: { "application/json": { schema: schemaOf(r.body) } } };
    if (r.multipart) op.requestBody = { required: true, content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" } } } } } };
    (paths[p] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "SAF Flow API",
      version: "1.0.0",
      description:
        "Multi-tenant API for SAF Super Admin, SAF Dine Flow, SAF Stay Flow and SAF Bill Flow. " +
        "Authenticate with POST /api/auth/login (sets the HttpOnly `saf_session` cookie). " +
        "Every protected endpoint enforces tenant isolation (PostgreSQL RLS), subscription state, plan entitlements and role permissions server-side.",
    },
    servers: [{ url: process.env.APP_URL || "http://localhost:3000" }],
    components: { securitySchemes: { session: { type: "apiKey", in: "cookie", name: "saf_session" } } },
    security: [{ session: [] }],
    paths,
  };
}
