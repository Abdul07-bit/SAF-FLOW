# SAF Flow — Security Test Report

**Date:** 2026-11-13 · **Branch:** `security/hardening` · **Environment:** local only (Windows 11, Docker Desktop, PostgreSQL 17 test database `saf_test` reached through the least-privilege role `saf_app`). **No production or third-party system was tested or attacked.** The Cashfree API was mocked at the network boundary, and Supabase Auth used the in-memory test double.

## 1. Results at a glance

| Check | Tool | Result |
|---|---|---|
| Unit + integration tests | Vitest 4.1.12 | **114 passed, 0 failed**, 2 marked not applicable (11 files, ~61 s) |
| — of which baseline tests (before this work) | | 85/85 passed at baseline; still pass (2 updated for the new generic sign-in error) |
| — of which new security tests | | 29 new (`tests/unit/security.test.ts` 11, `tests/integration/security.test.ts` 18) plus a rewritten Cashfree webhook test |
| Type check | `tsc --noEmit` | pass |
| Production build | `next build` | pass; browser bundle searched: no secret values, no source maps |
| Dependency audit | `npm audit` | **0 vulnerabilities** (baseline: 2 critical, 3 high, 1 moderate) |
| Dependency tree | `npm ls --all` | clean (needed for `npm ci` in Docker/CI) |
| Secret scan, git history | Gitleaks 8.21.2 | **no leaks** in 4 commits, with one documented exception (`tests/env.ts` fixtures, `.gitleaks.toml`) |
| Secret scan, working tree | Gitleaks `--no-git` | findings only in git-ignored local files (`.env`, `.next/` build output) and the allowlisted fixture. See SEC-30. |
| Filesystem scan | Trivy 0.57.1 (vuln, misconfig, secret) | `package-lock.json`: 0 vulnerabilities at any severity; `Dockerfile`: 0 failed checks |
| Static analysis | Semgrep 1.95.0 (p/typescript, p/react, p/nextjs, p/owasp-top-ten, p/secrets) | **0 ERROR** findings after fixes (2 found and fixed: GCM tag length, workflow shell injection); 15 warnings reviewed (§4) |
| Container image | Docker build + Trivy 0.57.1 image | **0 HIGH/CRITICAL** after removing npm from the runtime image (before: 10 HIGH in the bundled npm); non-root; no `.env` |
| Migration safety gate | `scripts/check-migrations.mjs` | pass: 8 migrations, 59 tenant tables all under RLS; a deliberately bad sample is rejected |
| Supabase Data API lockdown | simulated `anon`/`authenticated` roles in a throwaway local DB | `anon` has no access to existing or new tables and functions; `saf_app` unaffected |
| Production pre-flight | `scripts/security-preflight.mjs` | rejects a sample bad configuration (http URL, owner DB role, missing secrets, Supabase `postgres.` login); accepts a good one |

### Not executed
| Check | Why | How to run |
|---|---|---|
| CodeQL | Needs GitHub (the repository has no remote yet) | Runs automatically in `.github/workflows/security.yml` after pushing |
| OWASP ZAP (DAST) | Needs an authorised staging deployment; never run against production | Manual workflow input `zap_target` (staging URLs only) |
| The CI workflow itself | No GitHub remote | Push the branch; the first run validates the workflow file |
| Real Supabase project checks | No SAF database connected to Supabase yet | `SECURITY_CHECKLIST.md` → Go-live query |
| AI agent tool authorization (prompt item 18) | No AI agents exist in the codebase | Marked `it.todo` in the suite |
| WhatsApp webhook verification | No WhatsApp integration exists | Marked `it.todo` in the suite |
| Load / rate-limit under concurrency across instances | Single local instance | See SEC-24 |

## 2. Tenant isolation verification
| Test | What it proves | Result |
|---|---|---|
| EVERY tenant-owned table … (`security.test.ts`) | For **all 59 tables with `tenant_id`**, in tenant A's DB scope: `SELECT … WHERE tenant_id = B` → 0 rows, and `UPDATE … WHERE tenant_id = B` → 0 rows affected (audit_logs: no UPDATE privilege at all). B had >20 rows spread across those tables. | pass |
| Cross-tenant references | A row can't point at another tenant's record (insert and update, tenant and platform scope). Every tenant→tenant foreign key has the guard trigger, so a new table without it fails CI. | pass |
| API, every method | A's manager tries `GET`, `PATCH` and `DELETE` on B's tables, categories, stock items, suppliers, room types, product categories, customers and employees; B's ids never appear in A's lists; B's data is unchanged. B's team members, support tickets, sessions and invoices: 404 for A. | pass |
| Security Center scope | A's Security Center lists exactly A's users; the session list has no token hashes. | pass |
| Existing isolation suite (`isolation.test.ts`) | RLS fail-closed with no context; the runtime role is not superuser or BYPASSRLS; references validated. | pass |
| Global catalog | Tenant scope can't change roles, role permissions, plans or settings (0 rows / rejected), but can read them. | pass |

**Verdict:** no cross-tenant read or write path was found at the API or database layer for the scenarios tested. Remaining architectural limit: SEC-22 (the RLS settings protect against query bugs, not against code execution inside the app).

## 3. Authentication and authorization
| Area | Tests | Result |
|---|---|---|
| Anonymous access | All 221 routes: every non-public route → 401 before validation | pass |
| CSRF | Every non-public state-changing route without `x-saf-request` → 403 `CSRF_REJECTED` | pass |
| Sessions | Expired, revoked and >7-day-old sessions → 401; logout and logout-all revoke server-side | pass |
| Lockout and enumeration | Generic error for unknown, wrong, locked and pending accounts; lock after 5 failures | pass |
| MFA | Enrol; pending session can't reach the API; session rotated on verify; TOTP replay rejected; recovery code single-use; 5 wrong codes lock the account; no OTP or recovery code in the audit log; admin MFA reset; policy enforcement sends unenrolled owners to enrolment only | pass |
| Step-up | Sensitive action without fresh auth → 403 `STEP_UP_REQUIRED`; wrong password → 401; correct password → action allowed | pass |
| Role escalation | Waiter can't create staff or promote itself; non-owner manager can't create managers, change its own role, reset or disable another manager or the owner, revoke a manager's sessions, or reset MFA; can still manage ordinary staff | pass |
| Deactivation | Disabled staff lose access immediately (401 on the next request) | pass |
| Platform vs tenant | Tenant accounts get `PLATFORM_ONLY` on platform APIs; existing tests cover admin role scoping and per-assignment narrowing | pass |
| Audit | Privileged team actions audited; every mutation's audit entry carries the response's `x-request-id` | pass |

## 4. Payment security
| Test | Result |
|---|---|
| Server-side amounts, checkout, confirmation, amount mismatch refused, replays harmless (existing test) | pass |
| Webhook: bad signature → 400; correctly signed but 1 h old → 400 `STALE_WEBHOOK`; signed and fresh but the gateway says unpaid → nothing settled | pass |
| Webhook and browser confirmation **racing** → exactly one `SUCCEEDED` payment, one settlement audit entry, invoice `PAID` | pass |
| Unit: HMAC over raw bytes (re-serialised JSON fails), empty secret fails, timestamp window | pass |

## 5. Container image (Docker build + Trivy image scan)
| Check | Result |
|---|---|
| `docker build` (Linux `npm ci`, `next build`, standalone output) | pass |
| Trivy image scan, HIGH/CRITICAL, fixable | **0** (Debian 12.15 packages: 0; Node packages: 0). The first scan found 10 HIGH in the npm CLI bundled with the base image, which is now removed (SEC-32). |
| `.env` files inside the image | **0** (`.dockerignore` excludes them) |
| npm/npx inside the runtime image | absent |
| Runtime user | `uid=1001(saf)` (non-root) |
| Smoke test (container started, `GET /login`) | 200; `Content-Security-Policy` present without `unsafe-eval` (production); `X-Frame-Options: DENY`; no `X-Powered-By`; HSTS correctly absent because the test used an http `APP_URL` (it appears once `APP_URL` is https) |

## 6. Semgrep warnings reviewed (not blocking)
| Rule | Where | Decision |
|---|---|---|
| `github-actions-mutable-action-tag` (13) | `.github/workflows/security.yml` | Accepted for now; pin to commit SHAs when pushing (SEC-29). |
| `request-host-used` | `deploy/nginx.conf` `proxy_set_header Host $host` | Accepted: the app builds absolute URLs from `APP_URL`, never from `Host`. |
| `js-open-redirect` | `src/app/login/page.tsx` | False positive: `next` is only followed when it matches `^/(?!/)[\w\-/[\].]*$` (same-site path, no `//`, no `\`). |
| Partial parsing (4 files) | `satisfies` syntax in 3 route files, a shell heredoc | Semgrep parser limits; the rest of each file was analysed. CodeQL covers TypeScript fully in CI. |

## 7. How to reproduce
```bash
npm run db:up                      # PostgreSQL on :5433 (Docker)
npm test                           # everything (114 tests)
npm run test:security              # security suites only
npm run security:migrations        # migration gate
NODE_ENV=production npm run security:preflight   # with the production env loaded
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.21.2 detect --source /repo --config /repo/.gitleaks.toml --redact
```
