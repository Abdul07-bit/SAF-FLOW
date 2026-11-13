import { Prisma } from "@prisma/client";
import { logError } from "../core/log";
import { ZodError, ZodObject, ZodPipe, type ZodType } from "zod";
import { isProductCode, type ProductCode } from "@/config/catalog";
import { withPlatform, withStaffScope, withTenant, type Tx } from "../db";
import type { PlatformPermissionKey } from "@/config/platform";
import { assertOnTenant, assertRole, loadPlatformScope, resolveTarget, type PlatformScope, type PlatformTarget } from "../core/platform-scope";
import { authenticate, readCookie, SESSION_COOKIE, type AuthedSession, type SessionUser } from "../auth/session";
import { rateLimit, shouldLogLimit } from "../auth/ratelimit";
import { isUuid } from "../db";
import {
  assertFeature, assertPermission, assertProductUsable, hasAny, loadProductAccess, qualify, type ProductAccess,
} from "../core/access";
import { writeAudit } from "../core/audit";
import { mfaRequiredFor, stepUpWindowMs } from "../auth/mfa";
import { randomUUID } from "node:crypto";
import { forbidden, HttpError, notFound, unauthorized } from "./errors";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Every route MUST declare exactly one policy. There is no default, so a
 * protected endpoint can never be exposed by forgetting an annotation.
 *
 *  public   - no session (QR menu, public invoice, ID verification, webhooks)
 *  session  - any signed-in user; the handler opens its own scope
 *  platform - SAF Team member whose platform role grants the permission(s).
 *             Roles with all_tenants run cross-tenant (RLS bypass); other
 *             roles run in the staff scope, where RLS exposes only assigned
 *             businesses. `target` names the business the route acts on so
 *             per-assignment permission and module limits apply too.
 *             `elevated` (business creation only) runs cross-tenant after the
 *             permission check; the handler must assign the new business.
 *  product  - tenant user of a SAF product. Checks, in order: tenant active,
 *             product subscribed, subscription usable, user has a role in the
 *             product, plan entitles the feature, role grants the permission.
 *             `product: ":product"` takes the product from the URL.
 */
export type Policy =
  | { public: true }
  | {
      session: true;
      allowPasswordChange?: boolean;
      /** Reachable while the second factor is outstanding (MFA verification only). */
      allowMfaPending?: boolean;
      /** Reachable before a user who must use MFA has enrolled (enrolment, sign-out, /me). */
      allowMfaEnrollment?: boolean;
    }
  | {
      /** Any-of platform permission keys. */
      platform: PlatformPermissionKey | readonly PlatformPermissionKey[];
      target?: PlatformTarget;
      elevated?: boolean;
    }
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
  /** Correlation id, echoed as x-request-id and written into audit entries. */
  requestId: string;
  session: AuthedSession | null;
  user: SessionUser;
  /** Set on platform routes. */
  platform: PlatformScope;
  db: Tx;
  tenantId: string;
  product: ProductCode;
  access: ProductAccess;
  branchId: string;
  status: number;
  headers: Headers;
  /** Throws 429 (and logs it) when `key` exceeded `limit` hits in `windowMs`. Use for per-email / per-account / per-table limits. */
  limit(name: string, key: string, limit: number, windowMs: number): Promise<void>;
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
  /**
   * Extra limits for this route, on top of the general ones. `by: "ip"`
   * (default) counts per client address before authentication; `by: "user"`
   * counts per signed-in account. Counters are shared across server instances
   * when Upstash Redis is configured (see auth/ratelimit.ts).
   */
  rateLimit?: RouteLimit | RouteLimit[];
  /**
   * Sensitive action: requires a fresh authentication (sign-in, MFA, or
   * POST /auth/step-up) within STEP_UP_WINDOW_MINUTES (default 10).
   */
  stepUp?: boolean;
  /** Audit action name for mutations; false disables the automatic entry. */
  audit?: string | false;
  handler: (ctx: Ctx<B, Q>) => Promise<unknown> | unknown;
}

export interface RouteLimit {
  limit: number;
  windowMs: number;
  by?: "ip" | "user";
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

/**
 * Client address for rate limits and audit. Only proxies we run may set it:
 * TRUSTED_PROXY_HOPS (default 1, the bundled nginx) counts proxies from the
 * right of X-Forwarded-For, so a value a client prepends is never used.
 * Set it to 0 when the app is reachable without a proxy in front.
 */
export function clientIp(req: Request): string {
  const hops = Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS ?? 1));
  if (hops === 0) return "direct";
  const xff = (req.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (xff.length) return (xff[Math.max(0, xff.length - hops)] ?? xff[0]).slice(0, 64);
  return (req.headers.get("x-real-ip") || "local").slice(0, 64);
}

export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_MULTIPART_BYTES = 3 * 1024 * 1024;

/** Reads a request body, refusing more than `limit` bytes even without a Content-Length. */
async function readCapped(req: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get("content-length") || "0");
  if (declared > limit) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The request is too large.");
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The request is too large.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

const jsonReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export function json(status: number, data: unknown, headers?: Headers): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(data, jsonReplacer), { status, headers: h });
}

const DENIAL_CODES = new Set(["STEP_UP_REQUIRED", "MFA_REQUIRED", "MFA_ENROLLMENT_REQUIRED", "FEATURE_NOT_IN_PLAN", "PERMISSION_DENIED", "PLATFORM_ONLY", "PLATFORM_PERMISSION_DENIED", "BRANCH_ACCESS_DENIED", "PRODUCT_ACCESS_DENIED", "PRODUCT_NOT_SUBSCRIBED"]);

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // /.well-known/assetlinks.json reaches here through a Next.js rewrite, which
  // keeps the original URL: map that one public address onto its API route.
  const path = url.pathname === "/.well-known/assetlinks.json"
    ? "/well-known/assetlinks"
    : url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  const method = req.method.toUpperCase();
  const headers = new Headers();
  const ip = clientIp(req);
  const inboundId = req.headers.get("x-request-id") || "";
  const requestId = /^[A-Za-z0-9-]{8,64}$/.test(inboundId) ? inboundId : randomUUID();
  headers.set("x-request-id", requestId);
  const m = match(method, path);
  if (!m) return json(404, { error: { code: "NOT_FOUND", message: "No such endpoint." } }, headers);
  const { def } = m.c;

  const ctx = {
    req, params: m.params, body: undefined, query: {}, form: null, ip, requestId,
    userAgent: (req.headers.get("user-agent") || "").slice(0, 300),
    session: null, status: 200, headers,
  } as unknown as Ctx & { _audited?: boolean };

  ctx.limit = async (name, key, limit, windowMs) => {
    const r = await rateLimit(`${name}:${key}`, limit, windowMs);
    if (r.ok) return;
    headers.set("retry-after", String(r.retryAfterSec));
    await logRateLimited(ctx, def, name, `${name}:${key}`, windowMs);
    throw new HttpError(429, "RATE_LIMITED", "Too many attempts. Please wait a little and try again.");
  };

  try {
    // 1. Per client address: everything, then this route's own IP limits.
    await ctx.limit("ip", ip, Number(process.env.API_RATE_LIMIT_PER_MIN || 1200), 60_000);
    for (const l of routeLimits(def).filter((x) => (x.by ?? "ip") === "ip"))
      await ctx.limit(`route-ip:${def.method} ${def.path}`, ip, l.limit, l.windowMs);

    // Anonymous callers of protected routes are turned away before any input
    // validation runs, so they learn nothing about the expected payloads.
    if (!("public" in def.auth) && !readCookie(req.headers.get("cookie"), SESSION_COOKIE)) throw unauthorized();

    const mutating = method !== "GET";
    // CSRF: browsers cannot send a custom header cross-site without a CORS
    // preflight, which this API never approves. Combined with SameSite=Lax.
    if (mutating && !("public" in def.auth) && req.headers.get("x-saf-request") !== "1")
      throw forbidden("CSRF_REJECTED", "Request rejected: missing x-saf-request header.");

    // ID parameters must be UUIDs: anything else cannot exist, so stop here.
    for (const [k, v] of Object.entries(m.params))
      if (UUID_PARAMS.has(k) && !isUuid(v)) throw notFound();

    const rawQuery = Object.fromEntries(url.searchParams);
    if (def.query) rejectUnknownQuery(def.query, rawQuery);
    ctx.query = def.query ? def.query.parse(rawQuery) : rawQuery;
    if (mutating && !def.rawBody) {
      if (def.multipart) {
        const bytes = await readCapped(req, MAX_MULTIPART_BYTES);
        ctx.form = await new Response(Buffer.from(bytes), { headers: { "content-type": req.headers.get("content-type") || "" } })
          .formData()
          .catch(() => {
            throw new HttpError(400, "INVALID_FORM", "Request body must be multipart form data.");
          });
      } else {
        const text = new TextDecoder().decode(await readCapped(req, MAX_JSON_BYTES));
        let parsed: unknown = {};
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
          }
        }
        if (def.body) {
          ctx.body = def.body.parse(parsed);
          // Zod drops unknown keys silently; the API refuses them instead.
          const extra = unknownKeys(parsed, ctx.body);
          if (extra.length)
            throw new HttpError(400, "UNKNOWN_FIELDS", `Unexpected field(s): ${extra.slice(0, 10).join(", ")}.`, { fields: extra.slice(0, 50) });
        } else if (text && parsed && typeof parsed === "object" && Object.keys(parsed).length) {
          throw new HttpError(400, "UNKNOWN_FIELDS", "This request does not take a body.");
        } else {
          ctx.body = parsed;
        }
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
  const sessionPolicy = "session" in auth ? auth : null;
  if (session.mfaPending && !sessionPolicy?.allowMfaPending)
    throw new HttpError(401, "MFA_REQUIRED", "Enter the code from your authenticator app to finish signing in.");
  if (session.user.mustChangePassword && !sessionPolicy?.allowPasswordChange)
    throw forbidden("PASSWORD_CHANGE_REQUIRED", "Please change your temporary password to continue.");
  if (!session.mfaPending && !session.user.mfaEnabled && mfaRequiredFor(session.user) && !sessionPolicy?.allowMfaEnrollment)
    throw forbidden("MFA_ENROLLMENT_REQUIRED", "Your account must use two-step verification. Please set it up to continue.");
  if (def.stepUp && (!session.stepUpAt || Date.now() - session.stepUpAt.getTime() > stepUpWindowMs()))
    throw forbidden("STEP_UP_REQUIRED", "Please confirm it is you to continue with this action.");

  // 2. Per signed-in user: general read / write budgets, then this route's own user limits.
  const reading = def.method === "GET";
  await ctx.limit(reading ? "user-read" : "user-write", session.user.id, reading ? 600 : 120, 60_000);
  for (const l of routeLimits(def).filter((x) => x.by === "user"))
    await ctx.limit(`route-user:${def.method} ${def.path}`, session.user.id, l.limit, l.windowMs);

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
      meta: { ...(meta ?? {}), requestId: ctx.requestId },
    });
  };

  if ("session" in auth) return def.handler(ctx);

  if ("platform" in auth) {
    if (session.user.kind !== "PLATFORM") throw forbidden("PLATFORM_ONLY", "Only SmartAutoFlex team members can do this.");
    const scope = await loadPlatformScope(session.user);
    const need = (typeof auth.platform === "string" ? [auth.platform] : [...auth.platform]) as string[];
    assertRole(scope, need);
    ctx.platform = scope;
    const run = scope.allTenants || auth.elevated
      ? <T>(fn: (db: Tx) => Promise<T>) => withPlatform(fn)
      : <T>(fn: (db: Tx) => Promise<T>) => withStaffScope(scope.userId, fn);
    return run(async (db) => {
      ctx.db = db;
      if (auth.target) {
        const t = await resolveTarget(db, auth.target, ctx.params, ctx.body);
        if (!t) throw notFound();
        assertOnTenant(scope, need, t.tenantId, t.product);
        ctx.tenantId = t.tenantId;
      }
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
  if (access.branchRestricted) {
    // Branch-restricted staff: only their granted branches, never a fallback.
    if (!access.branches.length) throw forbidden("BRANCH_ACCESS_DENIED", "Your account is not assigned to any active branch.");
    if (!requested) return (access.branches.find((b) => b.isMain) ?? access.branches[0]).id;
    if (!access.branches.some((b) => b.id === requested))
      throw forbidden("BRANCH_ACCESS_DENIED", "Your account does not have access to this branch.");
    return requested;
  }
  const main = access.branches.find((b) => b.isMain) ?? access.branches[0];
  if (requested) {
    const b = access.branches.find((x) => x.id === requested);
    if (b && (b.isMain || access.features.includes(`${access.product}.multi_branch`))) return b.id;
  }
  return main?.id ?? "";
}

/** Error codes whose `details` the user interface needs. */
const PUBLIC_DETAIL_CODES = new Set(["VALIDATION_ERROR", "UNKNOWN_FIELDS", "BALANCE_DUE"]);

/** Unique-constraint fields that are safe and useful to name to a user. */
const FRIENDLY_FIELDS: Record<string, string> = {
  code: "code", username: "login ID", email: "email", phone: "phone number", name: "name", barcode: "barcode", sku: "SKU",
  number: "number", employeeCode: "employee ID", employee_code: "employee ID", invoiceNo: "invoice number", invoice_no: "invoice number",
  cardNumber: "card number", card_number: "card number",
};

/** Path parameters that hold record ids. */
const UUID_PARAMS = new Set(["id", "userId", "tenantId", "productId"]);

function routeLimits(def: RouteDef): RouteLimit[] {
  return def.rateLimit ? (Array.isArray(def.rateLimit) ? def.rateLimit : [def.rateLimit]) : [];
}

/** Keys present in the request but dropped by the schema (nested objects and arrays included). */
export function unknownKeys(input: unknown, output: unknown, path = ""): string[] {
  if (Array.isArray(input) && Array.isArray(output))
    return input.flatMap((v, i) => unknownKeys(v, output[i], `${path}[${i}]`));
  if (!isPlainObject(input) || !isPlainObject(output)) return [];
  const out: string[] = [];
  for (const k of Object.keys(input)) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in output)) {
      if (input[k] !== undefined) out.push(p);
    } else out.push(...unknownKeys(input[k], output[k], p));
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/** Query strings: only the parameters the route's schema declares are accepted. */
function rejectUnknownQuery(schema: ZodType, raw: Record<string, string>) {
  let obj: unknown = schema;
  if (obj instanceof ZodPipe) obj = (obj as ZodPipe).in;
  if (!(obj instanceof ZodObject)) return;
  const allowed = new Set(Object.keys((obj as ZodObject).shape));
  const extra = Object.keys(raw).filter((k) => !allowed.has(k));
  if (extra.length) throw new HttpError(400, "UNKNOWN_FIELDS", `Unexpected query parameter(s): ${extra.slice(0, 10).join(", ")}.`);
}

/** Records a 429 in the audit trail, at most once per key and window (rule name only: no raw emails). */
async function logRateLimited(ctx: Ctx, def: RouteDef, rule: string, key: string, windowMs: number) {
  if (!shouldLogLimit(key, windowMs)) return;
  const user = ctx.session?.user ?? null;
  await withPlatform((db) =>
    writeAudit(db, {
      tenantId: user?.tenantId ?? null,
      actor: user,
      action: "security.rate_limited",
      entityType: "api",
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      meta: { rule: rule.split(":")[0] === "route-ip" || rule.split(":")[0] === "route-user" ? rule : rule.split(":")[0], route: `${def.method} ${def.path}`, requestId: ctx.requestId },
    }),
  ).catch((e) => console.error("[ratelimit] could not log 429", e instanceof Error ? e.message : e));
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
      meta: { code: err.code, route: `${def.method} ${def.path}`, details: err.details as object, requestId: ctx.requestId },
    }),
  );
}

export function errorResponse(err: unknown, headers?: Headers): Response {
  if (err instanceof HttpError) {
    // Details reach the browser only where the screen needs them; the rest
    // (permission keys, feature lists, internal names) stays in server logs.
    const details = PUBLIC_DETAIL_CODES.has(err.code) ? err.details : undefined;
    return json(err.status, { error: { code: err.code, message: err.message, ...(details === undefined ? {} : { details }) } }, headers);
  }
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
      // Only user-facing field names are mentioned; internal column names never are.
      const fields = (Array.isArray(target) ? target : [target]).map((f) => FRIENDLY_FIELDS[f]).filter(Boolean);
      return json(409, {
        error: { code: "DUPLICATE", message: `A record with the same ${fields.join(", ") || "details"} already exists.` },
      }, headers);
    }
    // P2025 missing record; P2023 malformed id (e.g. not a UUID): both are simply "not found".
    if (err.code === "P2025" || err.code === "P2023") return json(404, { error: { code: "NOT_FOUND", message: "Record not found." } }, headers);
    if (err.code === "P2003")
      return json(409, { error: { code: "IN_USE", message: "This record is linked to other records and cannot be changed." } }, headers);
  }
  const msg = err instanceof Error ? err.message : String(err);
  // Database guards (security_hardening migration).
  if (msg.includes("SAF_CROSS_TENANT_REF"))
    return json(400, { error: { code: "INVALID_REFERENCE", message: "A selected record does not exist." } }, headers);
  if (msg.includes("SAF_AUDIT_IMMUTABLE"))
    return json(403, { error: { code: "AUDIT_IMMUTABLE", message: "Audit records cannot be changed." } }, headers);
  if (msg.includes("stay_reservations_no_overlap"))
    return json(409, { error: { code: "ROOM_ALREADY_BOOKED", message: "The room is already booked for some of these dates." } }, headers);
  // Full details (stack included, personal data masked) go to the server log under the
  // request id; the user only sees a friendly message and that id as a reference.
  const reference = headers?.get("x-request-id") ?? undefined;
  // The reference goes in the (unredacted) tag: it must stay searchable in the logs.
  logError(`api ref=${reference ?? "-"}`, "unhandled error", err);
  return json(500, { error: { code: "INTERNAL", message: "Something went wrong. Please try again.", reference } }, headers);
}
