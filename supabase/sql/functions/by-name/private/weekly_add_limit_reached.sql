-- Canonical SQL source for private.weekly_add_limit_reached.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.weekly_add_limit_reached(p_used int, p_limit int)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_limit IS NOT NULL AND COALESCE(p_used, 0) >= p_limit
$$;
