-- Raise the same-tenant reference violation with its own error code (P0001)
-- instead of 23503: Prisma maps 23503 to a generic foreign-key error and hides
-- the message, so the API could not tell it apart from "record in use".
CREATE OR REPLACE FUNCTION saf_check_tenant_refs() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE
  child_tenant uuid := NEW.tenant_id;
  doc jsonb;
  i int;
  col text;
  parent text;
  ref_value text;
  parent_tenant uuid;
  found_row boolean;
  prev_bypass text;
BEGIN
  IF child_tenant IS NULL THEN
    RETURN NEW;
  END IF;
  doc := to_jsonb(NEW);
  i := 0;
  WHILE i < TG_NARGS LOOP
    col := TG_ARGV[i];
    parent := TG_ARGV[i + 1];
    i := i + 2;
    ref_value := doc ->> col;
    CONTINUE WHEN ref_value IS NULL;
    -- Skip unchanged references on UPDATE (cheap, and keeps legacy rows editable).
    IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) ->> col) IS NOT DISTINCT FROM ref_value
       AND OLD.tenant_id IS NOT DISTINCT FROM NEW.tenant_id THEN
      CONTINUE;
    END IF;
    prev_bypass := coalesce(current_setting('app.bypass_rls', true), '');
    PERFORM set_config('app.bypass_rls', 'on', true);
    -- Every referenced table is keyed by a uuid id (verified at migration time).
    EXECUTE format('SELECT true, tenant_id FROM %I WHERE id = $1::uuid', parent)
      INTO found_row, parent_tenant USING ref_value;
    PERFORM set_config('app.bypass_rls', prev_bypass, true);
    IF found_row AND parent_tenant IS NOT NULL AND parent_tenant <> child_tenant THEN
      RAISE EXCEPTION 'SAF_CROSS_TENANT_REF: %.% references a row of another business', TG_TABLE_NAME, col
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
