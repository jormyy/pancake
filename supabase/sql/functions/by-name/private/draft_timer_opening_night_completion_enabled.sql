CREATE OR REPLACE FUNCTION private.draft_timer_opening_night_completion_enabled()
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$ SELECT true; $$;
