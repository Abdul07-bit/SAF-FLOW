/**
 * Fixed-window in-memory rate limiter. Suitable for a single app instance; when
 * running several instances behind Nginx, nginx `limit_req` (see
 * deploy/nginx.conf) and the per-account lockout stored in PostgreSQL still
 * apply globally.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
  // Test switch; ignored in production so a stray variable cannot remove the limits.
  if (process.env.SAF_DISABLE_RATE_LIMIT === "1" && process.env.NODE_ENV !== "production") return { ok: true, retryAfterSec: 0 };
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

export function resetRateLimits() {
  buckets.clear();
}
