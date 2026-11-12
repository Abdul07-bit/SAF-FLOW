# Architecture

SMARTAUTO FLEX is a modular monolith: one Next.js application and one
PostgreSQL database serving the Super Admin and three products. Shared
concerns are written once and used by every product.

```
SMARTAUTO FLEX
|-- SAF Super Admin        /admin   platform accounts
|-- SAF Dine Flow          /dine    Basic | Growth
|-- SAF Stay Flow          /stay    Basic | Growth
`-- SAF Bill Flow          /bill    Basic | Growth
```

## Modules

| Module | Location | Responsibility |
|---|---|---|
| Catalog | `src/config/catalog.ts` | Products, features per tier, permissions, system roles, default prices. Seeded into the database. |
| HTTP router | `src/server/http/router.ts` | Route registry, validation, rate limits, the authorization chain, audit entries |
| Auth | `src/server/auth/` | Argon2id passwords, opaque session tokens (stored hashed), login lockout |
| Access | `src/server/core/access.ts` | Subscription state, plan entitlements, per-business overrides, role permissions |
| Tenancy | `src/server/core/tenancy.ts` | Business onboarding, manager credentials, activating products |
| Subscriptions | `src/server/core/subscriptions.ts` | Invoices, payments, renewals, plan changes, grace, the renewal job |
| Staff | `src/server/routes/staff.ts`, `src/server/staff/` | Employees, attendance, shifts, ID card PDFs, QR verification |
| Products | `src/server/routes/{dine,stay,bill}.ts` | Each product's own tables, workflows and reports |
| Generic CRUD | `src/shared/resources.ts`, `src/server/http/crud.ts` | Simple entities declared once; API and UI are derived from the declaration |

## Tenant isolation

Two independent layers; either one alone stops cross-tenant access.

1. **PostgreSQL Row-Level Security.** Every tenant table has `tenant_id` and a
   policy `tenant_id = saf_current_tenant()`, with `FORCE ROW LEVEL SECURITY`.
   The application connects as `saf_app`, a role that is not a superuser and
   has no `BYPASSRLS`. Each request runs in one transaction that sets
   `app.tenant_id` (`withTenant`). With no tenant set, queries return nothing.
   Platform operations (Super Admin, sign-in lookup, scheduled jobs) use
   `withPlatform`, which sets an explicit bypass flag for that transaction only.
2. **Backend authorization.** Handlers receive the tenant from the session,
   never from the request, and scope their queries by it.

Policies live in `prisma/migrations/20261110120000_rls_security/migration.sql`.
The audit log is append-only for `saf_app` (no UPDATE or DELETE grant).

## Authorization chain

Every route declares exactly one policy; there is no default, so an endpoint
cannot be exposed by omission (a unit test fails the build if a route is public
without being on an allowlist). For a product route the router checks, in order:

1. the session is valid and the password is not a pending temporary one
2. the business is active
3. the business subscribes to the product, and the product is enabled
4. the subscription is usable (active or within grace) - otherwise HTTP 402
5. the user has a role in **that product**
6. the plan includes the feature, or a per-business override grants it
7. the role grants the permission

The UI hides what a user cannot use, but that is only presentation: the same
feature and permission keys are enforced by the API on every call.

Entitlements are read from the database at request time, so changing a plan's
features or a business's plan in Super Admin takes effect immediately.

## Accounts and roles

- **Platform accounts** (`kind = PLATFORM`) use only `/admin`.
- **Tenant accounts** belong to one business. Login IDs embed the business code:
  `SGV@manager`, `SGV@ravi`.
- `user_product_access` gives a user one role **per product**. A shared
  employee can be a cashier in Dine Flow and a receptionist in Stay Flow;
  without a row for a product the user cannot open it.
- The manager account created at onboarding holds the manager role in every
  product the business subscribes to, including ones activated later.
- Temporary passwords (new business, reset) must be changed at first sign-in.

System roles: Dine - Manager, Waiter, Cashier, Kitchen. Stay - Hotel Manager,
Receptionist, Housekeeping, Cashier, Maintenance Staff. Bill - Store Manager,
Cashier, Inventory Staff, Storekeeper.

## Subscriptions

One `product_subscriptions` row per business per product, each with its own
plan, billing cycle, start date and expiry.

- **Pricing** is stored on `plans` (one Basic and one Growth plan per product)
  and edited in Super Admin. Nothing in the frontend contains a price.
- **States:** `ACTIVE` -> `GRACE` (expired, access continues for the plan's or
  the subscription's grace days) -> `EXPIRED`; plus `SUSPENDED` and `CANCELLED`.
- **Invoices** are raised for setup fees, each billing period, plan-change
  differences and one-off charges, with GST from global settings. Payments are
  recorded manually by the Super Admin or collected online through Razorpay.
- **Renewal job** (every 6 hours in Docker, or `npm run jobs:renewals`): expires
  subscriptions past grace, raises the next renewal invoice, and sends reminders
  on the configured days before expiry. Paying a renewal invoice extends the
  subscription and applies any scheduled plan change.
- **Plan changes:** immediately (optionally invoicing the difference) or at the
  end of the current period.

## Money, dates and numbering

- Money is integer **paise**; tax and percentage rates are **basis points**.
  Prices are always computed on the server from the catalog, never trusted from
  the client.
- Business dates are IST calendar dates (`YYYY-MM-DD`); timestamps are UTC.
- Invoice, order and reservation numbers come from a per-tenant sequence table
  updated inside the same transaction, so numbers are gapless per tenant.
- Stock changes and room allocation are guarded in the database (conditional
  updates and an exclusion constraint), so two counters cannot sell the last
  unit and a room cannot be double-booked.

## Frontend

- `/login` is the single sign-in for the whole ecosystem. After sign-in a
  tenant user lands on the portal (`/`), which lists each product as
  active / plan, or not subscribed (leading to `/activate/<product>`).
- Each product is a catch-all route (`/dine/...`) rendered by `ProductApp`,
  which loads the product context (subscription, features, permissions,
  branches) and picks the screen from `src/screens/registry.tsx`. Staff land on
  their role's home screen (waiter, kitchen, front desk, POS...).
- Each product has its own theme from the catalog (warm for Dine, teal and
  gold for Stay, blue for Bill, navy for Super Admin) on shared components.
- Public pages need no sign-in and are addressed by unguessable tokens:
  `/m/<token>` (QR menu and table ordering), `/invoice/<product>/<token>`,
  `/verify/<token>` (staff ID card).

### Charts

Conventions used by `src/components/charts.tsx`: a headline number is a stat
tile, not a chart; magnitudes use one hue; at most three categorical series in
a fixed, colour-blind-checked order; text is never coloured by series; every
chart has a table view and a hover / keyboard readout.

## Adding to the platform

- **A feature:** add it to `src/config/catalog.ts` with its tier, reference the
  key in the route policy and the nav item, run `npm run db:seed`.
- **A simple entity:** declare a resource in `src/shared/resources.ts`; the
  CRUD API and the table/form screen are derived from it.
- **A product:** add a `ProductDef` to the catalog, its tables (with
  `tenant_id` and an RLS policy), a routes file and screens. Auth, tenancy,
  subscriptions, staff management and billing work for it unchanged.
