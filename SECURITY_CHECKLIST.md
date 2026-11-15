# SAF Flow — Security Checklist

Tick these before each production release, plus the "Go-live" section once. `[x]` means done and verified in this repository; `[ ]` needs action from someone with production or infrastructure access.

## Code-level controls (verified 2026-11-13, branch `security/hardening`)
- [x] Every API route declares an auth policy; anonymous access is rejected on all non-public routes (automated test over all 318 endpoints)
- [x] CSRF header required on every non-public state change (automated test over all routes)
- [x] Tenant identity comes only from the server session; RLS forced on every tenant table; runtime role is not superuser and cannot bypass RLS
- [x] Cross-tenant references blocked in the database (trigger on all 40 child tables; a test fails if a new table lacks it)
- [x] Global catalog (roles, plans, prices, settings) read-only outside platform scopes
- [x] Audit trail append-only for every role
- [x] Argon2id passwords; hashed session tokens; HttpOnly + SameSite cookies; Secure on https
- [x] Lockout, rate limits, generic sign-in errors (no account enumeration)
- [x] TOTP MFA with replay protection and recovery codes; enforced by policy
- [x] Step-up re-authentication on 26 sensitive routes
- [x] Sessions rotate on sign-in / MFA; revoked on password, MFA, role change and deactivation
- [x] Managers cannot take over other managers; nobody changes their own role or branches
- [x] Payment amounts computed on the server; gateway status re-verified; settlement idempotent and race-safe; webhook signature + 5-minute window
- [x] Request body caps (1 MB JSON / 3 MB upload) without relying on Content-Length
- [x] Uploads: PNG/JPEG magic-byte check, 2 MB, random names, sandboxed serving; employee photos via expiring signed URLs
- [x] CSP, HSTS (on https), frame denial, nosniff, no browser source maps, OpenAPI hidden in production
- [x] Secrets only in server env; none in the browser bundle (checked after `next build`); none in git history (Gitleaks)
- [x] `npm audit`: 0 vulnerabilities; Trivy: 0 HIGH/CRITICAL; Semgrep: 0 ERROR findings
- [x] Security Center for SAF staff and for each business

## Go-live (one-time, needs production access)
- [ ] `APP_URL` is the `https://` address; TLS terminates at nginx or the load balancer (modern TLS only: 1.2+, prefer 1.3)
- [ ] `SAF_APP_SECRET` set to 48+ random characters in the secret store (**not** in a file on a developer machine)
- [ ] `CRON_SECRET`, database passwords, `SUPABASE_SECRET_KEY`: unique per environment and stored in the secret store
- [ ] `DATABASE_URL` uses **`saf_app`** (not `saf_owner`/`postgres`) with `sslmode=require`; the database port is not reachable from the internet
- [ ] **If the database is on Supabase:** create the `saf_app` role there (`deploy/postgres-init/01-roles.sh` statements), run migrations as `postgres`, point `DATABASE_URL` at `saf_app.<project-ref>`, and confirm the Data API cannot reach SAF tables:
      `SELECT has_table_privilege('anon','public.users','SELECT'), has_table_privilege('anon','public._prisma_migrations','SELECT');` → both `false`
      (or turn the Data API off / remove `public` from its exposed schemas in the Supabase dashboard)
- [ ] `TRUSTED_PROXY_HOPS` matches the real proxy chain (1 with the bundled nginx; 2 with a cloud load balancer in front of nginx; 0 if no proxy)
- [ ] `SAF_MFA_REQUIRED=platform,owners` (or stricter); every SAF Team member has enrolled MFA (Security Center shows N/N)
- [ ] Upstash Redis connected (Security Center → "Shared rate limiting" ✓) when hosting on Vercel or several servers
- [ ] `npm run security:preflight` passes with the production environment loaded
- [ ] Global settings → UPI payments shows the correct UPI ID and account holder name; approve receipts only after the money shows in the bank
- [ ] `STORAGE_DRIVER=s3` with a **private** bucket (no public-read policy)
- [ ] Deploy only via the Docker image or CI build; never copy a locally built `.next/standalone` folder (it can contain a local `.env`)
- [ ] Backups: nightly `scripts/backup.sh` (or provider PITR), **encrypted**, copied off the server, access restricted; one restore test recorded
- [ ] Push the repository to GitHub, enable the `security` workflow, branch protection requiring it, Dependabot, secret scanning; pin actions to commit SHAs
- [ ] Fill in the contacts table in `SECURITY_INCIDENT_RESPONSE.md`

## Every release
- [ ] CI `security` workflow green (tests, migration gate, Gitleaks, npm audit, Trivy fs + image, Semgrep, CodeQL)
- [ ] New tables with `tenant_id` get RLS in the same migration (the migration gate enforces this)
- [ ] New sensitive routes use `stepUp: true`; new routes declare the narrowest policy
- [ ] New secrets added to `scripts/security-preflight.mjs` and the secret store, never `NEXT_PUBLIC_*`
- [ ] `npm run test:security` passes

## Quarterly
- [ ] Restore drill + `npm run test:security` against the restored copy
- [ ] Review SAF Team members, roles and assignments; remove leavers
- [ ] Review Security Center alerts trend and accounts without MFA
- [ ] Optional: OWASP ZAP baseline against **staging** (workflow_dispatch input `zap_target`)
- [ ] Re-read the "Remaining findings" in `SECURITY_AUDIT_REPORT.md` and schedule the next one

## Not claimed
- This checklist does not make SAF Flow "100% secure" and is **not** a PCI DSS attestation. SAF takes no card data: businesses pay by UPI in their own app, which keeps SAF out of most PCI scope; confirm your SAQ type with Cashfree / a QSA.
