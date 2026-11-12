import { Prisma } from "@prisma/client";
import { ZodError, type ZodType } from "zod";
import { isProductCode, type ProductCode } from "@/config/catalog";
import { withPlatform, withTenant, type Tx } from "../db";
import { authenticate, readCookie, SESSION_COOKIE, type AuthedSession, type SessionUser } from "../auth/session";
import { rateLimit } from "../auth/ratelimit";
import {
  assertFeature, assertPermission, assertProductUsable, hasAny, loadProductAccess, qualify, type ProductAccess,
} from "../core/access";
import { writeAudit } from "../core/audit";
import { forbidden, HttpError, notFound, unauthorized } from "./errors";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Every route MUST declare exactly one policy. There is no default, so a
 * protected endpoint can never be exposed by forgetting an annotation.
 *
 *  public   - no session (QR menu, public invoice, ID verification, webhooks)
 *  session  - any signed-in user; the handler opens its own scope
 *  platform - SAF Super Admin only; handler runs in a cross-tenant transaction
 *  product  - tenant user of a SAF product. Checks, in order: tenant active,
 *             product subscribed, subscription usable, user has a role in the
 *             product, plan entitles the feature, role grants the permission.
 *             `product: ":product"` takes the product from the URL.
 */
export type Policy =
  | { public: true }
  | { session: true; allowPasswordChange?: boolean }
  | { platform: true }
  | {
      product: ProductCode | ":product";
      /** Any-of; relative ("kds") or qualified ("dine.kds"). */
      feature?: string | readonly string[];
      /** Any-of; relative ("kitchen.update") or qualified. */
      permission?: string | readonly string[];
      /** Allow when the subscription is expired/suspended (billing & renewal pages). */
      allowInactive?: boolean;
    };

export interface Ctx<B = any, Q = any> {
  req: Request;
  params: Record<string, string>;
  body: B;
  query: Q;
  form: FormData | null;
  ip: string;
  userAgent: string;
  session: AuthedSession | null;
  user: SessionUser;
  db: Tx;
  tenantId: string;
  product: ProductCode;
  access: ProductAccess;
  branchId: string;
  status: number;
  headers: Headers;
  can(permission: string | readonly string[]): boolean;
  has(feature: string | readonly string[]): boolean;
  require(opts: { permission?: string | readonly string[]; feature?: string | readonly string[] }): void;
  audit(
    action: string,
    entity?: { type: string; id?: string | null; tenantId?: string | null },
    meta?: Record<string, unknown>,
  ): Promise<void>;
}

export interface RouteDef<B = any, Q = any> {
  method: Method;
  path: string;
  summary: string;
  tag?: string;
  auth: Policy;
  body?: ZodType<B>;
  query?: ZodType<Q>;
  multipart?: boolean;
  /** Raw body (webhooks): handler reads ctx.req itself. */
  rawBody?: boolean;
  rateLimit?: { limit: number; windowMs: number };
  /** Audit action name for mutations; false disables the automatic entry. */
  audit?: string | false;
  handler: (ctx: Ctx<B, Q>) => Promise<unknown> | unknown;
}

interface Compiled {
  def: RouteDef;
  segments: string[];
  score: number;
}

const registry = new Map<string, Compiled>();

export function route<B = any, Q = any>(def: RouteDef<B, Q>): void {
  const segments = def.path.split("/").filter(Boolean);
  const score = segments.reduce((s, seg) => s + (seg.startsWith(":") || seg.startsWith("*") ? 1 : 3), 0);
  registry.set(`${def.method} ${def.path}`, { def: def as RouteDef, segments, score });
}

export function listRoutes(): RouteDef[] {
  return [...registry.values()].map((c) => c.def);
}

function match(method: string, path: string): { c: Compiled; params: Record<string, string> } | null {
  const parts = path.split("/").filter(Boolean).map(safeDecode);
  let best: { c: Compiled; params: Record<string, string> } | null = null;
  for (const c of registry.values()) {
    if (c.def.method !== method) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < c.segments.length; i++) {
      const seg = c.segments[i];
      if (seg.startsWith("*")) {
        if (i >= parts.length) ok = false;
        else params[seg.slice(1)] = parts.slice(i).join("/");
        break;
      }
      if (i >= parts.length) { ok = false; break; }
      if (seg.startsWith(":")) params[seg.slice(1)] = parts[i];
      else if (seg !== parts[i]) { ok = false; break; }
      if (i === c.segments.length - 1 && parts.length !== c.segments.length) ok = false;
    }
    if (c.segments.length === 0 && parts.length > 0) ok = false;
    if (ok && (!best || c.score > best.c.score)) best = { c, params };
  }
  return best;
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "local";
}

const jsonReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export function json(status: number, data: unknown, headers?: Headers): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(data, jsonReplacer), { status, headers: h });
}

const DENIAL_CODES = new Set(["FEATURE_NOT_IN_PLAN", "PERMISSION_DENIED", "PLATFORM_ONLY", "PRODUCT_ACCESS_DENIED", "PRODUCT_NOT_SUBSCRIBED"]);

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  const method = req.method.toUpperCase();
  const headers = new Headers();
  const ip = clientIp(req);
  const m = match(method, path);
  if (!m) return json(404, { error: { code: "NOT_FOUND", message: `No endpoint for ${method} ${path}` } });
  const { def } = m.c;

  const ctx = {
    req, params: m.params, body: undefined, query: {}, form: null, ip,
    userAgent: (req.headers.get("user-agent") || "").slice(0, 300),
    session: null, status: 200, headers,
  } as unknown as Ctx & { _audited?: boolean };

  try {
    const global = rateLimit(`ip:${ip}`, Number(process.env.API_RATE_LIMIT_PER_MIN || 1200), 60_000);
    if (!global.ok) throw new HttpError(429, "RATE_LIMITED", "Too many requests. Please slow down.");
    if (def.rateLimit) {
      const rl = rateLimit(`${def.method}:${def.path}:${ip}`, def.rateLimit.limit, def.rateLimit.windowMs);
      if (!rl.ok) {
        headers.set("retry-after", String(rl.retryAfterSec));
        throw new HttpError(429, "RATE_LIMITED", "Too many attempts. Please wait and try again.");
      }
    }

    const mutating = method !== "GET";
    // CSRF: browsers cannot send a custom header cross-site without a CORS
    // preflight, which this API never approves. Combined with SameSite=Lax.
    if (mutating && !("public" in def.auth) && req.headers.get("x-saf-request") !== "1")
      throw forbidden("CSRF_REJECTED", "Request rejected: missing x-saf-request header.");

    const rawQuery = Object.fromEntries(url.searchParams);
    ctx.query = def.query ? def.query.parse(rawQuery) : rawQuery;
    if (mutating && !def.rawBody) {
      if (def.multipart) ctx.form = await req.formData();
      else {
        const text = await req.text();
        let parsed: unknown = {};
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
          }
        }
        ctx.body = def.body ? def.body.parse(parsed) : parsed;
      }
    }

    const result = await runWithPolicy(def, ctx);
    if (result instanceof Response) {
      headers.forEach((v, k) => result.headers.set(k, v));
      return result;
    }
    if (result === undefined) return new Response(null, { status: 204, headers });
    return json(ctx.status, result, headers);
  } catch (err) {
    if (err instanceof HttpError && DENIAL_CODES.has(err.code) && ctx.user) {
      await logDenial(ctx, def, err).catch(() => undefined);
    }
    return errorResponse(err, headers);
  }
}

async function runWithPolicy(def: RouteDef, ctx: Ctx & { _audited?: boolean }) {
  const auth = def.auth;
  if ("public" in auth) return def.handler(ctx);

  const session = await authenticate(readCookie(ctx.req.headers.get("cookie"), SESSION_COOKIE));
  if (!session) throw unauthorized();
  ctx.session = session;
  ctx.user = session.user;
  const allowPw = "session" in auth && auth.allowPasswordChange;
  if (session.user.mustChangePassword && !allowPw)
    throw forbidden("PASSWORD_CHANGE_REQUIRED", "Please change your temporary password to continue.");

  ctx.audit = async (action, entity, meta) => {
    ctx._audited = true;
    await writeAudit(ctx.db, {
      tenantId: entity?.tenantId ?? ctx.tenantId ?? null,
      actor: ctx.user,
      action,
      entityType: entity?.type,
      entityId: entity?.id ?? undefined,
      productCode: ctx.product,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      meta,
    });
  };

  if ("session" in auth) return def.handler(ctx);

  if ("platform" in auth) {
    if (session.user.kind !== "PLATFORM") throw forbidden("PLATFORM_ONLY", "Only SMARTAUTO FLEX administrators can do this.");
    return withPlatform(async (db) => {
      ctx.db = db;
      const r = await def.handler(ctx);
      await autoAudit(def, ctx);
      return r;
    });
  }

  // ---- product policy -------------------------------------------------------
  const user = session.user;
  if (user.kind !== "TENANT" || !user.tenantId)
    throw forbidden("TENANT_ONLY", "Platform administrator accounts cannot open business applications.");
  const product = auth.product === ":product" ? ctx.params.product : auth.product;
  if (!isProductCode(product)) throw notFound("Product");

  return withTenant(user.tenantId, async (db) => {
    const access = await loadProductAccess(db, user, product);
    assertProductUsable(access, { allowInactive: auth.allowInactive });
    assertFeature(access, auth.feature);
    assertPermission(access, auth.permission);

    ctx.db = db;
    ctx.tenantId = user.tenantId!;
    ctx.product = product;
    ctx.access = access;
    ctx.branchId = resolveBranch(access, ctx.req.headers.get("x-saf-branch"));
    ctx.can = (p) => hasAny(access.permissions, qualify(product, p));
    ctx.has = (f) => hasAny(access.features, qualify(product, f));
    ctx.require = ({ permission, feature }) => {
      if (feature) assertFeature(access, feature);
      if (permission) assertPermission(access, permission);
    };
    const r = await def.handler(ctx);
    await autoAudit(def, ctx);
    return r;
  });
}

function resolveBranch(access: ProductAccess, requested: string | null): string {
  const main = access.branches.find((b) => b.isMain) ?? access.branches[0];
  if (requested) {
    const b = access.branches.find((x) => x.id === requested);
    if (b && (b.isMain || access.features.includes(`${access.product}.multi_branch`))) return b.id;
  }
  return main?.id ?? "";
}

async function autoAudit(def: RouteDef, ctx: Ctx & { _audited?: boolean }) {
  if (def.method === "GET" || def.audit === false || ctx._audited) return;
  await ctx.audit(def.audit ?? `${def.method} ${def.path}`, {
    type: def.tag ?? def.path.split("/").filter((s) => s && !s.startsWith(":"))[1] ?? "api",
    id: ctx.params.id ?? null,
  }, Object.keys(ctx.params).length ? { params: ctx.params } : undefined);
}

async function logDenial(ctx: Ctx, def: RouteDef, err: HttpError) {
  await withPlatform((db) =>
    writeAudit(db, {
      tenantId: ctx.user.tenantId,
      actor: ctx.user,
      action: "security.access_denied",
      entityType: "api",
      productCode: ctx.product ?? (ctx.params.product as string | undefined),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      meta: { code: err.code, route: `${def.method} ${def.path}`, details: err.details as object },
    }),
  );
}

export function errorResponse(err: unknown, headers?: Headers): Response {
  if (err instanceof HttpError)
    return json(err.status, { error: { code: err.code, message: err.message, details: err.details } }, headers);
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    const first = issues[0];
    return json(400, {
      error: {
        code: "VALIDATION_ERROR",
        message: first ? `${first.path ? `${first.path}: ` : ""}${first.message}` : "Invalid input.",
        details: issues,
      },
    }, headers);
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      const target = (err.meta?.target as string[] | string | undefined) ?? "";
      const fields = (Array.isArray(target) ? target : [target]).filter((f) => f !== "tenant_id" && f !== "tenantId");
      return json(409, {
        error: { code: "DUPLICATE", message: `A record with the same ${fields.join(", ") || "value"} already exists.`, details: { fields } },
      }, headers);
    }
    if (err.code === "P2025") return json(404, { error: { code: "NOT_FOUND", message: "Record not found." } }, headers);
    if (err.code === "P2003")
      return json(409, { error: { code: "IN_USE", message: "This record is linked to other records and cannot be changed." } }, headers);
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("stay_reservations_no_overlap"))
    return json(409, { error: { code: "ROOM_ALREADY_BOOKED", message: "The room is already booked for some of these dates." } }, headers);
  console.error("[api] unhandled error", err);
  return json(500, { error: { code: "INTERNAL", message: "Something went wrong. Please try again." } }, headers);
}
