-- Canonical SQL source for private.lineup_game_available.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.lineup_game_available(p_status text, p_status_text text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT p_status IN ('Scheduled', 'InProgress', 'Final')
    AND COALESCE(p_status_text, '') !~* 'postpon|cancel|suspend|(^|[^a-z])ppd([^a-z]|$)';
$$;
