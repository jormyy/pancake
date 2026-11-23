-- Canonical SQL source for private.correct_lineup_history.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.correct_lineup_history(p_enabled boolean DEFAULT true)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM set_config('pancake.lineup_history_correction', CASE WHEN p_enabled THEN 'on' ELSE 'off' END, true);
END;
$$;
