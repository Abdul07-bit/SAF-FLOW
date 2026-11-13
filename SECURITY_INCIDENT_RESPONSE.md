# SAF Flow — Security Incident Response

For the SmartAutoFlex team running SAF Flow in production. Keep this document next to the deployment runbook (`docs/DEPLOYMENT.md`).

**Roles during an incident**
- **Incident lead:** a Super Admin or Security Administrator. Decides, coordinates and records.
- **Operator:** has server and database access. Runs the technical steps.
- **Communications:** the business owner contact and, where needed, legal.

**Golden rules**
1. **Contain first, investigate second**, but **preserve evidence before you change anything** (§1).
2. Never paste secrets, tokens, OTPs or customer data into chat, tickets or this document.
3. Write down every action with the time (UTC) and who did it. The audit trail records application actions; your notes record everything else.

---

## 1. Evidence preservation (do this first, every time)
```bash
# 1. Freeze the audit trail and sessions as they are now (read-only copies).
docker compose exec -T postgres pg_dump -U saf_owner -d saf --format=custom \
  -t audit_logs -t sessions -t users -t staff_assignments -t payments -t invoices \
  > evidence-$(date -u +%Y%m%dT%H%M%SZ).dump
sha256sum evidence-*.dump > evidence.sha256        # proves the copy was not altered later
# 2. Full backup (scripts/backup.sh), then copy both OFF the server.
# 3. Save proxy/app logs for the period: docker compose logs --since 72h > logs-<time>.txt
```
`audit_logs` can't be modified or deleted by the application or the owner role (trigger `saf_audit_immutable`). Don't disable that trigger during an incident.

Useful queries (run as the owner role):
```sql
-- Everything one account did, newest first
SELECT created_at, action, tenant_id, entity_type, entity_id, ip, meta->>'requestId' AS request
FROM audit_logs WHERE actor_id = '<user-uuid>' ORDER BY created_at DESC LIMIT 500;
-- Failed / suspicious sign-ins by address in the last 24 h
SELECT ip, count(*) FROM audit_logs
WHERE action IN ('auth.login_failed','auth.account_locked','auth.mfa_failed','auth.step_up_failed')
  AND created_at > now() - interval '24 hours' GROUP BY ip ORDER BY 2 DESC;
-- One request end to end (the x-request-id from a user's report or the logs)
SELECT * FROM audit_logs WHERE meta->>'requestId' = '<request-id>';
```
The **Security Center** (`/admin/security`) shows the same signals: alerts, failed sign-ins, suspicious IPs, admin activity.

## 2. Containment tools

| Need | How | Who |
|---|---|---|
| Sign a user out everywhere | Security Center → user, or `POST /api/admin/security/users/:id/revoke-sessions` (reason required) | `platform.security.manage` |
| Suspend a SAF Team member | Admin → SAF Team → member → Suspend (revokes sessions, bans the identity in Supabase) | `platform.staff.update` |
| Disable a business user | Admin → client accounts → Disable, or the business owner in Team | `platform.users.manage` / owner |
| Suspend a whole business | Admin → business → Suspend (every user of it loses access) | `platform.business.suspend` |
| Reset a user's MFA (lost or compromised device) | `POST /api/admin/users/:id/mfa-reset`, or the owner for their own staff | `platform.security.manage` |
| Emergency: sign out everyone | `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;` (owner role) | operator |

All of these, except the SQL, are audited and need step-up re-authentication.

## 3. Playbooks

### 3.1 Compromised administrator (SAF Team) account
1. Preserve evidence (§1).
2. Suspend the member (sessions revoked immediately). If it's a Super Admin, another Super Admin does this. If no other Super Admin exists, use `scripts/reset-admin-password.ts` on the server and revoke sessions with SQL.
3. Reset their MFA and password, and set up MFA again in person or over a verified call.
4. Review `audit_logs` for that actor since the earliest suspicious sign-in:
   - role or permission changes (`platform.role.*`, `platform.staff.*`);
   - new team members;
   - assignments;
   - settings and plan changes;
   - manual payments and voids;
   - data viewed in businesses (`admin.*`).
5. Reverse unauthorised changes. Check for persistence: new SAF Team accounts, changed roles, new assignments.
6. Rotate any secret the account could see (for example invitation links it generated).
7. Assess customer notification (§4).

### 3.2 Compromised staff account (business user)
1. The owner or SAF support disables the account, or uses Security Center → Sign out.
2. Reset the password and MFA.
3. Review the account's audit entries: orders voided, discounts, stock adjustments, payments settled, staff created.
4. If the account was a manager, check for new staff logins or role changes it made.
5. Tell the business owner what was accessed.

### 3.3 Suspected cross-tenant data leakage
Treat as **critical**.
1. Preserve evidence. Capture the exact request, response and request ID.
2. Reproduce on staging, never on production with real data.
3. Run the isolation suite against the affected build: `npm run test:security`.
4. Check the database guards are still in place:
```sql
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND relkind = 'r' AND (NOT relrowsecurity OR NOT relforcerowsecurity);   -- expect only _prisma_migrations
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'saf_app';                    -- expect f, f
```
5. Hotfix, or take the affected endpoint offline (nginx `location ... { return 503; }`).
6. Identify every affected tenant from `audit_logs` (actor tenant ≠ entity tenant).
7. Notify (§4).

### 3.4 API key or secret exposure
| Secret | Rotate | Side effects |
|---|---|---|
| `CASHFREE_CLIENT_SECRET` | Cashfree dashboard → Developers → regenerate; update the server secret; restart | Webhook signatures use it: deploy the new key immediately. |
| `SUPABASE_SECRET_KEY` | Supabase → Project settings → API keys → rotate | Invitations and admin resets pause until it's updated. |
| `SAF_APP_SECRET` | Generate 48+ random characters; deploy | Signed photo links expire. **Everyone must enrol MFA again** (stored secrets can no longer be decrypted). Announce first, then reset MFA for all users. |
| `CRON_SECRET` | New random value in the app and the cron service | None. |
| Database passwords | `ALTER ROLE saf_app PASSWORD '…'` (and `saf_owner`); update `DATABASE_URL` / `DIRECT_URL` | Restart the app. |
| `S3_SECRET_ACCESS_KEY` | Storage provider → new key; delete the old one | None. |

After rotating:
- search the git history for the leaked value (`gitleaks detect`);
- if it was committed, treat it as public forever: rotating it is the fix, rewriting history isn't;
- review provider logs for its use.

### 3.5 Payment fraud
Signs: `billing.payment_amount_mismatch` alerts, invoices paid without a matching Cashfree settlement, unusual manual payments.
1. Compare `payments` (method `CASHFREE`, `gateway_payment_id`) with the Cashfree dashboard settlement report.
2. Manual payments are audited (`admin.payment.*`): check who recorded each one and when.
3. Void any invoice settled without real money (step-up required), and reverse the subscription period if it was extended.
4. If the webhook secret may be known, rotate `CASHFREE_CLIENT_SECRET` (§3.4). Settlements always re-read the order from Cashfree's API, so a forged webhook can't mark an unpaid order as paid.

### 3.6 Unauthorised database access
1. Revoke network access to the database (firewall or security group). Rotate both database role passwords.
2. Check `pg_stat_activity` and the provider's logs for unknown clients. Check for new roles (`SELECT rolname FROM pg_roles`) and changed policies (`SELECT * FROM pg_policies`).
3. Compare the schema against the migrations: `npx prisma migrate status`, `npm run security:migrations`.
4. Assume data was read. Notify (§4).

### 3.7 Malware upload
Uploads only accept PNG/JPEG (checked by magic bytes) and are served with `CSP: sandbox` and `nosniff`, so executing an upload is very unlikely.
1. Identify the object key (`t/<tenant>/<folder>/<uuid>`).
2. Copy it to quarantine and delete it from storage.
3. Clear `logo_key` / `photo_key`.
4. Review who uploaded it (`audit_logs`, action `…logo` / `…photo`).

### 3.8 Suspicious automated activity (credential stuffing, scraping)
1. Security Center → "Possible password guessing" alert and suspicious IPs.
2. Block at the edge: nginx `deny <ip>;`, or tighten `limit_req` for `/api/auth/login`.
3. Locked accounts unlock automatically after `LOGIN_LOCK_MINUTES`. Tell affected owners if it's targeted.
4. Check for successful sign-ins from the same addresses. If any, treat those accounts as compromised (§3.2).

## 4. Customer notification assessment
Decide within **24 hours** of confirming an incident. Record the decision.
- What data? (business records, staff personal data, customer phone numbers, payment metadata; SAF never stores card data)
- Which businesses? (from the audit trail; never guess: list them)
- Was it accessed or just exposed?
- Obligations:
  - India's DPDP Act 2023 and Rules: notify the Data Protection Board and affected people for personal-data breaches;
  - CERT-In: report specified cyber incidents within **6 hours**;
  - contractual duties to business customers.

  Get legal advice. This document isn't legal advice.
- Message: what happened, what data, what we did, what they should do (for example reset passwords, watch for phishing), and a contact.

## 5. Recovery
1. Fix the root cause. Add a regression test to `tests/integration/security.test.ts`.
2. Deploy through CI (all security gates green).
3. If data was altered: restore into a scratch database (`scripts/restore.sh <dump> saf_verify`), compare, and repair selectively. Restore the live database only with the app stopped.
4. Watch the Security Center closely for 2 weeks.

## 6. Post-incident review (within 5 working days)
Write up and keep with the evidence:
- timeline;
- root cause;
- what detected it;
- what slowed us down;
- customer impact;
- actions with owners and dates.

Update this playbook. No blame: the goal is better controls.

## 7. Audit log retention purge (planned DBA task only)
The trigger blocks deletes unless the session sets a flag. Never do this during an incident.
```sql
BEGIN;
SET LOCAL app.audit_purge = 'on';
DELETE FROM audit_logs WHERE created_at < now() - interval '<retention period>';
COMMIT;
```

## 8. Contacts (fill in)
| Role | Name | Phone | Backup |
|---|---|---|---|
| Incident lead | | | |
| Operator (server/DB) | | | |
| Cashfree support | dashboard → Help | | |
| Supabase support | dashboard → Support | | |
| Legal | | | |

## 9. Drills
Quarterly:
- restore a backup into `saf_verify` and run `npm run test:security` against it;
- practise §3.1 on staging;
- record the date and the result.
