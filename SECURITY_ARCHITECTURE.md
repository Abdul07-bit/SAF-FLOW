# SAF Flow — Security Architecture

How SAF Flow keeps businesses apart, decides who may do what, and protects credentials, payments and files. For each control, the code that implements it is listed first.

## 1. Request path

```
Browser ── HTTPS ──> nginx (TLS, limit_req, overwrites X-Forwarded-For)
                       └─> Next.js app  /api/*  ─> src/server/http/router.ts
                                                   1 rate limit (per IP, per route)
                                                   2 no session cookie on a protected route -> 401
                                                   3 CSRF header on state changes
                                                   4 body size cap (1 MB JSON / 3 MB upload) + schema validation (zod)
                                                   5 session -> MFA state -> forced password change -> MFA enrolment -> step-up
                                                   6 policy: public | session | platform | product
                                                   7 handler runs inside a database transaction bound to ONE scope
                                                   8 automatic audit entry for every mutation (with request id)
```

Every route **must** declare exactly one policy (`router.ts`, type `Policy`). There's no default, so an endpoint can't be exposed by forgetting an annotation. A test checks all 318 endpoints for anonymous access and CSRF.

## 2. Tenant isolation (defence in depth)

| Layer | Control | Code |
|---|---|---|
| Identity | The tenant is taken from the server-side session (`users.tenant_id`), never from the request. | `router.ts` product policy |
| Query | Handlers filter by `ctx.tenantId`. | route files |
| Database | RLS on **every** table with `tenant_id`, `FORCE` even for the owner. The runtime role `saf_app` is `NOSUPERUSER NOBYPASSRLS`. | `prisma/migrations/*_rls_security`, `*_saf_flow_foundation` |
| Database | No tenant context means zero rows (fail-closed). | same |
| Database | References between tenant tables must stay inside one tenant (trigger `saf_check_tenant_refs`; foreign keys alone skip RLS). | `*_security_hardening` |
| Database | Global catalog (roles, plans, prices, settings) is read-only outside platform scopes. | `*_security_hardening` |
| Files | Keys are `t/<tenantId>/<folder>/<uuid>.<ext>`. Personal-data folders need short-lived signed URLs. | `core/storage.ts`, `routes/system.ts` |

**Three database scopes** (`src/server/db.ts`), set per transaction with `set_config(..., true)`:
- `withTenant(id)`: business users. RLS shows only that tenant.
- `withStaffScope(userId)`: SAF Team members whose role isn't platform-wide. RLS shows only businesses they're actively assigned to.
- `withPlatform()`: platform-wide roles, session bootstrap, public token lookups, scheduled jobs. Bypasses RLS. Its use is limited to those call sites.

**Known limit (SEC-22):** these settings can be changed by any SQL running as `saf_app`. The database layer protects against query bugs, not against code execution in the app. Planned: separate DB roles per scope.

## 3. Authentication

| Control | Implementation |
|---|---|
| Password hashing | Argon2id (`@node-rs/argon2`, OWASP parameters) for login-ID accounts. Supabase Auth for email accounts. |
| Session | 32-byte random token, stored as SHA-256. Cookie `saf_session`: `HttpOnly; SameSite=Lax; Secure` (https). 12 h sliding expiry, 7-day absolute maximum. Server-side revocation. |
| Rotation | A new session on every sign-in, after MFA verification, and after MFA enrolment. Other sessions are revoked on password change, MFA change, role change and deactivation. |
| Brute force | Per-IP and per-account rate limits. Lockout after `LOGIN_MAX_FAILURES` (default 5) for `LOGIN_LOCK_MINUTES` (default 15). 5 wrong MFA codes also lock the account. nginx `limit_req` on `/api/auth/login`. |
| Enumeration | Unknown user, wrong password, locked account and pending invitation all give the same 401 after the same Argon2 work. Password reset always gives the same answer. |
| MFA | TOTP, with the secret encrypted using AES-256-GCM, replay-safe, plus 10 single-use recovery codes (hashed). Required for `SAF_MFA_REQUIRED` (production default `platform,owners`). |
| Step-up | Routes with `stepUp: true` need a fresh authentication within `STEP_UP_WINDOW_MINUTES` (default 10): TOTP code, or password when MFA is off. |
| CSRF | Every non-public state-changing request needs `x-saf-request: 1`. A cross-site page can't add it without a CORS preflight, which the API never approves. Combined with `SameSite=Lax`. |
| Email reset | Supabase recovery link → `/auth/link/complete`. If MFA is on, the result is only an MFA-pending session. |

## 4. Authorization (RBAC)

**Platform (SAF Team)** — `src/config/platform.ts`, enforced in `router.ts` and `core/platform-scope.ts`:

| Role | Scope | Notes |
|---|---|---|
| Platform Super Admin | all businesses | All permissions. Only a Super Admin can create, edit or reset Super Admins. |
| Platform Administrator | all businesses | Everything except editing platform roles. |
| **Security Administrator** (new) | all businesses | Security Center, audit, session revocation, MFA resets. No billing or catalog changes. |
| Operations / Client Success / Technical Support ("Support Staff") / Billing / Implementation | assigned businesses only | RLS staff scope, optionally narrowed per assignment by branches, modules and permissions. |
| Read-only Auditor | all businesses | `*.read` only. |

Guards:
- You can't grant permissions you don't hold.
- You can't change your own role, status or assignments.
- Suspension or a role change revokes all of that member's sessions.

**Business (per product)** — `src/config/catalog.ts`, `core/access.ts`. Every request checks, in order:
1. the tenant is active;
2. the product is enabled and subscribed;
3. the subscription is usable;
4. the user has a role in the product;
5. the plan includes the feature;
6. the role grants the permission;
7. the branch is allowed.

The owner always has every branch. Rules for managing staff:
- Only the owner creates managers.
- Non-owners can't act on manager accounts (SEC-07).
- Nobody changes their own roles or branches.
- Branch-restricted managers can only grant their own branches.
- Disabling an account revokes its sessions immediately.

Permission matrix (summary — the full list is `catalog.ts` → `roles[].permissions`):

| Capability | Owner | Manager | Cashier | Waiter / Kitchen / Housekeeping / Receptionist / Inventory | SAF Support (assigned) |
|---|:-:|:-:|:-:|:-:|:-:|
| Product screens per role | ✓ | ✓ | own | own | — (no tenant app login) |
| Create staff logins | ✓ | ✓ (not managers) | — | — | via admin panel, if permitted |
| Reset another manager / disable owner | ✓ / — | — | — | — | `platform.users.manage` |
| Settings, business profile (step-up) | ✓ | ✓ | — | — | `platform.business.update` |
| Security Center (business) | ✓ | ✓ | — | — | — |
| Reset staff MFA | ✓ | — | — | — | `platform.security.manage` |
| Pay SAF invoices online | ✓ | `subscription.view` holders | — | — | record manual payments (step-up) |

The automated tests prove the escalation paths are closed (`tests/integration/security.test.ts` › "role escalation", `platform.test.ts` › "roles only reach their own screens").

## 5. Data protection
- **In transit:** HTTPS at nginx or the load balancer. HSTS once `APP_URL` is https. The database connection should use `sslmode=require`, which the pre-flight script checks.
- **At rest:** database and object-storage encryption come from the hosting provider (to be confirmed: SEC-23). MFA secrets get application-level encryption (AES-256-GCM).
- **Not stored:** card numbers, CVV, UPI PINs, bank credentials. Cashfree holds all payment instruments; SAF stores only order, payment ID, amount and status.
- **Logs:** audit metadata goes through a redaction list (passwords, tokens, OTP and recovery codes, cookies, authorization headers, API keys, card fields). Unhandled errors log only the error name, message and request ID.
- **Responses:** `cache-control: no-store` on the API. Session token hashes are never returned. Staff-facing lists show only what each role needs.
- **Source maps:** disabled for browser bundles in production.

## 6. Key management
- `SAF_APP_SECRET` (≥32 random characters, server environment only) is expanded with HKDF-SHA256 into two purpose-bound keys, one for MFA secret encryption and one for file URL signing, each with a version label (`src/server/core/keys.ts`). Production refuses to run these features without it (fail closed).
- **Rotation:**
  1. Signed photo URLs: change the secret. Old links expire within 2 hours.
  2. MFA secrets: they carry a `v1:` version prefix. Rotation adds a `v2` derivation, re-encrypts at next login or in a batch job, then retires `v1`. Until that job exists, rotating `SAF_APP_SECRET` makes everyone re-enrol MFA (an admin reset per user, or a planned announcement).
- **Other secrets:** `CASHFREE_CLIENT_SECRET`, `SUPABASE_SECRET_KEY`, `CRON_SECRET`, `S3_SECRET_ACCESS_KEY` and database passwords live in the deployment's secret store, separate per environment, and are never `NEXT_PUBLIC_*` (checked by `scripts/security-preflight.mjs`).

## 7. Payments
- Amounts come from the invoice on the server; the browser only receives a Cashfree `payment_session_id`.
- A payment is settled only after the server reads the order back from Cashfree's API (`PAID`, INR, amount equal to the pending payment). The webhook is just a trigger: it's HMAC-SHA256 verified over raw bytes, accepted within ±5 minutes, and still re-verified through the API.
- Settlement is idempotent and race-safe (compare-and-set on the payment row). Amount mismatches are refused and audited.
- Manual payments and invoice voids need `platform.billing.manage` plus step-up, and are audited.

## 8. Files
PNG/JPEG only, checked by magic bytes (the filename and `Content-Type` are ignored). 2 MB maximum. Random UUID names under the tenant's prefix. A path-traversal guard in the local driver. Served with `nosniff`, `CSP: default-src 'none'; sandbox` and `CORP: same-origin`. Employee photos need a signed URL (≤2 h). Logos are public by design.

## 9. Monitoring and audit
- `audit_logs` is append-only. The app role has no `UPDATE`/`DELETE`, and a trigger blocks them for every role (`app.audit_purge` is for DBA retention only).
- Each entry records: event ID, actor, tenant, action, entity, product, IP, user agent, metadata including `requestId`, and a timestamp. The same `x-request-id` is returned to the client.
- Logged events include:
  - sign-in success and failure, lockout, new-device flag;
  - MFA enrol, verify-fail, disable, recovery use and reset;
  - step-up success and failure;
  - access denials;
  - every mutation, including staff, roles, settings, financial and payment events, and session revocations.
- **Security Center:** the platform view at `/admin/security` (alerts, sign-in trend, suspicious IPs, MFA coverage, admin activity, configuration checks) and the business view at `/<product>/security` (accounts, roles, branches, MFA, devices, activity, sign-out controls). The business view runs inside that tenant's RLS scope.

## 10. AI agents and integrations (future work — rules to apply)
No AI agents or WhatsApp integration exist yet. When they're added:
1. An agent acts **as the requesting user**. Every tool call goes through the same `route()` policy, never `withPlatform`.
2. Tools are an explicit allowlist of API operations. No generated SQL, no free-form HTTP (SSRF), and no code execution.
3. Payments, refunds, cancellations, deletions and permission changes are only *proposed* by the agent; a human confirms them with step-up.
4. Retrieval and memory are partitioned by `tenant_id` (RLS-protected tables, or one vector namespace per tenant). Prompts and tool outputs are treated as untrusted data.
5. Provider keys stay on the server only. Every agent action goes into `audit_logs` with `actor = user` and `meta.agent = true`.
6. WhatsApp: verify `X-Hub-Signature-256` with the app secret over raw bytes, verify the hub challenge token, check timestamps for replay, and store per-tenant tokens encrypted with the `keys.ts` pattern.

## 11. Configuration reference (names only)

| Variable | Purpose |
|---|---|
| `SAF_APP_SECRET` | Master secret for MFA encryption and signed URLs (required in production). |
| `SAF_MFA_REQUIRED` | `platform`, `owners` (comma list). Production default: both. |
| `STEP_UP_WINDOW_MINUTES` | Freshness window for sensitive actions (default 10). |
| `TRUSTED_PROXY_HOPS` | Proxies in front of the app (default 1 = bundled nginx; 0 = none). |
| `PUBLIC_API_DOCS` | `1` publishes `/api/docs/openapi.json` in production. |
| `LOGIN_MAX_FAILURES`, `LOGIN_LOCK_MINUTES`, `SESSION_TTL_HOURS`, `API_RATE_LIMIT_PER_MIN` | Sign-in and session limits. |
