-- Canonical SQL source for private.reserved_trade_asset_message.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.reserved_trade_asset_message()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'This asset is reserved by an accepted trade.'
$$;
