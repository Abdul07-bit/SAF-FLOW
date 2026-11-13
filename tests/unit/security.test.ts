import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, signFileUrl, verifyFileUrl } from "@/server/core/keys";
import { checkTotp, currentCode, hashRecovery, mfaRequiredFor, newRecoveryCodes, newTotpSecret } from "@/server/auth/mfa";
import { clientIp } from "@/server/http/router";
import { rateLimit, resetRateLimits } from "@/server/auth/ratelimit";
import { verifyCashfreeWebhook, webhookTimestampFresh } from "@/server/payments/cashfree";
import { createHmac } from "node:crypto";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["SAF_MFA_REQUIRED", "TRUSTED_PROXY_HOPS", "SAF_DISABLE_RATE_LIMIT", "NODE_ENV", "SAF_APP_SECRET"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetRateLimits();
});

describe("application keys", () => {
  it("encrypts MFA secrets with AES-256-GCM; tampering is detected", () => {
    const sealed = encryptSecret("JBSWY3DPEHPK3PXP");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(sealed)).toBe("JBSWY3DPEHPK3PXP");
    const raw = Buffer.from(sealed.slice(3), "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => decryptSecret(`v1:${raw.toString("base64")}`)).toThrow();
    // A truncated authentication tag (forgery aid) is refused: GCM tag length is pinned to 16 bytes.
    const ok = Buffer.from(sealed.slice(3), "base64");
    const truncated = Buffer.concat([ok.subarray(0, 12), ok.subarray(12, 16), ok.subarray(28)]);
    expect(() => decryptSecret(`v1:${truncated.toString("base64")}`)).toThrow();
  });

  it("production without SAF_APP_SECRET fails closed", () => {
    (process.env as any).NODE_ENV = "production";
    delete process.env.SAF_APP_SECRET;
    expect(() => encryptSecret("x")).toThrow(/SAF_APP_SECRET/);
    expect(verifyFileUrl("t/a/employees/b.png", Math.floor(Date.now() / 1000) + 60, "anything")).toBe(false);
  });

  it("signed file URLs: valid, tampered, other file, expired", () => {
    const key = "t/11111111-1111-1111-1111-111111111111/employees/22222222-2222-2222-2222-222222222222.png";
    const exp = Math.floor(Date.now() / 1000) + 600;
    const sig = signFileUrl(key, exp);
    expect(verifyFileUrl(key, exp, sig)).toBe(true);
    expect(verifyFileUrl(key, exp, sig.replace(/^./, sig[0] === "A" ? "B" : "A"))).toBe(false);
    expect(verifyFileUrl(key.replace("2222", "3333"), exp, sig)).toBe(false);
    expect(verifyFileUrl(key, exp + 1, sig)).toBe(false);
    const past = Math.floor(Date.now() / 1000) - 1;
    expect(verifyFileUrl(key, past, signFileUrl(key, past))).toBe(false);
  });
});

describe("TOTP", () => {
  it("accepts the current code once (replay rejected) and tolerates one step of drift", () => {
    const secret = newTotpSecret();
    const now = Date.now();
    const step = checkTotp(secret, currentCode(secret, now), null, now);
    expect(step).not.toBeNull();
    expect(checkTotp(secret, currentCode(secret, now), step, now)).toBeNull(); // same step replayed
    expect(checkTotp(secret, currentCode(secret, now + 30_000), step, now)).toBe(step! + 1); // next step OK
    expect(checkTotp(secret, currentCode(secret, now - 120_000), null, now)).toBeNull(); // too old
    expect(checkTotp(secret, "12345", null, now)).toBeNull();
    expect(checkTotp(secret, "abcdef", null, now)).toBeNull();
  });

  it("recovery codes are random, single format, stored only as hashes", () => {
    const { codes, hashes } = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((c) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c))).toBe(true);
    expect(hashes.every((h, i) => h === hashRecovery(codes[i].toUpperCase()) && !h.includes(codes[i]))).toBe(true);
  });

  it("MFA policy: required for SAF Team and owners in production, configurable", () => {
    delete process.env.SAF_MFA_REQUIRED;
    (process.env as any).NODE_ENV = "production";
    expect(mfaRequiredFor({ kind: "PLATFORM", isTenantOwner: false })).toBe(true);
    expect(mfaRequiredFor({ kind: "TENANT", isTenantOwner: true })).toBe(true);
    expect(mfaRequiredFor({ kind: "TENANT", isTenantOwner: false })).toBe(false);
    process.env.SAF_MFA_REQUIRED = "platform";
    expect(mfaRequiredFor({ kind: "TENANT", isTenantOwner: true })).toBe(false);
  });
});

describe("request hygiene", () => {
  const req = (h: Record<string, string>) => new Request("http://x/api/health", { headers: h });

  it("client IP comes from the trusted proxy hop, not from a value the client prepends", () => {
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.2" }))).toBe("203.0.113.9");
    process.env.TRUSTED_PROXY_HOPS = "0";
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6" }))).toBe("direct");
  });

  it("rate limiter blocks after the limit; the test switch is ignored in production", () => {
    delete process.env.SAF_DISABLE_RATE_LIMIT;
    for (let i = 0; i < 3; i++) expect(rateLimit("unit:a", 3, 60_000).ok).toBe(true);
    expect(rateLimit("unit:a", 3, 60_000).ok).toBe(false);
    process.env.SAF_DISABLE_RATE_LIMIT = "1";
    (process.env as any).NODE_ENV = "production";
    expect(rateLimit("unit:a", 3, 60_000).ok).toBe(false);
  });

  it("Cashfree webhooks: HMAC over raw bytes, 5-minute freshness window", () => {
    const body = '{"a":"170.00"}';
    const ts = String(Date.now());
    const sig = createHmac("sha256", "s3cret").update(ts + body).digest("base64");
    expect(verifyCashfreeWebhook(body, ts, sig, "s3cret")).toBe(true);
    expect(verifyCashfreeWebhook('{"a":170}', ts, sig, "s3cret")).toBe(false);
    expect(verifyCashfreeWebhook(body, ts, sig, "")).toBe(false);
    expect(webhookTimestampFresh(ts)).toBe(true);
    expect(webhookTimestampFresh(String(Date.now() - 10 * 60_000))).toBe(false);
    expect(webhookTimestampFresh(String(Math.floor(Date.now() / 1000)))).toBe(true); // seconds tolerated
    expect(webhookTimestampFresh("abc")).toBe(false);
  });

  it("audit metadata never stores credentials, OTP or recovery codes", async () => {
    const { writeAudit } = await import("@/server/core/audit");
    let stored: any = null;
    const fakeDb: any = { auditLog: { create: async ({ data }: any) => { stored = data; } } };
    await writeAudit(fakeDb, { action: "x", meta: { password: "p", otp: "123456", recoveryCode: "abcde-fghij", nested: { apiKey: "k", authorization: "Bearer z" }, code: "PERMISSION_DENIED" } });
    expect(stored.meta).toEqual({ password: "[redacted]", otp: "[redacted]", recoveryCode: "[redacted]", nested: { apiKey: "[redacted]", authorization: "[redacted]" }, code: "PERMISSION_DENIED" });
  });

  it("security headers: CSP forbids framing, plugins and foreign scripts", async () => {
    const { CONTENT_SECURITY_POLICY } = await import("../../next.config");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("base-uri 'self'");
    expect(CONTENT_SECURITY_POLICY).toMatch(/script-src 'self' 'unsafe-inline'( 'unsafe-eval')? https:\/\/sdk\.cashfree\.com/);
  });
});
