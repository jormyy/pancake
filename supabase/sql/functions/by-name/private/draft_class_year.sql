-- Canonical SQL source for private.draft_class_year.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.draft_class_year(p_draft_id uuid)
RETURNS int
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT private.draft_year_for_season(season.season_year)
    FROM public.drafts draft
    JOIN public.league_seasons season ON season.id = draft.league_season_id
   WHERE draft.id = p_draft_id
$$;
