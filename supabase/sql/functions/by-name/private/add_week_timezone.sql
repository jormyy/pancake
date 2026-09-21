-- Canonical SQL source for private.add_week_timezone.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.add_week_timezone()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'America/New_York'::text
$$;
