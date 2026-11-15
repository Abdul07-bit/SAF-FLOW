import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/**
 * Rate limiting with SHARED counters.
 *
 * On Vercel (and any multi-instance host) every server copy has its own
 * memory, so in-memory counters barely limit anything. When Upstash Redis is
 * configured (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN, or the
 * KV_REST_API_URL / KV_REST_API_TOKEN names Vercel's Upstash integration
 * creates), every instance shares the same sliding-window counters.
 *
 * Without Upstash (local development, the test suite, a single Docker host)
 * it falls back to in-memory fixed windows. The per-account lockout stored in
 * PostgreSQL applies in every case.
 *
 * Fail-open: if Redis is slow or unreachable the request is allowed and the
 * problem is logged, so an outage at the limiter cannot lock everyone out.
 */
export interface LimitResult {
  ok: boolean;
  retryAfterSec: number;
}

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------
interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

function memoryLimit(key: string, limit: number, windowMs: number): LimitResult {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    lastSweep = now;
  }
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  return { ok: b.count <= limit, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
}

// ---------------------------------------------------------------------------
// Upstash Redis (shared)
// ---------------------------------------------------------------------------
let redis: Redis | null | undefined;
function sharedStore(): Redis | null {
  if (redis !== undefined) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  redis = url && token ? new Redis({ url, token }) : null;
  return redis;
}

export function sharedRateLimitConfigured(): boolean {
  return !!sharedStore();
}

const limiters = new Map<string, Ratelimit>();
function limiterFor(store: Redis, limit: number, windowMs: number): Ratelimit {
  const id = `${limit}:${windowMs}`;
  let rl = limiters.get(id);
  if (!rl) {
    rl = new Ratelimit({
      redis: store,
      limiter: Ratelimit.slidingWindow(limit, `${Math.max(1, Math.round(windowMs / 1000))} s`),
      prefix: "saf:rl",
      // Requests a blocked key makes are answered from memory without a Redis call.
      ephemeralCache: new Map(),
      // Never hold a request for long: on timeout the request is allowed. A
      // healthy store in the same region answers in a few milliseconds.
      timeout: 400,
      analytics: false,
    });
    limiters.set(id, rl);
  }
  return rl;
}

let lastStoreError = 0;

/** Counts one hit for `key`; `ok: false` once more than `limit` hits fall in `windowMs`. */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<LimitResult> {
  // Test switch; ignored in production so a stray variable cannot remove the limits.
  if (process.env.SAF_DISABLE_RATE_LIMIT === "1" && process.env.NODE_ENV !== "production") return { ok: true, retryAfterSec: 0 };
  const store = sharedStore();
  if (!store) return memoryLimit(key, limit, windowMs);
  try {
    const r = await limiterFor(store, limit, windowMs).limit(key);
    return { ok: r.success, retryAfterSec: Math.max(1, Math.ceil((r.reset - Date.now()) / 1000)) };
  } catch (e) {
    if (Date.now() - lastStoreError > 60_000) {
      lastStoreError = Date.now();
      console.error("[ratelimit] shared store unavailable, allowing request", e instanceof Error ? e.message : e);
    }
    return { ok: true, retryAfterSec: 0 };
  }
}

export function resetRateLimits() {
  buckets.clear();
}

// ---------------------------------------------------------------------------
// Logging 429s without flooding the audit trail: one entry per key per window
// (per server instance).
// ---------------------------------------------------------------------------
const logged = new Map<string, number>();
export function shouldLogLimit(key: string, windowMs: number): boolean {
  const now = Date.now();
  const until = logged.get(key);
  if (until && until > now) return false;
  logged.set(key, now + windowMs);
  if (logged.size > 5000) for (const [k, t] of logged) if (t <= now) logged.delete(k);
  return true;
}
