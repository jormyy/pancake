-- Canonical SQL source for private.end_trade_lifecycle_write.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.end_trade_lifecycle_write(
  p_previous text
)
RETURNS void
LANGUAGE sql
AS $$
  SELECT set_config('app.trade_lifecycle_server_write', COALESCE(p_previous, ''), true)
$$;
