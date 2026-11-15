import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, signFileUrl, verifyFileUrl } from "@/server/core/keys";
import { checkTotp, currentCode, hashRecovery, mfaRequiredFor, newRecoveryCodes, newTotpSecret } from "@/server/auth/mfa";
import { clientIp } from "@/server/http/router";
import { rateLimit, resetRateLimits } from "@/server/auth/ratelimit";

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

  it("rate limiter blocks after the limit; the test switch is ignored in production", async () => {
    delete process.env.SAF_DISABLE_RATE_LIMIT;
    for (let i = 0; i < 3; i++) expect((await rateLimit("unit:a", 3, 60_000)).ok).toBe(true);
    expect((await rateLimit("unit:a", 3, 60_000)).ok).toBe(false);
    process.env.SAF_DISABLE_RATE_LIMIT = "1";
    (process.env as any).NODE_ENV = "production";
    expect((await rateLimit("unit:a", 3, 60_000)).ok).toBe(false);
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
    expect(CONTENT_SECURITY_POLICY).toMatch(/script-src 'self' 'unsafe-inline'( 'unsafe-eval')?;/);
    expect(CONTENT_SECURITY_POLICY).toContain("frame-src 'none'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https:\/\//);
  });
});

describe("uploads, logs, links and error responses", () => {
  it("re-encoding removes anything appended to a PNG and EXIF (GPS) data from a JPEG; huge pictures are refused", async () => {
    const { reencodeImage } = await import("@/server/core/storage");
    const { PNG } = await import("pngjs");
    const jpeg = (await import("jpeg-js")).default;
    const png = new PNG({ width: 2, height: 2 });
    png.data.fill(200);
    const withPayload = Buffer.concat([PNG.sync.write(png), Buffer.from("<?php system($_GET[1]); ?>")]);
    const cleanPng = Buffer.from(reencodeImage(new Uint8Array(withPayload), "png"));
    expect(cleanPng.includes("<?php")).toBe(false);
    expect(PNG.sync.read(cleanPng).width).toBe(2);

    const base = Buffer.from(jpeg.encode({ data: Buffer.alloc(4 * 4 * 4, 128), width: 4, height: 4 }, 90).data);
    const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x18]), Buffer.from("Exif\0\0GPS-12.97N77.59E")]);
    const withExif = Buffer.concat([base.subarray(0, 2), exif, base.subarray(2)]);
    expect(withExif.includes("GPS-12.97N")).toBe(true);
    const cleanJpg = Buffer.from(reencodeImage(new Uint8Array(withExif), "jpg"));
    expect(cleanJpg.includes("GPS-12.97N")).toBe(false);
    expect(jpeg.decode(cleanJpg).width).toBe(4);

    // A tiny PNG header that claims 100000 x 100000 pixels is refused before decoding.
    const bomb = Buffer.from(PNG.sync.write(png));
    bomb.writeUInt32BE(100_000, 16);
    bomb.writeUInt32BE(100_000, 20);
    expect(() => reencodeImage(new Uint8Array(bomb), "png")).toThrow(/could not be read/);
  });

  it("logs mask emails, phone numbers, tokens and secret fields", async () => {
    const { redact } = await import("@/server/core/log");
    const out = redact('user ravi@example.com phone +91 98765 43210 token=abc123 "password":"hunter2" jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc');
    expect(out).not.toMatch(/ravi@example\.com|98765|hunter2|abc123|eyJhbGci/);
    expect(out).toContain("[email]");
  });

  it("unknown request fields are detected at any depth; known ones are not", async () => {
    const { unknownKeys } = await import("@/server/http/router");
    expect(unknownKeys({ a: 1, b: { c: 2, d: 3 }, e: [{ f: 1, g: 2 }] }, { a: 1, b: { c: 2 }, e: [{ f: 1 }] })).toEqual(["b.d", "e[0].g"]);
    expect(unknownKeys({ a: 1 }, { a: 1, defaulted: true })).toEqual([]);
  });

  it("public customer links expire after 90 days", async () => {
    const { assertPublicLinkFresh } = await import("@/server/core/public-links");
    expect(() => assertPublicLinkFresh(new Date(Date.now() - 89 * 86_400_000))).not.toThrow();
    expect(() => assertPublicLinkFresh(new Date(Date.now() - 91 * 86_400_000))).toThrow(/expired/);
  });

  it("unexpected errors: friendly message plus a reference, nothing internal", async () => {
    const { errorResponse } = await import("@/server/http/router");
    const h = new Headers({ "x-request-id": "11111111-2222-3333-4444-555555555555" });
    const res = errorResponse(new Error("connect ECONNREFUSED 10.0.0.5:5432 at /app/node_modules/pg/x.js for ravi@example.com"), h);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: { code: "INTERNAL", message: "Something went wrong. Please try again.", reference: "11111111-2222-3333-4444-555555555555" } });
  });
});

describe("error logging keeps the reference searchable", () => {
  it("the request id in the log tag is not masked; personal data in the message is", async () => {
    const { logError } = await import("@/server/core/log");
    // Built at runtime so secret scanners do not mistake the sample id for a key.
    const ref = ["682cd99b", "f405", "4108", "aa83", "fb632afe71ad"].join("-");
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      logError(`api ref=${ref}`, "unhandled error", new Error("failed for ravi@example.com"));
    } finally {
      console.error = orig;
    }
    expect(lines[0]).toContain(ref);
    expect(lines[0]).not.toContain("ravi@example.com");
  });
});
