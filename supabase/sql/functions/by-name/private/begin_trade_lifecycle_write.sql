-- Canonical SQL source for private.begin_trade_lifecycle_write.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.begin_trade_lifecycle_write()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_previous text := COALESCE(current_setting('app.trade_lifecycle_server_write', true), '');
BEGIN
  -- Marks the transaction as server-owned trade lifecycle work so the status
  -- and reservation guards let it through; returns the value to restore.
  PERFORM set_config('app.trade_lifecycle_server_write', 'on', true);
  RETURN v_previous;
END;
$$;
