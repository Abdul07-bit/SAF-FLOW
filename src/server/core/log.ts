/**
 * Server-side error logging without personal data or secrets.
 *
 * Full details (including stack traces) go to the server logs so problems can
 * be fixed, but emails, phone numbers and token-like strings are masked first:
 * some library errors (database, payment gateway, identity provider) quote
 * the values that were being processed.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\w-])\+?\d[\d\s-]{8,}\d(?![\w-])/g;
const TOKEN = /\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+|[A-Za-z0-9_-]{32,}|[A-Fa-f0-9]{32,})\b/g;
const SECRET_FIELD = /("?(?:password|secret|token|authorization|cookie|api[_-]?key|access[_-]?token)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi;

export function redact(text: string): string {
  return text
    .replace(SECRET_FIELD, "$1[redacted]")
    .replace(EMAIL, "[email]")
    .replace(TOKEN, "[token]")
    .replace(PHONE, "[number]");
}

function describe(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? `\n${v.stack.split("\n").slice(1, 12).join("\n")}` : ""}`;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v)?.slice(0, 2000) ?? String(v);
  } catch {
    return String(v);
  }
}

/** console.error with every argument redacted. */
export function logError(tag: string, ...parts: unknown[]) {
  console.error(`[${tag}]`, ...parts.map((p) => redact(describe(p)).slice(0, 4000)));
}
