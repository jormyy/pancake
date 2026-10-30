-- Canonical SQL source for private.assert_trade_window.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_trade_window(p_league_id uuid, p_pick_ids uuid[] DEFAULT '{}'::uuid[])
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_status public.league_status; v_future_pick_years smallint;
BEGIN
  SELECT status, future_pick_years INTO v_status, v_future_pick_years FROM public.leagues WHERE id=p_league_id FOR NO KEY UPDATE NOWAIT;
  IF v_status='setup' OR EXISTS (
    SELECT 1 FROM public.drafts draft
    JOIN public.league_seasons season ON season.id=draft.league_season_id AND season.is_current
    WHERE draft.league_id=p_league_id AND NOT draft.is_mock AND draft.draft_type='auction'
      AND draft.status IN ('pending','in_progress','paused')
  ) THEN
    RAISE EXCEPTION 'Trades open after the startup draft.' USING ERRCODE='P0001';
  END IF;
  IF v_status NOT IN ('offseason','drafting','active','playoffs') THEN
    RAISE EXCEPTION 'Trades open during offseason, drafting, active, and playoff seasons.' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.draft_picks pick JOIN public.league_seasons season
      ON season.league_id=pick.league_id AND season.is_current
    WHERE pick.league_id=p_league_id AND pick.id=ANY(p_pick_ids) AND pick.season_year<season.season_year
  ) THEN
    RAISE EXCEPTION 'Picks from past seasons cannot be traded.' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.draft_picks pick JOIN public.league_seasons season
      ON season.league_id=pick.league_id AND season.is_current
    WHERE pick.league_id=p_league_id AND pick.id=ANY(p_pick_ids) AND pick.season_year>season.season_year+v_future_pick_years
  ) THEN
    RAISE EXCEPTION 'Only the next % future draft years can be traded.',v_future_pick_years USING ERRCODE='P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.drafts draft
    JOIN public.league_seasons season ON season.id=draft.league_season_id AND season.is_current
    JOIN public.snake_draft_picks slot ON slot.draft_id=draft.id
    WHERE draft.league_id=p_league_id AND NOT draft.is_mock
      AND draft.status IN ('in_progress','paused')
      AND slot.draft_pick_id=ANY(p_pick_ids) AND slot.player_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Picks in the live draft can be traded after the draft.' USING ERRCODE='P0001';
  END IF;
END;
$$;
