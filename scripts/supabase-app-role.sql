-- Run ONCE in Supabase: Dashboard > SQL Editor > New query.
-- Creates the least-privilege role the SAF Flow app connects as. It is not a
-- superuser and cannot bypass Row-Level Security, so every business only ever
-- sees its own data. Replace CHANGE_ME with a long random password (keep it
-- in your password manager; it goes into DATABASE_URL on Vercel).
CREATE ROLE saf_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'CHANGE_ME';
GRANT CONNECT ON DATABASE postgres TO saf_app;
GRANT USAGE ON SCHEMA public TO saf_app;
-- Then run the migrations from your computer (docs/VERCEL-AND-APK.md, step 3).
-- They grant saf_app exactly the table rights it needs and lock the Supabase
-- Data API (anon / authenticated) out of SAF's tables.
