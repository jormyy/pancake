\set ON_ERROR_STOP on
BEGIN;
\if :{?matchup_id}
\else
  \ir benchmark-fixture.sql
\endif
CREATE TEMP TABLE forecast_season_average_probe AS SELECT :'matchup_id'::uuid AS id;
DO $$
DECLARE
  v_matchup uuid;
  game_date date;
  prepared jsonb;
  direct jsonb;
  expected jsonb;
BEGIN
  SELECT id INTO STRICT v_matchup FROM forecast_season_average_probe;
  FOR game_date IN SELECT jsonb_array_elements_text(public.prepare_matchup_forecast_inputs(v_matchup))::date LOOP
    PERFORM public.prepare_matchup_forecast_inputs(v_matchup,game_date);
  END LOOP;
  prepared := public.get_prepared_matchup_forecast_context(v_matchup);
  direct := public.get_matchup_forecast_context(v_matchup);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('player_id',a.player_id,'avg_fantasy_points',a.avg_fantasy_points) ORDER BY a.player_id),'[]'::jsonb)
  INTO expected
  FROM public.matchups m
  JOIN public.league_seasons s ON s.id=m.league_season_id
  JOIN public.v_player_avg_fantasy_points a ON a.league_id=m.league_id AND a.season_year=s.season_year
  WHERE m.id=v_matchup AND a.player_id IN (
    SELECT r.player_id FROM public.roster_players r
    WHERE r.league_season_id=m.league_season_id AND r.member_id IN(m.home_member_id,m.away_member_id)
  );
  IF jsonb_array_length(expected)=0 THEN RAISE EXCEPTION 'Season averages fixture is empty.'; END IF;
  IF prepared->'seasonAverages' IS DISTINCT FROM expected OR direct->'seasonAverages' IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Forecast inputs do not match league current-season averages.';
  END IF;
  RAISE NOTICE 'Both forecast readers return % current-season player averages.', jsonb_array_length(expected);
END;
$$;
ROLLBACK;
