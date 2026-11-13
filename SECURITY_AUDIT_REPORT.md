# SAF Flow — Security Audit Report

**Date:** 2026-11-13 · **Branch:** `security/hardening` · **Baseline:** commit `3554f5d`
**Standards:** OWASP ASVS 5.0.0, OWASP API Security Top 10 (2023)
**Scope:** the whole repository (Next.js 15 app, API router, Prisma/PostgreSQL schema and migrations, Supabase Auth integration, Cashfree payments, file storage, Docker/nginx deployment files, dependencies, git history).

No secret values were read into or written to this report. Configuration was reviewed by variable **name** and code usage only.

---

## 1. Summary

| Severity | Found | Fixed | Remaining |
|---|---:|---:|---:|
| Critical | 0 | 0 | 0 |
| High | 3 | 3 | 0 |
| Medium | 14 | 12 | 2 |
| Low | 19 | 14 | 5 |
| **Total** | **36** | **29** | **7** |

_Updated 2026-11-13 after the pre-launch review (§7): SEC-24 and SEC-26 fixed; SEC-33 to SEC-36 found and fixed._

**Overall:** the baseline was already well designed. Every route has to declare an authorization policy. Tenant isolation is enforced by PostgreSQL Row-Level Security under a non-superuser, non-`BYPASSRLS` role. Passwords use Argon2id. Session tokens are stored hashed, and payment amounts are calculated on the server. **No cross-tenant data leak was found.** The fixed findings fall into three groups:
- **Missing defence layers:** MFA, step-up re-authentication, CSP and HSTS, body-size limits.
- **Gaps in the database guards:** catalog tables were writable from a tenant scope, and foreign keys skip RLS.
- **Logic flaws:** a payment double-settlement race, and a manager able to take over another manager's account.

### What was verified to work as claimed (tested, not assumed)
- In tenant A's database scope, **all 59 tables with a `tenant_id` column** return zero rows of tenant B, and no `UPDATE` can reach them (`tests/integration/security.test.ts`).
- The runtime role `saf_app` is not a superuser and cannot bypass RLS. With no tenant context it sees nothing (fail-closed).
- **All 318 API endpoints (221 hand-written routes plus generated create/read/update/delete endpoints)** were checked automatically: every non-public route returns 401 to anonymous callers, and every non-public state-changing route rejects requests without the CSRF header.
- No server secrets appear in the production browser bundle, and no browser source maps are emitted (checked with a `next build` plus a search of the bundle).
- There are no `$queryRawUnsafe` / `$executeRawUnsafe` calls in application code. All SQL goes through Prisma or tagged-template parameters.
- No secrets were found in git history (pattern scan of all commits); `.env` is git-ignored.

---

## 2. Architecture inventory (what was audited)

| # | Area | Finding |
|---|---|---|
| 1 | Frontend | Next.js 15 App Router, React 19, client components call `/api/*` with `credentials: same-origin` and a custom `x-saf-request` header. |
| 2 | Backend | One catch-all route → `src/server/http/router.ts`, which matches routes and enforces policy (`public` / `session` / `platform` / `product`). |
| 3 | Authentication | Email accounts use Supabase Auth password checks; login-ID staff use local Argon2id. SAF issues its own opaque session (SHA-256 hashed in `sessions`), HttpOnly, `SameSite=Lax`, `Secure` on https. |
| 4 | Authorization | Platform RBAC (`src/config/platform.ts`, DB-backed roles, per-assignment narrowing). Tenant RBAC per product (`src/config/catalog.ts`) plus plan entitlements plus branch restrictions (`src/server/core/access.ts`). |
| 5 | Database | PostgreSQL 17 via Prisma 6. Owner role runs migrations; `saf_app` is the runtime role. |
| 6 | Multi-tenancy | RLS on every tenant table via `app.tenant_id` / `app.staff_user_id` / `app.bypass_rls` transaction settings (`src/server/db.ts`). |
| 7 | API endpoints | 318 endpoints, inventory in `docs/openapi.json`; 14 public (login, reset, QR menu/order, public invoice, ID verification, files, health, cron, webhook, OpenAPI). |
| 8 | DB access policies | Policies in `prisma/migrations/*rls_security*`, `*saf_flow_foundation*`, and now `*security_hardening*`. |
| 9 | File storage | Local disk or S3. PNG/JPEG only, verified by magic bytes, 2 MB, random UUID keys, path-traversal guard; served by `GET /api/files/*`. |
| 10 | Payments | Cashfree PG: server-created orders, server-side status read-back, HMAC-signed webhook. |
| 11 | WhatsApp / 3rd party | **No WhatsApp integration exists.** "WhatsApp" is only a support phone number setting. Supabase Auth is the only other third party. |
| 12 | AI agents | **None exist.** No LLM, agent or automation-execution code is in the repository. |
| 13 | Secrets | Environment variables only (`.env` git-ignored). No secrets in the database. `NEXT_PUBLIC_*` holds only the Supabase URL and publishable key. |
| 14 | Hosting | Dockerfile (multi-stage, non-root runtime user), docker-compose (Postgres, MinIO, app, nginx), nginx overwrites `X-Forwarded-For`. |
| 15 | CI/CD | **None existed.** Added `.github/workflows/security.yml` (see §6). The repo has no git remote, so the workflow has not run on GitHub yet. |
| 16 | Dependencies | `npm audit` at baseline: 2 critical, 3 high, 1 moderate (details in SEC-03 / SEC-21). Now 0. |

---

## 3. Fixed findings

Line references are **before** the fix (baseline `3554f5d`), then **after**.

### SEC-01 · High · No multi-factor authentication for administrators and owners
- **Component:** authentication (`src/server/routes/auth.ts:119`, `src/server/auth/session.ts`).
- **Evidence:** a password alone gave a full session for SAF Super Admins (cross-tenant access) and business owners. No second factor existed anywhere.
- **Impact:** one phished or reused password for a Super Admin exposes every business on the platform.
- **Fix:**
  - TOTP MFA (RFC 6238 via the `otpauth` library), with the secret encrypted using AES-256-GCM (`src/server/core/keys.ts`).
  - Replay protection: each time step is accepted once (`users.mfa_last_step`, conditional update).
  - 10 single-use recovery codes, stored as hashes.
  - A password-only login creates a 10-minute "MFA pending" session that can only call `/auth/mfa/verify`. Verification revokes it and issues a **new** session (session rotation).
  - Five wrong codes end the attempt and lock the account.
  - Policy `SAF_MFA_REQUIRED` (default in production: `platform,owners`) forces enrolment before any other API call (`MFA_ENROLLMENT_REQUIRED`).
  - A password reset by email link no longer bypasses MFA (`src/server/routes/auth.ts:322`).
  - Files: `src/server/auth/mfa.ts`, `src/server/routes/mfa.ts`, `src/app/mfa/page.tsx`, `src/app/account/security/page.tsx`.
- **Tests:**
  - `security.test.ts` › "multi-factor authentication" (2 tests): enrol, pending-session lockdown, rotation, replay, recovery reuse, brute force, admin reset, enforcement policy.
  - `tests/unit/security.test.ts` › TOTP, keys.

### SEC-02 · High · Online payment could be settled twice (race)
- **Component:** `settleGatewayOrder`, `src/server/routes/tenant.ts:415-423`.
- **Evidence:** the code read the payment status and then called `update` unconditionally. The browser confirmation (`/billing/cashfree/confirm`) and the Cashfree webhook arrive together by design. Both could read `PENDING` and both run `markInvoicePaid`.
- **Impact:** the invoice settled twice, with duplicate audit and financial events, and possibly a double subscription extension.
- **Fix:** compare-and-set (`updateMany … where status <> 'SUCCEEDED'`). Only the caller that wins the row lock settles the invoice (`src/server/routes/tenant.ts:451`). Amount mismatches are now written to the audit log.
- **Test:** `billing.test.ts` › "webhook: … settles exactly once (even racing the browser)". The webhook and the confirmation run concurrently, and the test asserts exactly one `SUCCEEDED` payment and one settlement audit entry.

### SEC-03 · High · Production dependency advisory (deepmerge-ts via Prisma)
- **Component:** `prisma` → `@prisma/config` → `deepmerge-ts <8` (GHSA-ggr8-5vv4-36mx, stack exhaustion).
- **Impact:** low in practice (it only processes Prisma's own config at CLI time), but it is a High advisory in the shipped dependency tree and would block a strict CI gate.
- **Fix:** an npm `override` pins `deepmerge-ts@8.0.2` (`package.json`). Verified: `prisma generate`, `prisma migrate status` and the full test suite pass. `npm audit` now reports **0 vulnerabilities**.
- **Follow-up:** see SEC-29 / the upgrade to Prisma 7.

### SEC-04 · Medium · Global catalog tables writable from a tenant scope
- **Component:** `roles`, `role_permissions`, `permissions`, `plans`, `plan_features`, `products`, `feature_catalog`, `platform_settings` had **no RLS** (checked in `pg_class`).
- **Evidence:** the app role had `INSERT/UPDATE/DELETE` on these tables in every scope.
- **Impact:** one coding bug in any tenant route (for example a mistyped Prisma delegate) could rewrite role permissions or prices for **every** business. That's privilege escalation across tenants.
- **Fix:** RLS with read-all and write only in platform scopes (`prisma/migrations/20261113120000_security_hardening/migration.sql:46`).
- **Test:** `security.test.ts` › "global catalog … cannot be changed from a tenant scope".

### SEC-05 · Medium · Foreign keys skip RLS: cross-tenant references possible at the database level
- **Component:** 66 single-column foreign keys between tenant-owned tables.
- **Evidence:** PostgreSQL validates foreign keys without RLS. The generic CRUD layer checked references (`REF_MODELS`), but nothing in the database stopped a custom route, a future bug or the platform scope from linking tenant A's row to tenant B's record.
- **Impact:** integrity corruption across businesses; an existence oracle on another tenant's IDs; tenant B's deletes blocked by A's references.
- **Fix:** trigger `saf_check_tenant_refs` (migration line 67), installed automatically on **all 40 child tables**. It rejects any reference whose parent belongs to a different tenant (parents with `tenant_id IS NULL`, such as SAF Team users, are allowed). The API returns `400 INVALID_REFERENCE`.
- **Tests:** `security.test.ts` › "a row can never reference another business's record, in any scope". It also asserts that every tenant→tenant foreign key has the trigger, so a new table without it fails CI.

### SEC-06 · Medium · Employee photos served publicly with permanent URLs
- **Component:** `GET /api/files/*key` (`src/server/routes/system.ts:19`), `fileUrl` (`src/server/core/storage.ts:110`).
- **Evidence:** the route was `public`, and photo URLs never expired.
- **Impact:** a leaked or shared URL (browser history, screenshots, a forwarded ID-verification page) exposes staff photos (personal data) indefinitely.
- **Fix:** files in the `employees` folder need an HMAC-signed URL that expires within 1-2 hours (`src/server/core/storage.ts:123`, `src/server/routes/system.ts:27`). Logos stay public because QR menus and invoices need them. Responses add `CSP: sandbox`, `nosniff` and `CORP: same-origin`.
- **Tests:** `security.test.ts` › "files"; `tests/unit/security.test.ts` › "signed file URLs".

### SEC-07 · Medium · A manager could take over another manager's account
- **Component:** `loadMember`, `src/server/routes/tenant.ts:87`.
- **Evidence:** only the owner account was protected. Any user with `staff.manage` (non-owner managers) could reset a fellow manager's password, which returns the new temporary password, or disable them.
- **Impact:** sideways privilege takeover inside a business, and loss of accountability (actions done "as" another manager).
- **Fix:** non-owners can no longer act on other manager-level accounts (`src/server/routes/tenant.ts:87-100`). Only the owner can reset staff MFA.
- **Test:** `security.test.ts` › "staff cannot grant themselves or others more power; managers cannot take over other managers".

### SEC-08 · Medium · No request body size limit in the application
- **Component:** `src/server/http/router.ts:204-206` (`req.formData()` / `req.text()` read unbounded).
- **Impact:** memory exhaustion (denial of service) wherever the app is reachable without the bundled nginx (`client_max_body_size 5m`).
- **Fix:** streaming cap — 1 MB for JSON, 3 MB for multipart — enforced even without `Content-Length` (`router.ts:185`). The webhook is capped at 64 KB.
- **Test:** `security.test.ts` › "oversized bodies are refused, with or without a Content-Length".

### SEC-09 · Medium · Spoofable client IP (rate-limit bypass, forged audit IPs)
- **Component:** `clientIp`, `router.ts:151`, used the **leftmost** `X-Forwarded-For` entry.
- **Impact:** without the bundled nginx (or behind a proxy that appends), any caller picks its own IP. That gives unlimited login attempts across rotating fake IPs and false IPs in the audit trail.
- **Fix:** trust only `TRUSTED_PROXY_HOPS` hops from the right (default 1, matching the bundled nginx; `0` = no proxy) (`router.ts:173`).
- **Test:** `tests/unit/security.test.ts` › "client IP comes from the trusted proxy hop".

### SEC-10 · Medium · No Content-Security-Policy and no HSTS
- **Component:** `next.config.ts:4`.
- **Fix:**
  - A CSP that allows only the app's own origin plus the Cashfree checkout, with `frame-ancestors 'none'`, `object-src 'none'` and `base-uri 'self'`.
  - HSTS (1 year) once `APP_URL` is `https://`.
  - `productionBrowserSourceMaps: false`, `X-DNS-Prefetch-Control`, and `payment=(self)` in `Permissions-Policy`.
- **Test:** `tests/unit/security.test.ts` › "security headers".

### SEC-11 · Medium · No re-authentication for sensitive actions
- **Evidence:** a stolen or unattended session could immediately change roles, reset passwords, disable staff, change payment-related settings, suspend businesses or manage SAF Team roles.
- **Fix:**
  - New `stepUp: true` route option. **26 sensitive routes** now need a fresh authentication (sign-in, MFA, or `POST /auth/step-up` with a TOTP code or the password) within `STEP_UP_WINDOW_MINUTES` (default 10).
  - The routes cover team management (create, edit roles, reset password, disable), settings, the business profile, SAF Team invites and roles, platform settings, plan pricing, business suspension, admin password resets, manual payments, invoice voids, MFA reset and session revocation.
  - In the browser, a "Confirm it's you" dialog retries the request automatically (`src/components/step-up.tsx`).
- **Test:** `security.test.ts` › "sensitive actions need a fresh authentication (step-up)".

### SEC-12 · Medium · Cashfree webhook: no replay window, payload trusted, currency unchecked
- **Component:** `src/server/routes/tenant.ts:454`.
- **Evidence:** a correctly signed webhook could be replayed at any time. Settlement used the amount in the webhook body, and the currency was never checked.
- **Fix:**
  - A ±5-minute timestamp window (`cashfree.ts:123`).
  - The webhook now only names the order. Status, amount and payment ID are **read back from Cashfree's API** before settling.
  - Non-INR orders are refused.
  - The order ID format is validated, and unknown orders are ignored.
- **Tests:** `billing.test.ts` webhook test (stale timestamp, unpaid order not settled); `tests/unit/security.test.ts` › webhooks.

### SEC-31 · Medium · Supabase Data API would expose SAF's `public` schema
- **Context:** the planned production database is Supabase Postgres (hybrid set-up). Supabase's Data API (PostgREST) grants the `anon` and `authenticated` roles access to the `public` schema, and the publishable key that selects `anon` is public by design.
- **Impact:** tenant tables still return nothing to those roles, because the RLS policies need SAF's tenant setting. But `_prisma_migrations` (no RLS), the catalog tables (read policy `true`) and the `saf_*` helper functions would be readable or callable by anyone on the internet, and any future table created without RLS would be fully exposed.
- **Fix:**
  - Migration `20261113150000_supabase_data_api_lockdown` revokes all table, sequence and function privileges in `public` from `anon`/`authenticated` (including future objects), removes the default `PUBLIC` execute on functions, and re-grants `EXECUTE` only to `saf_app`.
  - It does nothing on plain PostgreSQL (local, CI).
  - `scripts/security-preflight.mjs` now also rejects a `postgres.<project>` / owner login in `DATABASE_URL`, because Supabase's `postgres` role can bypass RLS.
- **Verification:** simulated with Supabase-style roles and grants in a throwaway local database. Afterwards `anon` has no access to existing or newly created tables or functions, while `saf_app` keeps function access and RLS queries work. Not yet run against the real Supabase project, which has no SAF database connected yet. Re-check after the first deploy with the query in `SECURITY_CHECKLIST.md`.

### SEC-32 · Medium · Production container shipped the npm CLI with 10 HIGH CVEs
- **Component:** `Dockerfile` runtime stage (`node:22-bookworm-slim`).
- **Evidence:** a Trivy image scan found 10 HIGH vulnerabilities, all in npm's own dependencies (`brace-expansion`, `ip-address`, `pacote`, `picomatch`, `sigstore` under `/usr/local/lib/node_modules/npm`). The runtime never uses npm: it starts with `node server.js`.
- **Impact:** unnecessary vulnerable code and tools in the production image. If an attacker gained code execution, npm would make further downloads and installs easier.
- **Fix:** npm, npx and corepack are removed from the runtime stage. Re-scan: **0 HIGH/CRITICAL**. The image also runs as uid 1001 (non-root) and contains no `.env`.

### SEC-13 · Low · Audit trail mutable by the owner role and by cascades
- **Evidence:** only `saf_app` had `UPDATE/DELETE` revoked (`rls_security/migration.sql:97`). The owner role, a migration or a tenant-delete cascade could change history.
- **Fix:** a trigger `saf_audit_immutable` blocks `UPDATE`/`DELETE` for every role. A deliberate retention purge requires `SET app.audit_purge='on'` in a DBA session (documented in `SECURITY_INCIDENT_RESPONSE.md`).
- **Test:** `security.test.ts` › "audit records are immutable even for the database owner role".

### SEC-14 · Low · Account enumeration on the sign-in form
- **Evidence:** `auth.ts:81` returned `423 ACCOUNT_LOCKED` and `auth.ts:84` returned `403 INVITATION_PENDING` **before** any password check, which confirms an account exists.
- **Fix:** both now return the same `401 INVALID_CREDENTIALS` as a wrong password (the message mentions temporary locks), after the same Argon2 timing work.
- **Tests:** updated `platform.test.ts` and `saf-flow-foundation.test.ts`.

### SEC-15 · Low · Anonymous callers reached input validation
- **Evidence:** the body was parsed and validated before authentication (`router.ts:206` before `:238`). Unauthenticated callers received detailed schema errors.
- **Fix:** protected routes without a session cookie get 401 before any parsing (`router.ts:252`).
- **Test:** `security.test.ts` › "every non-public endpoint refuses anonymous callers (401)…" (all 318 endpoints).

### SEC-16 · Low · Malformed IDs caused 500 errors
- **Evidence:** Prisma `P2023` (invalid UUID) was unmapped (`router.ts:378`), so `GET /dine/tables/' OR 1=1` returned a 500.
- **Fix:** mapped to 404. Unhandled errors now log only the name, message and request ID.
- **Test:** `security.test.ts` › "malformed and injected ids are simply not found…".

### SEC-17 · Low · Endpoint inventory public in production
- **Evidence:** `GET /api/docs/openapi.json` (`system.ts:50`) was public everywhere.
- **Fix:** not served in production unless `PUBLIC_API_DOCS=1`.

### SEC-18 · Low · Test switch could disable rate limiting in production
- **Evidence:** `SAF_DISABLE_RATE_LIMIT=1` was honoured in every environment (`ratelimit.ts:16`).
- **Fix:** ignored when `NODE_ENV=production`; also checked by the pre-flight script.
- **Test:** unit "rate limiter … the test switch is ignored in production".

### SEC-19 · Low · Audit redaction missed OTP, cookie, authorization and API-key fields
- **Component:** `audit.ts:16`.
- **Fix:** the redaction list now covers `otp`, `totp`, `mfa_code`, `recovery_code`, `cookie`, `authorization`, `api_key`, `private_key`, `cvv` and `card_number`.
- **Tests:** unit "audit metadata never stores credentials…"; the integration MFA test asserts that no OTP or recovery code appears in the audit trail.

### SEC-20 · Low · Managers could change the email of an email-identity account
- **Evidence:** `PATCH /:product/team/:id` wrote `email` directly (`tenant.ts:195`). For Supabase-identity accounts this desyncs the login identity from the profile and redirects reset emails.
- **Fix:** refused for email-identity accounts (`tenant.ts:199`).

### SEC-21 · Low (dev-only) · Critical/High advisories in test tooling
- **Evidence:** `vitest <4.1.12`, `tinypool`, `@vitest/mocker` (GHSA-82fw-gwwq-j7x9, GHSA-5gmw-xhrv-c9v3, …). These only matter while the Vitest UI or mock server runs, and they don't ship to production.
- **Fix:** upgraded to `vitest@4.1.12`. The full suite passes on it.

---

## 4. Remaining findings (not fixed)

### SEC-22 · Medium · RLS scope settings can be set by the application role
- **Detail:** `app.bypass_rls`, `app.tenant_id` and `app.staff_user_id` are ordinary transaction settings. The database layer protects against **query bugs** (a forgotten `where`) but not against **code execution inside the app server**: an attacker who can run arbitrary SQL as `saf_app` can set the bypass flag.
- **Why not fixed:** a robust fix (separate DB roles per scope with `SET ROLE`, or signed context via a `SECURITY DEFINER` gatekeeper) is an architectural change touching every transaction helper, and needs a performance review.
- **Current mitigations:** there's no raw-SQL-from-input path, Semgrep and CodeQL run in CI, and the role isn't a superuser.
- **Recommendation:** two roles (`saf_tenant` without bypass, `saf_platform` with it). Request handlers for tenants connect with the first.

### SEC-23 · Medium · Backups are unencrypted and their schedule and restore are not verified
- **Detail:** `scripts/backup.sh` writes a database dump and a file archive, and `scripts/restore.sh` can restore into a scratch database to verify one (see `docs/DEPLOYMENT.md` §8). But:
  - the dumps are **plaintext** files containing every tenant's data;
  - the nightly cron entry and the off-server copy are manual set-up steps;
  - no restore test has been recorded;
  - encryption at rest of the database volume depends on the host.
- **Action (needs your infrastructure access):**
  - encrypt the dumps (for example `age`/`gpg` to a key held off-server) before copying them off the server;
  - restrict who can read the backup location;
  - enable provider point-in-time recovery if a managed database is used;
  - run and record a quarterly restore test (`SECURITY_INCIDENT_RESPONSE.md` §9).

### SEC-24 · Low · Rate limiting was per app instance (in memory) — FIXED
- **Detail:** with several app instances (always the case on Vercel), an attacker's attempts spread across them. There were also no per-user limits, and 429s weren't logged.
- **Fix:**
  - Shared sliding-window counters in Upstash Redis (`@upstash/ratelimit`), falling back to memory when it isn't configured.
  - Per-IP **and** per-user limits, plus per-email, per-account and per-table limits. 36 sensitive endpoints get strict limits (§7).
  - Every 429 is written to the audit log (`security.rate_limited`, once per key per window) and shown in the Security Center.
  - The Security Center raises a High alert on Vercel while Upstash isn't configured.
- **Action needed:** add the Upstash keys in Vercel (`docs/VERCEL-AND-APK.md`, step 4a). Until then, limits work per instance only.

### SEC-25 · Low · CSP allows inline scripts
- **Detail:** Next.js needs inline bootstrap scripts, so `script-src` has `'unsafe-inline'`. React escapes all output and no route renders HTML from user input, which keeps the risk low.
- **Recommendation:** nonce-based CSP via middleware.

### SEC-26 · Low · Uploaded images were not re-encoded — FIXED
- **Fix:** every upload is decoded and written as a brand-new PNG/JPEG (`reencodeImage`, `src/server/core/storage.ts`). That removes EXIF (GPS location, camera serials) and anything appended to the file. Pictures over 25 megapixels are refused before decoding ("decompression bombs").
- **Still recommended:** a malware scanner (ClamAV) only if non-image documents are ever accepted.

### SEC-27 · Low · Password policy
- **Detail:** minimum 8 characters with letters and digits, and no breached-password check. ASVS 5 accepts 8 with MFA, but recommends checking against breached-password lists.
- **Recommendation:** add a k-anonymity breached-password check, or a local top-100k list, and raise the minimum for accounts without MFA.

### SEC-28 · Low · MFA coverage
- **Detail:** TOTP only (no passkeys/WebAuthn). The default policy requires MFA for SAF Team and owners, not for other managers.
- **Recommendation:** add `managers` to the policy and add passkeys. The Security Center already shows managers without MFA.

### SEC-30 · Low · The standalone build output contains a copy of the local `.env`
- **Detail:** `next build` with `output: "standalone"` copies `.env` into `.next/standalone/.env`. The Docker build is **not** affected, because `.dockerignore` excludes `.env` and `.next`. The container image built during this audit was checked and contains no `.env` file. But deploying by copying `.next/standalone` to a server by hand would ship whatever secrets are in the build machine's `.env`.
- **Recommendation:** build in CI or Docker only, inject production variables at runtime from the platform's secret store, and never keep production secrets in a developer `.env` (`SECURITY_CHECKLIST.md`).

### SEC-29 · Low · Supply-chain hygiene of the new CI workflow
- **Detail:** third-party actions are pinned to release tags, not commit SHAs. The workflow hasn't run on GitHub yet because the repo has no remote. Prisma 6 relies on the `deepmerge-ts` override until it's upgraded to Prisma 7.
- **Recommendation:** pin actions to SHAs when pushing, enable Dependabot, and plan the Prisma 7 upgrade.

---

## 5. Not applicable (verified absent)
- **AI agents / LLM automation (prompt section 10):** no such code exists. Controls to apply when it's added are in `SECURITY_ARCHITECTURE.md` §10.
- **WhatsApp / Meta integration (section 9):** none exists, only a display phone number.
- **Refunds:** there's no refund feature, so no unauthorised refund path exists.
- **Supabase Storage / RPC functions:** SAF uses Supabase for **Auth only** in code. No Supabase Storage buckets or RPC functions are used, and data access always goes through the SAF API as `saf_app`. When the database itself is hosted on Supabase, see SEC-31. The `SUPABASE_SECRET_KEY` is read only by server code (`src/server/auth/identity.ts`) and was verified absent from the browser bundle.
- **NoSQL injection / request smuggling:** no NoSQL store. Smuggling depends on the proxy in front; the bundled nginx uses HTTP/1.1 keep-alive to a single upstream.

## 6. Issues introduced during this work and caught before commit
The scanners also checked the new code, and found two problems in it that were fixed before commit. They aren't counted in the totals above because they never existed in the original code.
- **AES-GCM authentication tag length not pinned** (`src/server/core/keys.ts`, Semgrep `gcm-no-tag-length`). Truncated tags would have been accepted. Fixed: `authTagLength: 16`; unit test "a truncated authentication tag … is refused".
- **Docker build broken by the dependency upgrade** (`npm ci` refused an inconsistent tree: Vite 8 from Vitest 4 needs esbuild 0.27/0.28, while `tsx` pinned 0.25). Found by building the image. Fixed by upgrading `tsx` to 4.23.15 (`npm ls --all` clean, image builds, all tests pass).
- **Shell injection in the manual ZAP job** (`.github/workflows/security.yml`, Semgrep `run-shell-injection`). The `zap_target` input was interpolated into `run:`. Fixed: it's passed through an environment variable and validated with a strict URL pattern.

## 7. Pre-launch review (2026-11-13, second pass)
The review re-checked secrets, access control, packages, input validation, rate limiting, uploads and errors against the current code.

**Already fine, no change needed**
- No secret in git history (Gitleaks, 6 commits).
- Only public-by-design Supabase keys reach the browser.
- `npm audit` 0, and every package is genuine, maintained and used.
- No raw-HTML rendering, and no SQL built from text.
- Access control proven per endpoint and per table (cross-tenant tests).

**Fixed**

### SEC-33 · Medium · Public invoice and order links never expired — FIXED
- **Detail:** links in the form `/invoice/<token>` show the customer's name and phone number and worked forever.
- **Fix:** they answer `410 LINK_EXPIRED` 90 days after the document date (`PUBLIC_LINK_DAYS`). Staff can still reprint from the app.

### SEC-34 · Low · Unknown request fields were silently dropped — FIXED
- **Fix:**
  - Every body is compared with what its schema keeps, at any depth, and unknown fields get `400 UNKNOWN_FIELDS`.
  - Query parameters are limited to those each schema declares.
  - Bodies sent to no-body endpoints are refused.
  - The settings endpoint accepts only its own product's keys.
  - ID parameters (`id`, `userId`, `tenantId`, `productId`) must be UUIDs.

### SEC-35 · Low · Error responses and logs exposed internals — FIXED
- **Fix:**
  - Error `details` reach the browser only for validation errors, unknown fields and check-out balances. Permission keys and feature lists stay server-side.
  - "Already exists" errors only name user-facing fields.
  - 500 errors return a friendly message plus a reference (the request ID), which the app shows to the user.
  - Branded `error.tsx`, `global-error.tsx` and `not-found.tsx` pages.
  - Server logs keep full stack traces, but emails, phone numbers, tokens and secret fields are masked (`src/server/core/log.ts`).

### SEC-36 · Low · Development passwords could run in production — FIXED
- **Detail:** `docker-compose.yml` falls back to well-known development passwords when variables are missing.
- **Fix:** in production the app now refuses to start with them (`src/instrumentation.ts`). The pre-flight script also checks for them.

## 8. Security tooling added
`.github/workflows/security.yml`:
- the full test suite on PostgreSQL with the real least-privilege role;
- type check;
- the migration safety gate;
- Gitleaks over full history;
- `npm audit` (blocking on production HIGH/CRITICAL);
- Trivy filesystem and container image scans;
- Semgrep (OWASP Top 10, TypeScript, Next.js, secrets);
- CodeQL;
- a manual OWASP ZAP baseline that only accepts staging URLs.

Results so far are in `SECURITY_TEST_REPORT.md`.
