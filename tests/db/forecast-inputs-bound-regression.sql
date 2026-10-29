\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='3s';
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='local-forecast-bound-probe';
DO $$
DECLARE parent_index oid; leaf_count integer; indexed_count integer;
BEGIN
  SELECT oid INTO STRICT parent_index FROM pg_class WHERE oid='public.idx_pgs_forecast_history'::regclass AND relkind='I';
  SELECT count(*) INTO leaf_count FROM pg_partition_tree('public.player_game_stats') WHERE isleaf;
  SELECT count(*) INTO indexed_count FROM pg_inherits i JOIN pg_index x ON x.indexrelid=i.inhrelid
    WHERE i.inhparent=parent_index AND x.indisvalid;
  IF leaf_count<>indexed_count THEN RAISE EXCEPTION 'Every stats partition needs the history index'; END IF;
  CREATE TABLE public.forecast_bound_partition_probe PARTITION OF public.player_game_stats
    FOR VALUES IN('ffffffff-ffff-ffff-ffff-fffffffffff0');
  IF NOT EXISTS(SELECT 1 FROM pg_index x JOIN pg_inherits i ON i.inhrelid=x.indexrelid
    WHERE x.indrelid='public.forecast_bound_partition_probe'::regclass AND i.inhparent=parent_index AND x.indisvalid) THEN
    RAISE EXCEPTION 'New partitions must inherit the history index';
  END IF;
END;
$$;
DO $$
DECLARE matchup uuid; dates jsonb; day jsonb; histories text[]; projections text[]; season_rows text[];
  player uuid; league uuid; season integer; points numeric;
BEGIN
  SELECT id,league_id INTO STRICT matchup,league FROM public.matchups WHERE id::text LIKE '07ad4dd3%';
  SELECT s.season_year INTO STRICT season FROM public.matchups m JOIN public.league_seasons s ON s.id=m.league_season_id WHERE m.id=matchup;
  dates:=public.prepare_matchup_forecast_inputs(matchup);
  FOR day IN SELECT value FROM jsonb_array_elements(dates) LOOP
    PERFORM public.prepare_matchup_forecast_inputs(matchup,(day#>>'{}')::date);
  END LOOP;
  SELECT array_agg(ctid::text ORDER BY player_id) INTO histories FROM private.forecast_player_history WHERE league_id=league;
  SELECT array_agg(ctid::text ORDER BY game_date) INTO projections FROM private.forecast_projection_inputs WHERE matchup_id=matchup;
  SELECT array_agg(ctid::text ORDER BY player_id) INTO season_rows FROM private.forecast_season_points WHERE league_id=league;
  IF public.prepare_matchup_forecast_inputs(matchup)<>'[]'::jsonb THEN RAISE EXCEPTION 'Unchanged inputs request projection work'; END IF;
  FOR day IN SELECT value FROM jsonb_array_elements(dates) LOOP
    PERFORM public.prepare_matchup_forecast_inputs(matchup,(day#>>'{}')::date);
  END LOOP;
  IF histories IS DISTINCT FROM (SELECT array_agg(ctid::text ORDER BY player_id) FROM private.forecast_player_history WHERE league_id=league)
    OR projections IS DISTINCT FROM (SELECT array_agg(ctid::text ORDER BY game_date) FROM private.forecast_projection_inputs WHERE matchup_id=matchup)
    OR season_rows IS DISTINCT FROM (SELECT array_agg(ctid::text ORDER BY player_id) FROM private.forecast_season_points WHERE league_id=league) THEN
    RAISE EXCEPTION 'Unchanged inputs rewrite prepared rows';
  END IF;
  SELECT player_id,fantasy_points INTO STRICT player,points FROM private.forecast_season_points
    WHERE league_id=league AND season_year=season ORDER BY player_id LIMIT 1;
  SELECT array_agg(ctid::text ORDER BY player_id) INTO season_rows FROM private.forecast_season_points WHERE league_id=league AND player_id<>player;
  UPDATE analytics.player_season_totals SET games_played=games_played WHERE player_id=player AND season_year=season;
  IF NOT private.matchup_forecast_inputs_ready(matchup) THEN RAISE EXCEPTION 'A refreshed source xmin invalidates unchanged inputs'; END IF;
  PERFORM public.prepare_matchup_forecast_inputs(matchup);
  IF points IS DISTINCT FROM (SELECT fantasy_points FROM private.forecast_season_points WHERE league_id=league AND season_year=season AND player_id=player)
    OR season_rows IS DISTINCT FROM (SELECT array_agg(ctid::text ORDER BY player_id) FROM private.forecast_season_points WHERE league_id=league AND player_id<>player) THEN
    RAISE EXCEPTION 'A source xmin update recomputes unrelated players';
  END IF;
END;
$$;
SET LOCAL ROLE service_role;
DO $$
DECLARE matchup uuid; day jsonb;
BEGIN
  FOR matchup IN SELECT id FROM public.matchups WHERE left(id::text,8) IN('07ad4dd3','ccb35830','e47fcb99') LOOP
    FOR day IN SELECT value FROM jsonb_array_elements(public.prepare_matchup_forecast_inputs(matchup)) LOOP
      PERFORM public.prepare_matchup_forecast_inputs(matchup,(day#>>'{}')::date);
    END LOOP;
    IF public.get_prepared_matchup_forecast_context(matchup) IS NULL THEN RAISE EXCEPTION 'The service role loses the forecast'; END IF;
  END LOOP;
END;
$$;
RESET ROLE;
SELECT 'Partition inheritance, unchanged input reuse, and source xmin isolation pass' AS result;
ROLLBACK;
