# Environments: local, staging, production

| | Local | Staging | Production |
|---|---|---|---|
| Address | `http://localhost:3000` | `https://staging.safflow.in` | `https://app.safflow.in` |
| Git branch | `feature/*`, `bugfix/*` | `staging` | `main` |
| Hosting | your computer | Vercel (Preview, branch `staging`) | Vercel (Production) |
| Database | Docker Postgres (`npm run db:up`) | Supabase project **saf-staging** | Supabase project **saf-prod** |
| Data | demo seed only | demo / test data only | real customers |
| Payments, WhatsApp, Voice | sandbox / off | sandbox / test numbers | live |
| Deploys | — | automatic after CI passes | **only when you start it** |

Never copy production data into staging or local. If you need realistic data, use `npm run db:seed:demo`.

## How a change reaches customers

```
feature/xyz ──PR──► staging ──(auto: CI → migrate → deploy → health)──► staging.safflow.in
                                                  you test here
staging ──PR──► main ──(you: Actions → deploy → production)──► app.safflow.in
```

1. Branch from `staging`: `git checkout staging && git pull && git checkout -b feature/xyz`.
2. Open a pull request into `staging`. CI (`security.yml`, `gitleaks.yml`) must be green. Merge.
3. `deploy.yml` runs by itself: waits for CI, migrates the **staging** database, builds staging on Vercel, and waits until `/api/health` serves the new commit.
4. Test on `staging.safflow.in`.
5. Open a pull request `staging` → `main`. Merge. **Nothing goes live yet** (vercel.json turns off automatic deploys of `main`).
6. GitHub → **Actions → deploy → Run workflow** → branch `main`, target `production`, confirm `deploy production`.

Emergency fix: `hotfix/xyz` from `main` → PR into `main` → deploy production → then merge `main` back into `staging`.

## Database migration rules

Migrations run **before** the new code goes live, so for a few minutes the **old** code runs against the **new** schema. Every migration must therefore keep the old code working (expand, then contract):

- Adding a table, a nullable column, or a column with a default: safe in one release.
- Renaming or removing a column: three releases. Add the new column, ship code that uses it, then remove the old one in a later release (with the reviewed `-- saf:allow-destructive <reason>` marker; `scripts/check-migrations.mjs` blocks it otherwise).
- Every new tenant table must enable Row-Level Security (the same script checks this).

**There is no automatic rollback of the database.** If a release goes wrong:

1. **App problem, schema fine:** Vercel → Deployments → the previous production deployment → **Instant Rollback**. Takes seconds. The schema stays, which is safe because migrations are backward compatible (rules above).
2. **Migration problem:** fix forward. Write a new migration that corrects it, and release it through staging as usual. Do not edit or delete a migration that has already run anywhere.
3. **Data damaged:** restore from backup (below), which is the last resort.

## Backups

- **Production:** use Supabase Pro (daily backups, 7 days kept; add Point-in-Time Recovery when revenue allows). The free plan has **no** backups you can restore. Also take a weekly copy of your own: `scripts/backup.sh` with the production session-pooler URL, stored outside Supabase.
- **Staging:** no backups needed; it can always be rebuilt from migrations and the demo seed.
- Test a restore into a scratch database once a quarter. A backup you have never restored doesn't count as a backup.

---

## One-time setup checklist

Do these in order. You need the dashboards, so I can't do them from the code.

### A. GitHub

1. Create the `staging` branch from `main`:
   `git checkout main && git pull && git checkout -b staging && git push -u origin staging`
2. **Settings → Secrets and variables → Actions → New repository secret.** Add these (fill in the values after steps B and C):

   | Secret | Value |
   |---|---|
   | `STAGING_MIGRATE_URL` | saf-staging **session pooler (5432)**, user `postgres.<staging-ref>` |
   | `STAGING_DEPLOY_HOOK` | Vercel deploy hook for branch `staging` (step C5) |
   | `STAGING_URL` | `https://staging.safflow.in` |
   | `STAGING_VERCEL_BYPASS` | Vercel Protection Bypass secret (step C6), if staging is protected |
   | `PRODUCTION_MIGRATE_URL` | saf-prod **session pooler (5432)**, user `postgres.<prod-ref>` |
   | `PRODUCTION_DEPLOY_HOOK` | Vercel deploy hook for branch `main` (step C5) |
   | `PRODUCTION_URL` | `https://app.safflow.in` |

3. Branch protection: on a **private repo with GitHub Free**, GitHub does not offer it. Until you upgrade to GitHub Pro ($4/month), the rule is yours to keep: never `git push` to `main` or `staging`, always open a pull request. With Pro, add a ruleset for `main` and `staging`: require a pull request, require the `Tests (unit, integration, tenant isolation, permissions)` and `Secret scan` checks, and block force-pushes.

### B. Supabase: a separate staging project

1. Create a new project **saf-staging** (region Mumbai). Your existing project is production: rename it **saf-prod** so the two can't be mixed up.
2. In saf-staging, repeat steps 1–2 of `docs/VERCEL-AND-APK.md`: run `scripts/supabase-app-role.sql` with a **new** password, create the private `saf-files` bucket and an S3 key, and turn off public sign-ups.
3. Authentication → URL Configuration: Site URL `https://staging.safflow.in`, redirect `https://staging.safflow.in/auth/callback`.
4. Create the tables once from your computer: `DIRECT_URL=<staging session pooler> DATABASE_URL=<same> npx prisma migrate deploy`, then `npm run db:seed:demo` as `saf_app`. After that, the pipeline migrates it.

Note: free Supabase projects pause after a week without use. Open staging once a week, or upgrade it later.

### C. Vercel (Hobby plan)

1. Project → **Settings → Environments → Preview → Environment Variables.** Add the **staging** values: the same names as production (`docs/VERCEL-AND-APK.md` step 4), but every value from saf-staging, with `APP_URL=https://staging.safflow.in`, new `SAF_APP_SECRET` and `CRON_SECRET`, and sandbox payment/WhatsApp keys. Feature-branch previews also use these, so they only ever touch the staging database.
2. **Production** environment variables stay as they are (saf-prod). Check that no staging value is in Production and no production value is in Preview.
3. **Domains:** add `app.safflow.in` (Production). Add `staging.safflow.in` → **Edit → Git Branch: `staging`**. Vercel shows the DNS records to create at your domain registrar; HTTPS certificates are automatic.
4. Settings → **Git → Production Branch:** `main`.
5. Settings → **Git → Deploy Hooks:** create `production` (branch `main`) and `staging` (branch `staging`). Put the URLs into the GitHub secrets. Treat a hook URL like a password: anyone who has it can start a build.
6. Settings → **Deployment Protection:** keep Vercel Authentication on for previews (strangers can't open staging). Create a **Protection Bypass for Automation** secret and save it as `STAGING_VERCEL_BYPASS`, so the pipeline's health check can reach staging.
7. Shared rate limiting: connect a **second** Upstash database to Preview only, so staging and production don't share login counters.

The daily renewal cron runs only on Production; on staging, trigger it by hand when testing renewals.

**Hobby plan limit:** Vercel's Hobby plan is for non-commercial use. Before paying customers use `app.safflow.in`, either upgrade the project to Pro, or run production on a VPS with Docker (`docs/DEPLOYMENT.md`) and keep staging on Vercel.

### D. First run

1. Merge this branch into `staging` (via a PR). Watch **Actions → deploy**: it should end with "Live and healthy".
2. Open `https://staging.safflow.in`, sign in, and go through a Dine order, a Stay booking and a Bill sale.
3. When happy: PR `staging` → `main`, merge, then run the production deploy by hand.
