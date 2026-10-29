\set ON_ERROR_STOP on
BEGIN;
\if :{?matchup_id}
\else
  \ir benchmark-fixture.sql
\endif
SET LOCAL statement_timeout='5s';
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='local-forecast-cache-probe';
CREATE TEMP TABLE forecast_probe AS SELECT :'matchup_id'::uuid AS id;
DO $$
DECLARE v_id uuid; v_expected jsonb; v_actual jsonb; v_date jsonb; v_stat uuid; v_player uuid;
  v_before text[]; v_after text[]; v_rejected boolean;
BEGIN
  SELECT id INTO STRICT v_id FROM forecast_probe;
  v_expected:=private.compute_matchup_forecast_context(v_id);
  IF jsonb_array_length(v_expected->'roster')<40 THEN RAISE EXCEPTION 'Production-sized rosters are required'; END IF;
  FOR v_date IN SELECT value FROM jsonb_array_elements(public.prepare_matchup_forecast_inputs(v_id)) LOOP
    PERFORM public.prepare_matchup_forecast_inputs(v_id,(v_date#>>'{}')::date);
  END LOOP;
  v_actual:=public.get_prepared_matchup_forecast_context(v_id);
  IF v_actual IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Cached context differs from the original context'; END IF;
  SELECT array_agg(h.ctid::text ORDER BY h.player_id) INTO v_before FROM private.forecast_player_history h;
  IF public.prepare_matchup_forecast_inputs(v_id)<>'[]'::jsonb THEN RAISE EXCEPTION 'Warm projections are recomputed'; END IF;
  SELECT array_agg(h.ctid::text ORDER BY h.player_id) INTO v_after FROM private.forecast_player_history h;
  IF v_before IS DISTINCT FROM v_after THEN RAISE EXCEPTION 'Warm player histories are rewritten'; END IF;
  UPDATE private.forecast_season_points SET source_revision='stale'
    WHERE league_id=(SELECT league_id FROM public.matchups WHERE id=v_id);
  IF private.matchup_forecast_inputs_ready(v_id) THEN RAISE EXCEPTION 'Changed season totals pass their source fence'; END IF;
  IF public.prepare_matchup_forecast_inputs(v_id)<>'[]'::jsonb THEN RAISE EXCEPTION 'Season total repair rebuilds unrelated projection dates'; END IF;
  IF public.get_prepared_matchup_forecast_context(v_id) IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Season total repair changes results'; END IF;
  SELECT s.id INTO v_stat FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id
  JOIN public.matchups m ON m.id=v_id JOIN public.league_seasons season ON season.id=m.league_season_id
  JOIN public.roster_players r ON r.league_id=m.league_id AND r.league_season_id=m.league_season_id
    AND r.member_id IN(m.home_member_id,m.away_member_id) AND r.player_id=s.player_id
  WHERE NOT s.did_not_play AND g.status='Final' AND public.is_regular_season_game_id(g.nba_game_id)
    AND s.game_date<(now() AT TIME ZONE 'America/New_York')::date
    AND s.season_year BETWEEN season.season_year-1 AND season.season_year
  ORDER BY s.game_date DESC,s.id LIMIT 1;
  IF v_stat IS NULL THEN RAISE EXCEPTION 'Historical appearances are required'; END IF;
  UPDATE public.player_game_stats SET points=COALESCE(points,0)+1 WHERE id=v_stat;
  IF private.matchup_forecast_inputs_ready(v_id) THEN RAISE EXCEPTION 'A historical correction leaves cached history current'; END IF;
  v_rejected:=false;
  BEGIN PERFORM public.get_prepared_matchup_forecast_context(v_id);
  EXCEPTION WHEN SQLSTATE 'PT409' THEN v_rejected:=true; END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Prepared reads accept changed inputs'; END IF;
  v_expected:=private.compute_matchup_forecast_context(v_id);
  IF public.get_matchup_forecast_context(v_id) IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Legacy readers lose current corrections'; END IF;
  FOR v_date IN SELECT value FROM jsonb_array_elements(public.prepare_matchup_forecast_inputs(v_id)) LOOP
    PERFORM public.prepare_matchup_forecast_inputs(v_id,(v_date#>>'{}')::date);
  END LOOP;
  v_actual:=public.get_prepared_matchup_forecast_context(v_id);
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'Prepared corrections differ in %',(SELECT array_agg(e.key) FROM jsonb_each(v_expected) e WHERE e.value IS DISTINCT FROM v_actual->e.key);
  END IF;
  v_player:=(v_expected->'projections'->0->>'player_id')::uuid;
  INSERT INTO public.player_projections(player_id,season_year,week_number,projected_stat_points,fetched_at)
    SELECT v_player,s.season_year,m.week_number,99,now() FROM public.matchups m JOIN public.league_seasons s ON s.id=m.league_season_id WHERE m.id=v_id
    ON CONFLICT(player_id,season_year,week_number) DO UPDATE SET projected_stat_points=99,fetched_at=now();
  IF private.matchup_forecast_inputs_ready(v_id) THEN RAISE EXCEPTION 'New projection values leave the cache current'; END IF;
  FOR v_date IN SELECT value FROM jsonb_array_elements(public.prepare_matchup_forecast_inputs(v_id)) LOOP
    PERFORM public.prepare_matchup_forecast_inputs(v_id,(v_date#>>'{}')::date);
  END LOOP;
  UPDATE public.players SET updated_at=clock_timestamp() WHERE id=v_player;
  IF NOT private.matchup_forecast_inputs_ready(v_id) THEN RAISE EXCEPTION 'Metadata-only player updates rebuild projection inputs'; END IF;
  UPDATE public.nba_games SET live_scoreboard_elapsed_seconds=COALESCE(live_scoreboard_elapsed_seconds,0)+1
    WHERE id=(v_expected->'games'->0->>'id')::uuid;
  IF NOT private.matchup_forecast_inputs_ready(v_id) THEN RAISE EXCEPTION 'Scoreboard clocks rebuild projection inputs'; END IF;
  v_expected:=private.compute_matchup_forecast_context(v_id);
  IF public.get_prepared_matchup_forecast_context(v_id) IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Projection or clock changes lose parity'; END IF;
  UPDATE private.forecast_projection_inputs SET valid_until=now() WHERE matchup_id=v_id;
  IF private.matchup_forecast_inputs_ready(v_id) THEN RAISE EXCEPTION 'Expired projections remain current'; END IF;
  FOR v_date IN SELECT value FROM jsonb_array_elements(public.prepare_matchup_forecast_inputs(v_id)) LOOP
    PERFORM public.prepare_matchup_forecast_inputs(v_id,(v_date#>>'{}')::date);
  END LOOP;
  IF public.get_prepared_matchup_forecast_context(v_id) IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Projection refresh changes current results'; END IF;
  IF has_function_privilege('authenticated','public.prepare_matchup_forecast_inputs(uuid,date)','EXECUTE')
    OR has_function_privilege('authenticated','public.get_prepared_matchup_forecast_context(uuid)','EXECUTE')
    OR has_table_privilege('authenticated','private.forecast_player_history','SELECT') THEN
    RAISE EXCEPTION 'Clients can access private forecast inputs';
  END IF;
END;
$$;
SELECT 'Context parity, warm reuse, corrections, expiry, and access checks pass' AS result;
ROLLBACK;
