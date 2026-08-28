-- Canonical SQL source for private.weekly_add_limit_message.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.weekly_add_limit_message(
  p_used int,
  p_limit int,
  p_resets_at timestamptz
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  -- The one verdict on the weekly limit: the rejection sentence while the
  -- week's adds are used up, NULL while adds remain or the league has no limit.
  SELECT CASE
           WHEN p_limit IS NULL OR COALESCE(p_used, 0) < p_limit THEN NULL
           ELSE format('Weekly add limit reached (%s/%s adds used this week).', COALESCE(p_used, 0), p_limit)
             || COALESCE(format(' Adds reset %s.', private.weekly_add_limit_reset_label(p_resets_at)), '')
         END;
$$;
