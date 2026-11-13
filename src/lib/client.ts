"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

let currentBranch: string | null = null;
/** Set by the product shell; sent with every request so data is branch-scoped. */
export function setActiveBranch(id: string | null) {
  currentBranch = id;
}

/**
 * Sensitive actions answer STEP_UP_REQUIRED until the user re-authenticates.
 * <StepUpPrompt/> registers a handler that asks for the password / code; the
 * request is then retried once, so screens need no special handling.
 */
let stepUpHandler: (() => Promise<boolean>) | null = null;
export function setStepUpHandler(fn: (() => Promise<boolean>) | null) {
  stepUpHandler = fn;
}

interface CallOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  form?: FormData;
  /** Do not redirect to /login on 401 (used by the login page itself). */
  noRedirect?: boolean;
}

export async function api<T = any>(path: string, opts: CallOptions = {}): Promise<T> {
  try {
    return await call<T>(path, opts);
  } catch (e) {
    if (e instanceof ApiError && e.code === "STEP_UP_REQUIRED" && stepUpHandler && (await stepUpHandler())) return call<T>(path, opts);
    throw e;
  }
}

async function call<T>(path: string, opts: CallOptions): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.form ? "POST" : "GET");
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["x-saf-request"] = "1";
  if (currentBranch) headers["x-saf-branch"] = currentBranch;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body, credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ApiError(0, "NETWORK", "Cannot reach the server. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const data = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    // Server errors carry a reference (the request id) the user can quote to support.
    const reference = res.status >= 500 ? (data?.error?.reference ?? res.headers.get("x-request-id")) : null;
    const base = data?.error?.message ?? (res.status >= 500 ? "Something went wrong. Please try again." : "The request could not be completed.");
    const err = new ApiError(res.status, data?.error?.code ?? "ERROR", reference ? `${base} (Reference: ${reference})` : base, data?.error?.details);
    if (typeof window !== "undefined" && !opts.noRedirect) {
      if (err.code === "MFA_REQUIRED" && window.location.pathname !== "/mfa") {
        window.location.href = "/mfa";
      } else if (err.code === "MFA_ENROLLMENT_REQUIRED" && window.location.pathname !== "/account/security") {
        window.location.href = "/account/security?required=1";
      } else if (res.status === 401 && !window.location.pathname.startsWith("/login") && window.location.pathname !== "/mfa") {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      } else if (err.code === "PASSWORD_CHANGE_REQUIRED" && window.location.pathname !== "/change-password") {
        window.location.href = "/change-password";
      }
    }
    throw err;
  }
  return data as T;
}

export interface Loaded<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** True while refetching with previous data still shown (no skeleton flash). */
  refreshing: boolean;
  reload: () => Promise<void>;
  setData: (d: T) => void;
}

/**
 * Loads `path` (null = skip). Keeps the previous data on screen while
 * refetching. `refreshMs` polls, pausing while the tab is hidden.
 */
export function useApi<T = any>(path: string | null, opts: { refreshMs?: number } = {}): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    setRefreshing(true);
    try {
      const d = await api<T>(path);
      if (mine === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)));
    } finally {
      if (mine === seq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [path]);

  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    void load();
  }, [path, load]);

  useEffect(() => {
    if (!path || !opts.refreshMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, opts.refreshMs);
    return () => clearInterval(t);
  }, [path, opts.refreshMs, load]);

  return { data, error, loading, refreshing, reload: load, setData };
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

/** Reads a nested value: get(row, "category.name"). */
export function get(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}
