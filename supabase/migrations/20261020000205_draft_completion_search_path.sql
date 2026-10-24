CREATE OR REPLACE FUNCTION private.draft_timer_opening_night_completion_enabled()
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT true; $$;
