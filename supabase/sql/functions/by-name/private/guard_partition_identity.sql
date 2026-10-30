-- Canonical SQL source for private.guard_partition_identity.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.guard_partition_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE identity_value text; present boolean;
BEGIN
  identity_value:=to_jsonb(NEW)->>TG_ARGV[1];
  IF identity_value IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND identity_value IS NOT DISTINCT FROM to_jsonb(OLD)->>TG_ARGV[1] THEN RETURN NEW; END IF;
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
    RAISE EXCEPTION 'Partition identity writes require READ COMMITTED' USING ERRCODE='0A000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||identity_value,48191));
  EXECUTE format('SELECT EXISTS(SELECT FROM %s stored WHERE stored.%I=($1).%I)',TG_ARGV[0]::regclass,TG_ARGV[1],TG_ARGV[1])
    INTO present USING NEW;
  IF present THEN
    RAISE unique_violation USING MESSAGE='Duplicate partitioned identity',CONSTRAINT=TG_ARGV[2];
  END IF;
  RETURN NEW;
END;
$$;
