# SMARTAUTO FLEX (SAF)

One multi-tenant SaaS platform hosting three independent business products:

| Product | For | Basic | Growth adds |
|---|---|---|---|
| **SAF Dine Flow** | Restaurants | POS, QR menu and table ordering, tables, orders, waiter / kitchen (KDS) / cashier screens, menu, basic inventory, WhatsApp invoices, sales reports | Staff management, attendance, shifts, ID cards, ingredients and recipes with automatic deduction, suppliers, purchases, wastage, analytics |
| **SAF Stay Flow** | Hotels | Rooms and categories, availability, reservations, guests, check-in/out, front desk, room billing, invoices, expenses, occupancy reports, housekeeping status | Staff management, attendance, shifts, ID cards, housekeeping tasks, maintenance, analytics, revenue and operations reports, multiple branches |
| **SAF Bill Flow** | Retail shops | Barcode POS, catalog, categories, stock, low-stock alerts, invoices, customers, purchase records, cashier screen, sales reports | Staff management, attendance, shifts, ID cards, advanced inventory, suppliers, purchase orders, stock adjustments, analytics, multiple counters, multiple branches |

A business (tenant) can subscribe to one, two or all three products. Each
subscription has its own plan, billing cycle and renewal date, and the same
manager login opens every product the business has.

The **SAF Super Admin** runs the platform: businesses, products, plans and
pricing, feature access, subscriptions, payments, revenue, support and audit logs.

## Stack

Next.js 15 (App Router) + TypeScript + Tailwind CSS, PostgreSQL 17 with
Row-Level Security, Prisma, S3-compatible file storage, Docker and Nginx.
A modular monolith: one deployable, with shared authentication, tenancy,
subscription and staff modules used by all three products.

## Run it locally

Requirements: Node.js 20.9+ and Docker Desktop.

```bash
npm install
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
npm run db:up                 # PostgreSQL on localhost:5433 (+ MinIO)
npm run db:migrate            # create the schema and RLS policies
npm run db:seed               # products, plans, roles, Super Admin
npm run dev                   # http://localhost:3000
```

`db:seed` prints the Super Admin login **once**:

```
Super Admin created: saf@admin
Temporary password (shown once): ............
```

Sign in at <http://localhost:3000/login>; you are asked to set a new password.
To choose the password yourself, set `SAF_ADMIN_PASSWORD` in `.env` before the
first seed.

Optional sample data (three businesses with menus, rooms and products; their
manager passwords are also printed once):

```bash
npm run db:seed:demo
```

### First steps in the app

1. As Super Admin, open **Add new business**, pick the products and a plan for each, and submit.
   You get the manager login (`CODE@manager`) and a temporary password.
2. Sign in as the manager. The portal lists the subscribed products; open one.
3. Under **Team > Staff logins**, create employee logins (`CODE@name`) and give each a role per product.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Development server / production build / run the build |
| `npm run typecheck` | TypeScript check |
| `npm test` | Unit and integration tests (needs the database container) |
| `npm run db:up` | Start PostgreSQL and MinIO |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` / `db:seed:demo` | Seed the catalog / plus demo businesses |
| `npm run db:reset` | **Deletes all data**, then migrates and seeds demo data |
| `npm run docs:api` | Regenerate `docs/API.md` and `docs/openapi.json` |
| `npm run jobs:renewals` | Run the renewal job once (expiry, renewal invoices, reminders) |

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - how tenancy, authorization, subscriptions and the product modules fit together
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) - production deployment, HTTPS, payments, backups, upgrades
- [docs/TESTING.md](docs/TESTING.md) - what the automated tests cover and how to run them
- [docs/API.md](docs/API.md) - every endpoint with its authorization policy (generated)

## Project layout

```
prisma/            schema, migrations (incl. RLS policies), seed, demo data
src/config/        product catalog (features, permissions, roles, default prices), navigation
src/server/        API: auth, core (tenancy, access, subscriptions, storage), routes per product
src/shared/        resource definitions shared by API and UI
src/components/    UI kit, app shell, charts, forms
src/screens/       screens for Super Admin, Dine Flow, Stay Flow, Bill Flow and shared staff/account modules
src/app/           Next.js routes: login, portal, /admin, /dine, /stay, /bill, public pages, /api
tests/             unit and integration tests
deploy/, scripts/  Nginx config, database init, backup / restore, jobs
```
