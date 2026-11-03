-- Canonical SQL source for public.apply_daily_lineup.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.apply_daily_lineup(
  p_game_date date, p_league_id uuid, p_league_season_id uuid, p_member_id uuid, p_assignments jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_setting public.lineup_optimizer_settings%ROWTYPE; v_changed boolean;
BEGIN
  IF p_game_date IS DISTINCT FROM (now() AT TIME ZONE 'America/New_York')::date THEN RETURN false; END IF;
  SELECT * INTO v_setting FROM public.lineup_optimizer_settings
  WHERE league_id = p_league_id AND league_season_id = p_league_season_id AND member_id = p_member_id FOR UPDATE;
  IF NOT FOUND OR NOT v_setting.enabled OR v_setting.last_daily_optimized_date = p_game_date THEN RETURN false; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.nba_games g JOIN public.league_seasons ls ON ls.season_year = g.season_year
    WHERE ls.id = p_league_season_id AND ls.is_current AND g.game_date = p_game_date
      AND g.status = 'Scheduled' AND private.lineup_game_available(g.status, g.game_status_text)
      AND (g.game_time IS NULL OR g.game_time > now())
      AND (g.started_at IS NULL OR g.started_at > now())
  ) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.lineup_tipoff_members
    WHERE league_id = p_league_id AND league_season_id = p_league_season_id AND member_id = p_member_id
      AND (tipoff_at AT TIME ZONE 'America/New_York')::date = p_game_date AND error IS NULL) THEN
    UPDATE public.lineup_optimizer_settings SET last_daily_optimized_date = p_game_date
    WHERE league_id = p_league_id AND league_season_id = p_league_season_id AND member_id = p_member_id;
    RETURN false;
  END IF;
  v_changed := private.apply_scheduled_lineup(p_game_date, p_league_id, p_league_season_id, p_member_id, p_assignments);
  UPDATE public.lineup_optimizer_settings SET last_daily_optimized_date = p_game_date, last_optimized_at = now()
  WHERE league_id = p_league_id AND league_season_id = p_league_season_id AND member_id = p_member_id;
  RETURN v_changed;
END;
$$;
