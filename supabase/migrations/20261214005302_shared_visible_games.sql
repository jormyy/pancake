BEGIN;

CREATE OR REPLACE FUNCTION public.get_visible_player_totals(
  p_league_id uuid,
  p_player_ids uuid[],
  p_season_year integer DEFAULT public.current_season_year_et()
)
RETURNS TABLE (
  player_id uuid,
  totals jsonb,
  rounded_fantasy_average numeric,
  game_status text,
  game_time timestamptz,
  started_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_scoring jsonb;
  v_needs_rounding boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.league_members m
    WHERE m.league_id = p_league_id AND m.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'You do not belong to this league.' USING ERRCODE = '42501';
  END IF;
  IF p_player_ids IS NULL OR cardinality(p_player_ids) > 50 THEN
    RAISE EXCEPTION 'Choose at most 50 visible players.' USING ERRCODE = '22023';
  END IF;
  SELECT l.scoring_settings INTO v_scoring FROM public.leagues l WHERE l.id = p_league_id;
  SELECT EXISTS (
    SELECT 1 FROM jsonb_each_text(v_scoring) coefficient
    WHERE coefficient.key IN ('points','rebounds','assists','steals','blocks','turnovers',
      'three_pointers_made','field_goals_made','field_goals_attempted',
      'free_throws_made','free_throws_attempted','double_double','triple_double')
      AND coefficient.value::numeric <> round(coefficient.value::numeric, 2)
  ) INTO v_needs_rounding;
  RETURN QUERY
  WITH today_games AS MATERIALIZED (
    SELECT g.id, g.home_team, g.away_team, g.status, g.game_time, g.started_at
    FROM public.nba_games g
    WHERE g.game_date = (now() AT TIME ZONE 'America/New_York')::date
      AND g.season_year = p_season_year AND g.nba_game_id LIKE '002%'
  )
  SELECT p.id, COALESCE(to_jsonb(t) - 'player_id' - 'season_year', '{}'::jsonb),
    CASE WHEN v_needs_rounding THEN (
      SELECT round(avg(fp.fantasy_points), 2)
      FROM public.v_fantasy_points fp
      JOIN public.player_game_stats stat ON stat.id = fp.stat_id AND NOT stat.did_not_play
      WHERE fp.league_id = p_league_id AND fp.player_id = p.id AND fp.season_year = p_season_year
    ) ELSE NULL::numeric END,
    game.status::text, game.game_time, game.started_at
  FROM public.players p
  LEFT JOIN analytics.player_season_totals t ON t.player_id = p.id AND t.season_year = p_season_year
  LEFT JOIN LATERAL (
    SELECT g.status, g.game_time, g.started_at
    FROM today_games g
    WHERE p.nba_team IN (g.home_team, g.away_team)
    ORDER BY g.game_time NULLS LAST, g.id LIMIT 1
  ) game ON true
  WHERE p.id = ANY(p_player_ids);
END;
$$;

COMMIT;
