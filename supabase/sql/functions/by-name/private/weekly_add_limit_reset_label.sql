-- Canonical SQL source for private.weekly_add_limit_reset_label.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.weekly_add_limit_reset_label(p_resets_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  -- "Mon, Nov 2 at 12:00 AM ET": the one rendering of the reset boundary, shown by
  -- the rejection message and by every client surface.
  SELECT CASE
           WHEN p_resets_at IS NULL THEN NULL
           ELSE to_char(p_resets_at AT TIME ZONE private.add_week_timezone(), 'Dy, Mon FMDD "at" FMHH12:MI AM') || ' ET'
         END;
$$;
