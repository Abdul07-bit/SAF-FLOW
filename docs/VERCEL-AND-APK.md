# Put SAF Flow online (Vercel, free) and give people an app download link

You'll end up with:
- **Website:** `https://saf-flow.vercel.app` (or whatever name you choose)
- **Download page:** `https://saf-flow.vercel.app/download`. Android users get an APK, computers and iPhones get an Install button or instructions.

It takes about 1–2 hours the first time. You need: the GitHub account `Abdul07-bit`, your Supabase project, and a Chrome browser.

> **Free plan note:** Vercel's free Hobby plan is meant for personal, non-commercial projects. Use it to test and to show customers. When businesses start paying you, upgrade to Vercel Pro or move to a VPS (`docs/DEPLOYMENT.md`).

---

## Step 1 — Database: Supabase (you already have a project)

1. Supabase Dashboard → your project → **SQL Editor** → New query → paste `scripts/supabase-app-role.sql` → change `CHANGE_ME` to a long random password → **Run**.
2. Dashboard → **Project Settings → Database → Connection string**. Note down:
   - **Transaction pooler** (port **6543**). This is for the app on Vercel.
   - **Session pooler** (port **5432**). This is for setting up the tables from your computer.
3. **Authentication → Sign In / Providers:** turn **off** "Allow new users to sign up". SAF invites people itself.

## Step 2 — File storage: Supabase Storage

1. Dashboard → **Storage → New bucket** → name `saf-files` → keep it **Private** (do not tick Public).
2. **Storage → Settings → S3 Connection**: switch on, then **New access key**. Note down the endpoint, region, access key ID and secret.

## Step 3 — Create the tables (from this computer, once)

In the project folder, with the **session pooler** address and the **`postgres`** password:
```bash
# Git Bash, in "C:\Users\Ameera\Desktop\SAF flow"
export DIRECT_URL="postgresql://postgres.<project-ref>:<postgres-password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require"
export DATABASE_URL="$DIRECT_URL"
npx prisma migrate deploy

# Seed the catalog and the first Super Admin, connecting as saf_app:
export DATABASE_URL="postgresql://saf_app.<project-ref>:<saf_app-password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require"
export SAF_ADMIN_USERNAME="saf@admin"
export SAF_ADMIN_PASSWORD="<a strong password for the first Super Admin>"
npm run db:seed
```

## Step 4 — Vercel

1. Go to **vercel.com** → *Sign up* → **Continue with GitHub** (Abdul07-bit).
2. **Add New → Project** → import **SAF-FLOW**.
3. **Project name**: e.g. `saf-flow`. That becomes `saf-flow.vercel.app` if the name is free.
4. Before deploying, open **Environment Variables** and add these. Copy the values from steps 1–2; never paste them anywhere else.

| Name | Value |
|---|---|
| `DATABASE_URL` | Transaction pooler (6543) as **saf_app**: `postgresql://saf_app.<project-ref>:<saf_app-password>@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true&connection_limit=1` |
| `DIRECT_URL` | Session pooler (5432) as **saf_app** (same as above but port 5432, without `pgbouncer`/`connection_limit`) |
| `APP_URL` | `https://saf-flow.vercel.app` (your real address) |
| `SAF_APP_SECRET` | 48+ random characters (a password generator works) |
| `CRON_SECRET` | 32+ random characters |
| `SAF_MFA_REQUIRED` | `platform` (add `,owners` later) |
| `TRUSTED_PROXY_HOPS` | `1` |
| `STORAGE_DRIVER` | `s3` |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` | from step 2 (`saf-files`) |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | from step 2 |
| `S3_FORCE_PATH_STYLE` | `true` |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase → Project Settings → API |
| `SUPABASE_SECRET_KEY` | Supabase → Project Settings → API keys → secret key |
| `CASHFREE_CLIENT_ID` / `CASHFREE_CLIENT_SECRET` / `CASHFREE_ENV` | optional; `sandbox` for testing |

5. **Settings → Git → Production Branch**: `main`.
6. **Deploy.** When it finishes, open the address and sign in as `saf@admin`.
7. Supabase → **Authentication → URL Configuration**: Site URL = your address, and add the redirect URL `https://<your-address>/auth/callback`.

The daily renewal job is already set up in `vercel.json` (runs 02:00 IST). Vercel sends `CRON_SECRET` with it automatically.

## Step 5 — Make the Android APK (free, about 10 minutes)

1. Open **https://www.pwabuilder.com** → paste `https://<your-address>/download` → **Start**.
2. **Package For Stores → Android → Generate Package**:
   - **Package ID**: `com.smartautoflex.safflow`
   - **App name**: `SAF Flow`, **Launcher name**: `SAF Flow`
   - Leave **Signing key: Create new**.
   - Download the zip.
3. In the zip you get:
   - `SAF Flow.apk` (or similar): the app;
   - `signing.keystore` and `signing-key-info.txt`: **your app's signing key. Keep both safe forever** (password manager or a private drive). Without them you can never update the app. **Never put them in GitHub.**
   - `assetlinks.json`: contains your key's fingerprint.
4. Rename the APK to `saf-flow.apk` and copy it into `public/downloads/` in this project.
5. In Vercel → Environment Variables add:
   - `ANDROID_PACKAGE_NAME` = `com.smartautoflex.safflow`
   - `ANDROID_CERT_SHA256` = the value from `assetlinks.json` → `sha256_cert_fingerprints` (looks like `AB:CD:…`, 32 pairs)
6. Commit and push (Claude can do this for you). Vercel redeploys by itself.
7. Check `https://<your-address>/.well-known/assetlinks.json`: it should show your package name and fingerprint. With that in place, the app opens full screen with no browser bar.

Now share **`https://<your-address>/download`**: on WhatsApp, a QR code on the shop counter, or a message to staff.

### Installing the APK on a phone
Open the link in Chrome → **Download APK** → open the file → if Android asks, allow **"Install unknown apps"** for Chrome → **Install**. That warning is normal for apps not from the Play Store.

## Step 6 — Updates
- **Website changes:** push to `main`. Vercel publishes in about 2 minutes, and every installed app (APK, computer, iPhone) shows the new version next time it opens.
- **The APK only needs rebuilding** if you change the app name, icon or package. Use the **same signing key** (in PWABuilder choose "Use mine" and upload `signing.keystore`).

## If something goes wrong
| Problem | Fix |
|---|---|
| Build fails on Vercel | Check the build log. Usually a missing environment variable. |
| "File storage is not configured" | `STORAGE_DRIVER=s3` and the `S3_*` values are missing |
| Login works but photos/logos fail | Bucket name, endpoint or keys wrong, or the bucket isn't `saf-files` |
| App opens with a browser bar on top | `ANDROID_PACKAGE_NAME` / `ANDROID_CERT_SHA256` not set, or not redeployed |
| Two-step verification says "not configured" | `SAF_APP_SECRET` missing |
