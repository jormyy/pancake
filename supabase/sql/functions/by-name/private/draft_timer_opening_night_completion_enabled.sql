-- Canonical SQL source for private.draft_timer_opening_night_completion_enabled.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.draft_timer_opening_night_completion_enabled()
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT true; $$;
