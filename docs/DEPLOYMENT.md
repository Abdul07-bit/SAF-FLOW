# Deployment

A single-host deployment with Docker Compose: PostgreSQL, MinIO (file
storage), the application, Nginx and a small scheduler container.

## 1. Server

- A Linux server with Docker Engine and the Compose plugin (2 vCPU / 4 GB RAM is a comfortable start).
- A domain name pointing at the server.
- Ports 80 and 443 open. Nothing else needs to be reachable from the internet.

Copy the project to the server, for example `/opt/saf`.

## 2. Configure secrets

Create `/opt/saf/.env` (Compose reads it automatically). Use long random
values; `openssl rand -base64 32` generates one.

```ini
SAF_OWNER_PASSWORD=<database owner password>
SAF_APP_PASSWORD=<application role password>
SAF_MINIO_PASSWORD=<file storage password>
CRON_SECRET=<random string, at least 12 characters>

APP_URL=https://saf.example.com

SAF_ADMIN_USERNAME=saf@admin
SAF_ADMIN_PASSWORD=                 # empty: a temporary password is generated and printed once

# Optional: online payments
```

Notes:

- `APP_URL` must be the public address. It is embedded in table QR codes,
  invoice links and ID cards, and the session cookie is marked `Secure` only
  when it starts with `https://`.
- The database passwords are applied when the data volume is first created.
  Changing them later in `.env` does not change them in PostgreSQL; use
  `ALTER ROLE ... PASSWORD` as well.
- Avoid the characters `@ : / ? #` in the database passwords, because they are
  placed inside a connection URL.

## 2a. Supabase (email sign-in and database)

SAF Flow uses Supabase Auth for email accounts (invitations, password reset,
email verification). It can also use Supabase as the managed PostgreSQL
database. See [SAF-FLOW-ARCHITECTURE.md](SAF-FLOW-ARCHITECTURE.md) for the
design.

### Auth configuration

Do these once per Supabase project, in the Supabase dashboard:

1. **Keys.** Set the following in `.env`:
   - `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, from Project Settings > API Keys.
   - `SUPABASE_SECRET_KEY`, the **secret** key. Server only: never commit it and never use it in browser code.
2. **Turn off public sign-ups.** Authentication > Sign In / Providers: disable "Allow new users to sign up". SAF Flow is invite-only.
3. **Redirect URLs.** Authentication > URL Configuration:
   - Set **Site URL** to `APP_URL`.
   - Add `<APP_URL>/auth/callback` to the Redirect URLs allow-list, for example `https://app.saflow.com/auth/callback`. For local development add `http://localhost:3000/auth/callback`.
4. **Custom SMTP.** Authentication > Emails > SMTP Settings. This is required before inviting real clients: Supabase's built-in sender only delivers to your own project team and is heavily rate limited. Any SMTP provider works (for example Resend, Brevo or Zoho).
5. **Email templates (optional).** Rename the "Invite user" and "Reset password" templates to SAF Flow.

Until step 4 is done, invite people with **delivery: link**. SAF Flow then
returns the invitation link, and you send it yourself, for example on WhatsApp.

### Using Supabase Postgres as the database

1. Connect with the Supabase SQL editor (as `postgres`) and create the runtime role. It must not have BYPASSRLS:
   ```sql
   CREATE ROLE saf_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '<strong password>';
   GRANT USAGE ON SCHEMA public TO saf_app;
   ```
2. Set the two connection strings (Project Settings > Database > Connect, "Session pooler" or direct):
   - `DIRECT_URL`: the `postgres` user. Used only by `prisma migrate deploy`.
   - `DATABASE_URL`: the `saf_app` user. Used by the running app, so RLS applies.
3. Run `npx prisma migrate deploy`, then `npx tsx prisma/seed.ts`.
   - The `saf_flow_foundation` migration revokes all Data API (`anon` / `authenticated`) access to SAF tables.
   - Check it afterwards: `select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema='public';` must return 0.

Use **separate Supabase projects** for staging and production.

## 3. Start

```bash
cd /opt/saf
docker compose --profile app up -d --build
docker compose --profile app logs migrate     # shows the Super Admin temporary password, once
```

The `migrate` service applies the migrations and seeds the catalog, then the
app starts. Check <http://your-server/api/health> returns `{"ok":true,...}`.

Before going live, remove the published database and MinIO ports from
`docker-compose.yml` (the `ports:` entries of `postgres` and `minio`) or bind
them to `127.0.0.1`; the application reaches both over the internal network.

## 4. HTTPS

The supplied `deploy/nginx.conf` listens on port 80 only. Use one of:

**A. TLS in front of the stack** (a cloud load balancer, Cloudflare, or Caddy
on the host). Point it at port 80 and make it send `X-Forwarded-Proto`.

**B. TLS in the Nginx container.** Obtain a certificate (for example with
certbot on the host), then:

1. In `docker-compose.yml`, add to the `nginx` service: port `"443:443"` and a
   read-only volume for the certificates, e.g. `/etc/letsencrypt:/etc/letsencrypt:ro`.
2. In `deploy/nginx.conf`, change the server block to listen on 443 and add a
   port-80 redirect:

```nginx
server {
  listen 80;
  server_name saf.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  http2 on;
  server_name saf.example.com;
  ssl_certificate     /etc/letsencrypt/live/saf.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/saf.example.com/privkey.pem;
  add_header Strict-Transport-Security "max-age=31536000" always;
  # ... keep the rest of the existing server block ...
}
```

3. `docker compose --profile app up -d nginx`, and reload Nginx after each
   certificate renewal (`docker compose exec nginx nginx -s reload`).

Do not run production over plain HTTP: sessions and passwords would travel unencrypted.

## 5. Network rules that matter

- **Only Nginx is published.** The app trusts the `X-Forwarded-For` header for
  audit logs and rate limiting, and Nginx overwrites it with the real client
  address. Never publish the app's port 3000 directly.
- `POST /api/jobs/renewals` is blocked at Nginx; the `cron` container calls it
  on the internal network every 6 hours with `CRON_SECRET`.

## 6. Payments (UPI)

There is no payment gateway. Set the UPI ID and account holder name in
**Super Admin → Settings → UPI payments**. Businesses see a QR code with the
invoice amount filled in, pay from any UPI app and upload the screenshot plus
the UPI reference (UTR). Check the money arrived in the bank, then approve it
under **Payments → To verify**: the invoice is marked paid and the
subscription renews. Rejected receipts show the reason to the business, who can
upload again. Receipts are stored privately and served only through signed,
expiring links.

## 7. File storage

Uploads (logos, employee photos) go to the bundled MinIO bucket `saf-files`.
To use another S3-compatible service, set `S3_ENDPOINT`, `S3_REGION`,
`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and
`S3_FORCE_PATH_STYLE` on the `app` service and remove the MinIO services.

## 8. Backups

```bash
./scripts/backup.sh                                  # writes ./backups/saf-db-<time>.dump and saf-files-<time>.tar.gz
BACKUP_DIR=/mnt/backups KEEP_DAYS=30 ./scripts/backup.sh
```

Schedule it nightly from the host's cron and copy the files off the server:

```cron
15 2 * * *  cd /opt/saf && ./scripts/backup.sh >> /var/log/saf-backup.log 2>&1
```

Verify a backup by restoring it into a scratch database (does not touch live data):

```bash
./scripts/restore.sh backups/saf-db-20261110-021500.dump saf_verify
```

Restore over the live database (asks for confirmation; stop the app first):

```bash
docker compose --profile app stop app cron
./scripts/restore.sh backups/saf-db-20261110-021500.dump
docker compose --profile app start app cron
```

Restore uploaded files (replaces the contents of the MinIO data volume):

```bash
docker compose stop minio
docker run --rm -i --volumes-from "$(docker compose ps -aq minio)" alpine:3.20 \
  sh -c "rm -rf /data/* /data/.minio.sys && tar -C /data -xzf -" < backups/saf-files-20261110-021500.tar.gz
docker compose start minio
```

Test a restore before you rely on the backups, and again after major upgrades.

## 9. Upgrades

```bash
cd /opt/saf
./scripts/backup.sh
git pull                                   # or copy the new release in
docker compose --profile app up -d --build
```

The `migrate` service runs again on every start: migrations are applied in
order and the seed is idempotent. It adds new catalog features to plans but
never changes prices or removes features an admin took out of a plan.

## 10. Operations

| Task | Command |
|---|---|
| Logs | `docker compose --profile app logs -f app` |
| Health | `curl -fsS http://localhost/api/health` |
| Run the renewal job now | Super Admin > Global settings > Run now |
| Database shell | `docker compose exec postgres psql -U saf_owner -d saf` |
| Reset the Super Admin password | see below |

If the Super Admin password is lost, issue a new temporary one from the server
(it is printed once, and must be changed at the next sign-in):

```bash
docker compose --profile app run --rm migrate npx tsx scripts/reset-admin-password.ts
```

## Security checklist

- [ ] HTTPS enabled and `APP_URL` starts with `https://`
- [ ] All four secrets in `.env` changed from the defaults
- [ ] Database and MinIO ports not reachable from the internet
- [ ] App port 3000 not published; only Nginx is exposed
- [ ] Super Admin temporary password changed at first sign-in
- [ ] Nightly backup scheduled, copied off the server, and a restore tested
- [ ] `npm run db:seed:demo` and `npm run db:reset` never run against production

What the application does on its own: Argon2id password hashing, HttpOnly
SameSite session cookies with server-side revocation, account lockout after
repeated failed sign-ins, per-route rate limits, a CSRF header check on every
mutation, Row-Level Security on every tenant table, validated image uploads,
security response headers, and an append-only audit log.
