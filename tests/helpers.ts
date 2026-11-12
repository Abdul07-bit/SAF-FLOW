import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import { handleRequest } from "@/server/api";
import { TEST_ENV } from "./env";

export interface ApiResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** Calls the real API dispatcher exactly as the Next.js route handler does. */
export async function api<T = any>(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; headers?: Record<string, string>; csrf?: boolean } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { "x-forwarded-for": "10.0.0.1", ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (method !== "GET" && opts.csrf !== false) headers["x-saf-request"] = "1";
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await handleRequest(new Request(`http://localhost:3000/api${path}`, { method, headers, body }));
  const type = res.headers.get("content-type") || "";
  const parsed = type.includes("application/json") ? await res.json() : type.includes("pdf") ? new Uint8Array(await res.arrayBuffer()) : await res.text();
  return { status: res.status, body: parsed as T, headers: res.headers };
}

export function sessionCookieFrom(res: ApiResult): string {
  const raw = res.headers.get("set-cookie") || "";
  const m = raw.match(/saf_session=([^;]+)/);
  if (!m) throw new Error(`No session cookie in response (status ${res.status}): ${JSON.stringify(res.body)}`);
  return `saf_session=${m[1]}`;
}

export const STRONG_PASSWORD = "NewPassw0rd!x";

/** Signs in; if a temporary password must be changed, changes it to STRONG_PASSWORD. */
export async function login(username: string, password: string): Promise<string> {
  const res = await api("POST", "/auth/login", { body: { username, password } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const cookie = sessionCookieFrom(res);
  if (res.body.mustChangePassword) {
    const ch = await api("POST", "/auth/change-password", { cookie, body: { currentPassword: password, newPassword: STRONG_PASSWORD } });
    expect(ch.status, JSON.stringify(ch.body)).toBe(200);
  }
  return cookie;
}

let adminCookie: string | null = null;
export async function adminLogin(): Promise<string> {
  adminCookie ??= await login(TEST_ENV.SAF_ADMIN_USERNAME, TEST_ENV.SAF_ADMIN_PASSWORD);
  return adminCookie;
}

export function uniqueCode(prefix = "T"): string {
  return (prefix + randomBytes(4).toString("hex")).toUpperCase().slice(0, 10);
}

type Sel = { productCode: "dine" | "stay" | "bill"; tier: "BASIC" | "GROWTH"; billingCycle?: "MONTHLY" | "ANNUAL" } & Record<string, unknown>;

export async function createBusiness(products: Sel[], extra: Record<string, unknown> = {}) {
  const admin = await adminLogin();
  const code = uniqueCode();
  const res = await api("POST", "/admin/businesses", {
    cookie: admin,
    body: {
      name: `Test Business ${code}`, category: "HOTEL", ownerName: "Owner Person", phone: "9876543210", email: "owner@example.com",
      address: "MG Road", city: "Bengaluru", code,
      products: products.map((p) => ({ billingCycle: "MONTHLY", ...p })),
      ...extra,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const manager = await login(res.body.managerUsername, res.body.temporaryPassword);
  return { ...res.body, manager, admin } as { tenantId: string; code: string; managerUsername: string; temporaryPassword: string; manager: string; admin: string };
}

/** Creates a staff login with roles and returns a signed-in cookie for it. */
export async function createStaff(managerCookie: string, product: string, handle: string, access: { product: string; roleCode: string }[]) {
  const res = await api("POST", `/${product}/team`, { cookie: managerCookie, body: { fullName: `Staff ${handle}`, handle, access } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const cookie = await login(res.body.username, res.body.temporaryPassword);
  return { id: res.body.id as string, username: res.body.username as string, cookie };
}

export function expectError(res: ApiResult, status: number, code?: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  if (code) expect(res.body?.error?.code).toBe(code);
}
