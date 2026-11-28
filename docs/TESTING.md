# Testing

```bash
npm run db:up     # the tests use the saf_test database in the same container
npm test
```

The suite takes about a minute. It applies migrations to `saf_test` and seeds
the catalog first (`tests/global-setup.ts`), without wiping anything: every
test creates its own business with a unique code, so tests do not depend on a
clean database or on each other.

Integration tests call the real API dispatcher (`handleRequest`) with real
cookies and headers against a real PostgreSQL, connected as the same
non-superuser role the application uses in production. Nothing is mocked, so
Row-Level Security, constraints and transactions behave as they do live.

## What is covered

| File | Covers |
|---|---|
| `tests/unit/core.test.ts` | Money and tax maths, IST dates, subscription state and grace, ID and password generation, and a policy lint: every route declares a policy and only allow-listed routes are public |
| `tests/integration/platform.test.ts` | Sign-in, lockout, forced password change, CSRF check, onboarding, one manager login for several products, the full entitlement chain (not subscribed, Basic vs Growth, role permissions, suspended, expired) |
| `tests/integration/isolation.test.ts` | RLS at the database level (other tenants' rows are invisible, cross-tenant writes rejected), the same through the API, append-only audit log |
| `tests/integration/billing.test.ts` | Per-product pricing, invoices and GST, manual payments, renewals, upgrades and scheduled downgrades, grace and expiry, the renewal job, Cashfree checkout (gateway faked at the network boundary), server-side confirmation, amount check and webhook signatures |
| `tests/integration/dine.test.ts` | Tables and QR, POS, QR ordering, KOTs and kitchen status, settlement, stock and recipe deduction, reports |
| `tests/integration/stay.test.ts` | Rooms, availability, reservations, the double-booking constraint, check-in/out, folio, invoices, housekeeping, maintenance |
| `tests/integration/bill.test.ts` | Barcode POS with server-side pricing, stock deduction, the race for the last unit, voids, purchases, adjustments, counters, analytics |
| `tests/integration/payables.test.ts` | Supplier credit: unpaid / part / fully paid purchases, the ledger, FIFO and named allocation, advances, opening balances, duplicate and simultaneous submissions, cancellations, returns, reversals, deactivation, overdue and limit alerts (only to permitted users), WhatsApp only when configured, day / week / month / custom reports that reconcile, tenant isolation, roles and plans, database guards, private bill photos, stock purchase link |
| `tests/unit/payables.test.ts` | Supplier credit arithmetic: exact quantity x rate, statuses, FIFO allocation, report periods |
| `tests/integration/staff.test.ts` | Employees, photo upload, shifts, attendance and reports, ID card PDF, QR verification and card re-issue, staff login management, per-product entitlement of each staff module |

## Not covered by automated tests

- The browser UI. Screens are type-checked and compiled by `npm run build`, but
  there are no browser-driven tests; check screens by hand after UI changes.
- A live Cashfree account (the tests fake Cashfree's API and sign webhooks with a test secret).
- S3 storage (tests use the local driver).

## Starting from an empty test database

```bash
docker compose exec postgres psql -U saf_owner -d postgres -c "DROP DATABASE saf_test" -c "CREATE DATABASE saf_test OWNER saf_owner"
docker compose exec postgres psql -U saf_owner -d saf_test -c "GRANT USAGE ON SCHEMA public TO saf_app"
npm test
```

To use a different database, set `TEST_DATABASE_URL` (application role) and
`TEST_DIRECT_URL` (schema owner).
