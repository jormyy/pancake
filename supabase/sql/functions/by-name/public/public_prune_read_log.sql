-- Canonical SQL source for public.public_prune_read_log.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.public_prune_read_log()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='100ms' SET statement_timeout='3s' AS $$
BEGIN
  RETURN (private.retain_public_read_log(now())->>'public.public_read_log')::integer;
END;
$$;
