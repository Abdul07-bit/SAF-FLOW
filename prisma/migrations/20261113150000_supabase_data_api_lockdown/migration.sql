-- ===========================================================================
-- SEC-31: when this database is hosted on Supabase, its Data API (PostgREST)
-- exposes the `public` schema to the `anon` and `authenticated` roles, and the
-- publishable (anon) key is public by design. SAF Flow uses Supabase for
-- Auth ONLY - every data access goes through the SAF API as `saf_app` - so
-- those roles must not reach SAF tables or functions at all.
--
-- No-op on plain PostgreSQL (local Docker, CI), where the roles do not exist.
-- Supabase's own schemas (auth, storage, ...) are untouched.
-- ===========================================================================
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
      RAISE NOTICE 'SAF: revoked Data API access to schema public from %', r;
    END IF;
  END LOOP;

  -- Functions are executable by PUBLIC by default, which anon / authenticated
  -- inherit. On Supabase, close that too and give EXECUTE back only to the
  -- application role (RLS policies call these functions as saf_app).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
    -- The PUBLIC execute default is global, not per schema, so it is revoked
    -- for the migration role as a whole (every SAF function is created by it).
    ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saf_app') THEN
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO saf_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO saf_app;
    END IF;
  END IF;
END $$;
