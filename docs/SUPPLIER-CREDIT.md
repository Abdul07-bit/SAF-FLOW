# Supplier Credit & Payables (SAF Dine Flow)

Restaurants buy chicken, vegetables and groceries on credit and settle later.
This module replaces the credit notebook: every purchase, payment, return and
correction is a stored transaction. Balances, ledgers, reports and alerts are
all calculated from those transactions.

## 1. Where it fits (audit summary)

| Area | Existing convention | What the module does |
|---|---|---|
| Tenancy | Every table has `tenant_id`; requests run in `withTenant()`, where PostgreSQL RLS hides other tenants' rows | New tables follow the same RLS policy, plus the same-tenant reference trigger |
| Access | Route policy: product → plan feature → role permission (`src/server/http/router.ts`) | Feature `dine.supplier_credit` (Growth) and permissions `dine.payables.view / manage / adjust` |
| Money | Integer paise (`src/lib/money.ts`); no floating point | Same: integer paise, quantities `NUMERIC(14,3)`, line maths in `BigInt` |
| Dates | IST business days with opening/closing hours (`src/lib/business-day.ts`) | All transactions carry a business date; reports filter on dates, not timestamps |
| Suppliers | `dine_suppliers` (used by stock items and purchase orders) | **Reused and extended**: no second supplier table |
| Stock purchases | `dine_purchases` (purchase orders that add stock) | Optional link: receiving a purchase order can create the supplier bill (one bill per order, enforced by a unique key) |
| Notifications | `notifications` table; rows with no user are seen by **every** staff member | Supplier alerts are addressed to each permitted user, never tenant-wide |
| Audit | Append-only `audit_logs` | Every mutation audited; the supplier ledger is append-only too |

## 2. Data model

Debit-side documents (raise what we owe) live in `supplier_purchases`.
Credit-side documents (lower it) are `supplier_payments` and
`supplier_credit_adjustments`. Allocations link the two. The ledger is the
append-only journal of every event.

| Table | Purpose | Key rules |
|---|---|---|
| `dine_suppliers` (+ columns) | Supplier profile: business name, WhatsApp, category, payment terms (days), credit limit, notes, active flag | Opening balance is not a column: it is an `OPENING_BALANCE` bill |
| `supplier_purchases` | Bills: `PURCHASE` or `OPENING_BALANCE` | `total > 0`; `ACTIVE` or `CANCELLED` (never deleted); `client_ref` unique (duplicate submits); `dine_purchase_id` unique (no double bill for one stock purchase) |
| `supplier_purchase_items` | Lines: product, category, quantity, unit, rate, amount | `amount = round(quantity × rate)`; optional `stock_item_id` for inventory |
| `supplier_payments` | Money paid: date, amount, method, reference, receipt | `ACTIVE` or `REVERSED`; `source_purchase_id` when paid at purchase time |
| `supplier_credit_adjustments` | Returns, discounts, corrections, write-offs; direction `INCREASE` or `DECREASE` | `ACTIVE` or `REVERSED`; a `DECREASE` may target one bill |
| `supplier_payment_allocations` | How much of a payment / credit settles which bill | Exactly one source; `amount > 0`; voided (with reason), never deleted |
| `supplier_ledger_entries` | Journal: `increase` / `decrease` per event, reference, description | Append-only (trigger rejects UPDATE/DELETE) |
| `supplier_credit_settings` | Per business: alert switches, limits, summaries, WhatsApp, stock-purchase link | One row per tenant |
| `supplier_notifications` | Log of alerts sent, with delivery status per channel | Unique `(tenant, dedupe_key)`: an alert is never sent twice |

All money columns are integer paise with `CHECK` constraints. Financial columns
(supplier, amount, total, date) cannot be changed after creation (trigger);
corrections are reversals plus new entries.

## 3. Calculations

```
line amount         = round(quantity × rate)                 (BigInt, half up)
bill total          = Σ line amounts
bill due            = total − Σ active allocations to the bill
supplier balance    = Σ ledger increase − Σ ledger decrease  (authoritative)
advance             = max(0, −balance)   (paid ahead, available credit)
status              = CANCELLED | PAID (due 0) | OVERDUE (due > 0, due date passed)
                      | PARTIALLY_PAID (0 < due < total) | UNPAID
due date            = given, else bill date + supplier payment terms, else none
```

**Allocation.** A payment may name bills and amounts. Whatever is left, and any
credit freed by a cancellation or reversal, is applied to the oldest open bills
first. Credit left over when nothing is open is the supplier advance and is
applied automatically to the next bill. After every change: either no bill is
open, or no credit is unallocated.

**Guards.** A payment larger than the balance is refused unless it is
explicitly marked as an advance. Every financial write locks the supplier row
(`SELECT … FOR UPDATE`), so two cashiers cannot double-allocate.
A repeated submission with the same `clientRef` returns the first record.

**Corrections.**

| Situation | How |
|---|---|
| Purchase recorded wrongly | Cancel it (reason required): ledger reversal; its allocations are voided and the freed credit is re-applied; optionally reverse the payment made with it |
| Goods returned | `DECREASE` adjustment of kind `RETURN` against the bill |
| Wrong payment | Reverse it (reason required); the bills it settled reopen |
| Opening balance wrong | Adjustment (increase or decrease) with a reason |
| Supplier stops trading | Deactivate: no new purchases; payments and reports continue |

## 4. Reports

Ledger-based, so they always reconcile:
`opening balance + increases − decreases = closing balance` for any period.
Reversals are dated on the day they are made, so a closed period never changes.

| Period | Range | Compared with |
|---|---|---|
| Daily | one business day | the day before |
| Weekly | Monday to Sunday | the previous week |
| Monthly | calendar month | the previous month |
| Custom | any range up to 366 days | the same number of days before it |

Each report has purchases, payments, new credit (unpaid part of the period's
purchases), credit settled, returns and adjustments, cancellations and
reversals, opening and closing balance, a supplier-wise breakdown, the highest
outstanding supplier, overdue bills, and a day-by-day series.
Downloads: PDF and CSV (opens in Excel).

## 5. API (`/api/dine/payables/...`)

| Method | Path | Permission |
|---|---|---|
| GET | `/summary` | view |
| GET, POST | `/suppliers` | view / manage |
| GET, PATCH | `/suppliers/:id` | view / manage |
| GET | `/suppliers/:id/ledger` | view |
| GET, POST | `/purchases` | view / manage |
| GET, PATCH | `/purchases/:id` (PATCH: invoice no., due date, notes only) | view / manage |
| POST | `/purchases/:id/cancel` | adjust |
| POST | `/purchases/:id/attachment` (PNG/JPEG bill photo) | manage |
| GET, POST | `/payments` | view / manage |
| POST | `/payments/:id/reverse` | adjust |
| POST | `/payments/:id/attachment` | manage |
| GET, POST | `/adjustments` | view / adjust |
| POST | `/adjustments/:id/reverse` | adjust |
| GET | `/reports`, `/reports/pdf`, `/reports/csv` | view |
| GET | `/alerts` | view |
| GET, PUT | `/settings` | view / adjust |

Every route requires the `supplier_credit` plan feature. Writes need the
`x-saf-request` header (CSRF), are rate limited and audited.

## 6. Security

- RLS on every new table (`tenant_isolation` policy), plus the same-tenant
  reference trigger, so even a query that forgets its tenant filter cannot
  read or link another restaurant's supplier.
- Permissions: the Dine **Manager** role (every business owner has it) holds
  all three: `payables.view` (read), `payables.manage` (record suppliers,
  purchases, payments), `payables.adjust` (cancel, reverse, adjust, settings).
  Waiter, Cashier and Kitchen have none. Roles are SAF-wide system roles, so
  giving another role access is a platform change (catalog + migration).
- SAF Team (Super Admin) controls the feature per plan and per business, as for
  every module. There is no platform screen into a restaurant's supplier
  finances.
- Bill photos and payment receipts are re-encoded PNG/JPEG, stored under a
  private folder and served only with a signed, expiring link.
- Alerts go only to users who can view supplier credit.

## 7. Notifications

In-app (the bell), for users with `payables.view`:

| Alert | When |
|---|---|
| Credit purchase recorded / payment recorded | Immediately (switchable) |
| Supplier over its credit limit, or total over the business limit | When a purchase crosses it, and in the daily check |
| Bill overdue | Daily check after closing time, once per bill |
| Balance unpaid for N days | Daily check, once per oldest open bill |
| Daily / weekly / monthly summary | After closing time; weekly on Sunday, monthly on the last day |

The daily check runs inside the existing `/api/jobs/daily-reports` schedule,
so no new cron is needed. WhatsApp delivery is built in but **off unless
configured**: it needs the server's WhatsApp credentials plus
`WHATSAPP_PAYABLES_TEMPLATE` (an approved utility template). Without them, the
alert log records WhatsApp as "not configured" and the screen says so.

## 8. Deploying

Nothing new to configure for the module itself. In order:

1. **Staging.** Merge to the branch that deploys to staging. The pipeline runs
   `prisma migrate deploy`, which applies `20261128090000_supplier_credit`:
   new tables, triggers, RLS, the `dine.supplier_credit` feature on the Dine
   Growth plan and the `dine.payables.*` permissions for the Manager role.
   The migration only adds; existing rows are not touched.
2. **Check on staging** with a Growth test restaurant: add a supplier with an
   opening balance, record an unpaid purchase, a part payment and a return,
   open the ledger and the daily / monthly report (PDF and CSV), and check that
   a waiter login cannot open *Supplier credit*.
3. **Production.** Back up the database first (Supabase: Database > Backups,
   or `pg_dump`), then start the production deploy as usual
   (docs/ENVIRONMENTS.md). Rolling back the app is safe: the old version
   ignores the new tables. Do not roll the migration back by hand.
4. **Optional: WhatsApp alerts.** Create a UTILITY template in WhatsApp
   Manager, e.g. name `supplier_credit_alert`, body
   `{{1}}: {{2}}. {{3}}`, and once approved set `WHATSAPP_PAYABLES_TEMPLATE`
   (with the existing `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID`) in the
   environment. Each restaurant then turns WhatsApp on under *Credit alerts*.
5. **Plans.** Supplier credit is a Growth feature by default. To offer it on
   Basic, add it to the plan in the Super Admin plan editor; no deploy needed.

The end-of-day check runs inside the existing daily-reports schedule
(every 15 minutes), so no new cron job is needed. Its result is in the audit
log as `jobs.supplier_credit_alerts`; failures for one restaurant never stop
the others and are retried on the next run.

## 9. Not included

- Credit purchases do not add stock by themselves (stock purchase orders do;
  link them with the setting to avoid a second record).
- One timezone: all SAF businesses are in India (IST); business-day hours are respected.
- Branches: supplier credit is per business, not per branch (the bill records the branch it was entered at).
