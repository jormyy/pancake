-- Canonical SQL source for private.trade_lifecycle_write_active.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.trade_lifecycle_write_active()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_setting('app.trade_lifecycle_server_write', true) = 'on'
$$;
