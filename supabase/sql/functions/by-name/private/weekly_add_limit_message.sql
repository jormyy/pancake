-- Canonical SQL source for private.weekly_add_limit_message.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.weekly_add_limit_message(
  p_used int,
  p_limit int,
  p_resets_at timestamptz DEFAULT NULL
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT format('Weekly add limit reached (%s/%s adds used this week).', p_used, p_limit)
    || CASE
         WHEN p_resets_at IS NULL THEN ''
         ELSE format(
           ' Adds reset %s ET.',
           to_char(p_resets_at AT TIME ZONE 'America/New_York', 'Dy, Mon FMDD "at" FMHH12:MI AM')
         )
       END;
$$;
