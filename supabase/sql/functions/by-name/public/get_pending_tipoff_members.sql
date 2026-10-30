-- Canonical SQL source for public.get_pending_tipoff_members.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_pending_tipoff_members(
  p_tipoff_at timestamptz,p_token uuid,p_excluded_members uuid[] DEFAULT ARRAY[]::uuid[],p_limit int DEFAULT 100
)
RETURNS TABLE(league_id uuid,league_season_id uuid,member_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
BEGIN
  IF p_limit IS NULL OR p_limit<1 THEN RAISE EXCEPTION 'Tipoff batch size must be positive' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
    WHERE tipoff_at=p_tipoff_at AND token=p_token AND status='running'
      AND lease_until>clock_timestamp() AND tipoff_at>clock_timestamp()-interval '1 minute'
      AND game_date=(clock_timestamp() AT TIME ZONE 'America/New_York')::date FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tipoff lease expired or changed' USING ERRCODE='40001'; END IF;
  RETURN QUERY SELECT setting.league_id,setting.league_season_id,setting.member_id
  FROM public.lineup_optimizer_settings setting
  JOIN public.league_seasons season ON season.id=setting.league_season_id AND season.is_current
  JOIN public.leagues league ON league.id=setting.league_id AND league.status IN ('active','playoffs')
  WHERE setting.enabled AND NOT (setting.member_id=ANY(COALESCE(p_excluded_members,ARRAY[]::uuid[])))
    AND EXISTS(SELECT 1 FROM public.nba_games game WHERE game.season_year=season.season_year
      AND game.game_date=v_dispatch.game_date AND game.game_time=p_tipoff_at)
    AND NOT EXISTS(SELECT 1 FROM public.lineup_tipoff_members done WHERE done.tipoff_at=p_tipoff_at
      AND done.league_id=setting.league_id AND done.league_season_id=setting.league_season_id
      AND done.member_id=setting.member_id AND done.input_revision=v_dispatch.input_revision)
  ORDER BY setting.last_optimized_at NULLS FIRST,setting.league_id,setting.league_season_id,setting.member_id
  LIMIT p_limit;
END;
$$;
