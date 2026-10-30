-- Canonical SQL source for private.prevent_pre_draft_rookie_acquisition.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_pre_draft_rookie_acquisition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.acquired_via IN ('free_agent', 'waiver') AND EXISTS (
    SELECT 1
      FROM public.leagues AS league
      JOIN public.league_seasons AS season ON season.league_id = league.id AND season.is_current
      JOIN public.players AS player ON player.id = NEW.player_id
     WHERE league.id = NEW.league_id
       AND season.id = NEW.league_season_id
       AND league.status = 'offseason'
       AND player.years_exp = 0
       AND player.nba_draft_number IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.drafts AS draft
          WHERE draft.league_id = league.id
            AND draft.league_season_id = season.id
            AND draft.draft_type = 'snake'
            AND NOT draft.is_mock
            AND draft.status = 'completed'
       )
  ) THEN
    RAISE EXCEPTION 'Drafted rookies are available after your league completes its rookie draft.'
      USING ERRCODE = 'PA008';
  END IF;
  RETURN NEW;
END;
$$;
