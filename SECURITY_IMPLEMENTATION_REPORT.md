# SAF Flow — Security Implementation Report

**Branch:** `security/hardening`, on top of commit `3554f5d`. That commit is a snapshot of the uncommitted Phase 2-3 work, so nothing of yours was overwritten. **Nothing was deployed, and no live infrastructure or credentials were touched.**

## 1. Database migrations (backward compatible, nothing dropped)

| Migration | What it does |
|---|---|
| `20261113120000_security_hardening` | MFA columns on `users` and `sessions`. RLS on the 8 global catalog tables (read everywhere, write only in platform scopes). Same-tenant reference trigger `saf_check_tenant_refs`, installed automatically on every child table (40). Audit-log immutability trigger. Index `audit_logs(action, created_at)` for the Security Center. |
| `20261113130000_mfa_replay_guard` | `users.mfa_last_step` (TOTP replay protection). |
| `20261113150000_supabase_data_api_lockdown` | On Supabase only: removes the Data API roles' (`anon`, `authenticated`) access to SAF's `public` tables, sequences and functions (now and for future objects); `EXECUTE` stays with `saf_app`. Does nothing on plain PostgreSQL. |
| `20261113140000_cross_tenant_ref_errcode` | Re-creates the reference trigger function with its own error code, so the API can return `INVALID_REFERENCE` instead of a generic foreign-key error. |

Apply with `npm run db:migrate` (`prisma migrate deploy`) as the owner role. Existing rows aren't modified.

## 2. Server changes

| Area | Files | Change |
|---|---|---|
| Keys | `src/server/core/keys.ts` (new) | HKDF-derived purpose keys from `SAF_APP_SECRET`. AES-256-GCM with a pinned 16-byte tag. HMAC file-URL signing. Fails closed in production without the secret. |
| MFA | `src/server/auth/mfa.ts`, `src/server/routes/mfa.ts` (new) | TOTP (`otpauth`), recovery codes, policy `SAF_MFA_REQUIRED`. Endpoints: `GET /auth/mfa`, `POST /auth/mfa/{setup,enable,verify,disable,recovery-codes}`, `POST /auth/step-up`, `POST /admin/users/:id/mfa-reset`. |
| Sessions | `src/server/auth/session.ts` | `mfaPending`, `mfaVerifiedAt`, `stepUpAt`. A pending session lives 10 minutes and doesn't slide. |
| Router | `src/server/http/router.ts` | Request ID (`x-request-id`, put in audit metadata). Streaming body caps. Trusted-proxy client IP. Anonymous callers get 401 before validation. MFA-pending, MFA-enrolment and step-up gates. `P2023` → 404. Database-guard errors mapped to clean responses. |
| Sign-in | `src/server/routes/auth.ts` | Generic answer for locked accounts and pending invitations. MFA-pending sessions. A new-device flag in the audit log. Email reset links don't bypass MFA. |
| Team (business) | `src/server/routes/tenant.ts` | Managers can't act on other managers. Email-identity accounts' email is locked. Owner-only staff MFA reset. Step-up on team, settings and business profile. |
| Payments | `src/server/routes/tenant.ts`, `src/server/payments/cashfree.ts` | Compare-and-set settlement. Webhook ±5-minute window, re-verification through Cashfree's API, INR-only, size cap, mismatches audited. |
| Platform admin | `src/server/routes/team.ts`, `admin.ts` | Step-up on SAF Team invites and roles, platform settings, pricing, business suspension, account reset and disable, manual payments, invoice voids. |
| Security Center API | `src/server/routes/security.ts` (new) | `/admin/security/{overview,events,users/:id/sessions,users/:id/revoke-sessions}` and `/:product/security/{overview,sessions,sessions/:id/revoke,users/:userId/revoke-sessions}`. |
| Files | `src/server/core/storage.ts`, `routes/system.ts` | Signed, expiring URLs for employee photos. Sandboxed serving headers. OpenAPI hidden in production. |
| Misc | `ratelimit.ts`, `audit.ts`, `next.config.ts` | Rate-limit test switch ignored in production. Wider audit redaction. CSP, HSTS, no browser source maps. |
| RBAC catalog | `src/config/platform.ts` | `platform.security.read` / `.manage` permissions. New system role **Security Administrator**. Applied to the database by the seed (`npm run db:seed`). |

## 3. User interface
- `/mfa`: second sign-in step (authenticator or recovery code).
- `/account/security`: set up MFA (QR code and manual key), show recovery codes once, regenerate them, turn MFA off (if policy allows). Linked from the user menu as "Two-step verification".
- A global "Confirm it's you" dialog (`src/components/step-up.tsx`). The API client retries the original request after re-authentication, so existing screens needed no changes.
- **Security Center:**
  - SAF Admin → Operations → *Security Center* (`AdminSecurity`);
  - each product → Account → *Security Center* (`SecurityScreen`, visible with `staff.manage`).
- The client redirects on `MFA_REQUIRED` → `/mfa`, and on `MFA_ENROLLMENT_REQUIRED` → `/account/security?required=1`.

## 3a. Container
- `Dockerfile` runtime stage removes npm, npx and corepack (unused at runtime; 10 HIGH CVEs). The image was rebuilt and re-scanned: 0 HIGH/CRITICAL.

## 4. Tooling
- `.github/workflows/security.yml`: tests on real PostgreSQL with the least-privilege role, type check, migration gate, Gitleaks, npm audit, Trivy (filesystem and image), Semgrep, CodeQL, and a manual ZAP job limited to staging.
- `scripts/check-migrations.mjs` (`npm run security:migrations`): blocks destructive SQL without a reviewed marker, and tenant tables without RLS.
- `scripts/security-preflight.mjs` (`npm run security:preflight`): validates the production environment by **name** only.
- `.gitleaks.toml`: the default rules plus one documented exception (`tests/env.ts` fixtures).
- `npm run test:security`: the security test suites.

## 5. Dependencies
- Added `otpauth@9.6.0` (TOTP).
- Upgraded `vitest` 3.2.4 → **4.1.12** (critical and high advisories in test tooling).
- Added an `overrides` entry pinning `deepmerge-ts@8.0.2` (high advisory in Prisma's config loader). Prisma CLI, migrations and the full suite were verified on it.
- Upgraded `tsx` 4.20.6 → **4.23.15**. Vitest 4 brings Vite 8, which needs esbuild 0.27/0.28. The old `tsx` pinned esbuild 0.25, which left an invalid dependency tree that a strict Linux `npm ci` (the Docker build and CI) refused. `npm ls --all` is now clean.
- Result: `npm audit` reports 0 vulnerabilities.

## 6. Compatibility notes for existing users
- **Production MFA default:** in production, `SAF_MFA_REQUIRED` defaults to `platform,owners`. On first sign-in after deploying, SAF Team members and business owners are sent to set up an authenticator before they can continue. Announce this beforehand, or set `SAF_MFA_REQUIRED=platform` first and add `owners` later.
- **`SAF_APP_SECRET` is now required in production** for MFA and employee photos. Without it:
  - MFA set-up answers `503`;
  - photo links come back empty;
  - the Security Center shows a critical alert;
  - the pre-flight script fails.
- **Sensitive actions may ask for a password or code** if the last sign-in was more than 10 minutes ago.
- **The sign-in form no longer says "account locked"** or "invitation pending". Users see the generic message, which mentions temporary locks. Support can still see locks in the Security Center and admin panel.
- **Non-owner managers** can no longer reset or disable other managers. The owner (or SAF support) does that.
- **Old employee photo URLs** saved outside the app stop working. Within the app, new signed URLs are issued automatically.
- **Two existing tests were updated** to the new generic sign-in error (`platform.test.ts`, `saf-flow-foundation.test.ts`). The Cashfree webhook test was extended, since the webhook now re-verifies with the gateway.

## 7. Requires your approval or action (not done by me)
- Setting the production secrets, the MFA policy and `TRUSTED_PROXY_HOPS` (`SECURITY_CHECKLIST.md` → Go-live).
- Applying the migrations to the production database, then re-running the seed so the new permissions and the Security Administrator role exist.
- Pushing the branch and enabling the workflow on GitHub (the repository has no remote yet).
- Encrypting backups, scheduling them and running a restore test (SEC-23).
- Architectural follow-ups listed as remaining in the audit report (SEC-22, SEC-24 to SEC-30).
