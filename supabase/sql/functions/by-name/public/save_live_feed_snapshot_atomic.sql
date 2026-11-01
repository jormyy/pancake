-- Canonical SQL source for public.save_live_feed_snapshot_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.save_live_feed_snapshot_atomic(p_game_id uuid, p_provider_game_id text, p_snapshot jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_game public.nba_games%ROWTYPE;
  v_snapshot jsonb;
  v_stats jsonb;
  v_write_stats jsonb;
  v_state private.live_feed_state%ROWTYPE;
  v_year integer;
  v_source text := p_snapshot->>'source';
  v_time timestamptz := (p_snapshot->>'source_updated_at')::timestamptz;
  v_elapsed numeric := (p_snapshot->>'elapsed_seconds')::numeric;
  v_changed integer := 0;
  v_scoreboard_changed boolean := false;
  v_nba_players uuid[];
  v_espn_players uuid[];
  v_players uuid[];
  v_previous text := current_setting('app.live_feed_game',true);
BEGIN
  IF v_source IS NULL OR v_source NOT IN ('nba','espn') OR v_time IS NULL OR NOT isfinite(v_time)
    OR v_time>clock_timestamp()+interval '5 seconds' OR v_elapsed IS NULL OR v_elapsed<0 OR v_elapsed IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
    OR (p_snapshot ? 'status' AND (p_snapshot->>'status' IS NULL OR p_snapshot->>'status' NOT IN ('Scheduled','InProgress')))
    OR (v_source='espn' AND (p_snapshot->>'status' IS DISTINCT FROM 'InProgress' OR NOT p_snapshot ? 'stats')) THEN
    RAISE EXCEPTION 'Valid live source, timestamp and progress are required.' USING ERRCODE='22023';
  END IF;
  v_stats := coalesce(p_snapshot->'full_stats',p_snapshot->'stats');
  v_snapshot := p_snapshot-'full_stats';
  IF p_snapshot ? 'stats' THEN
    SELECT jsonb_set(v_snapshot,'{stats}',coalesce(jsonb_agg(item-'updated_at' ORDER BY item->>'player_id'),'[]'::jsonb))
      INTO v_snapshot FROM jsonb_array_elements(v_stats) item;
  END IF;
  IF EXISTS(SELECT 1 FROM public.nba_games game JOIN private.live_feed_state feed ON feed.game_id=game.id
    WHERE game.id=p_game_id AND game.nba_game_id=p_provider_game_id AND game.status<>'Final'
      AND feed.stats_snapshot=v_snapshot) THEN RETURN 0; END IF;
  SELECT season_year INTO v_year FROM public.nba_games WHERE id=p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NBA game not found.' USING ERRCODE='P0002'; END IF;
  PERFORM private.lock_nba_source(v_year);
  SELECT * INTO v_game FROM public.nba_games WHERE id=p_game_id FOR UPDATE;
  IF v_game.season_year IS DISTINCT FROM v_year OR v_game.nba_game_id IS DISTINCT FROM p_provider_game_id THEN
    RAISE EXCEPTION 'Game inputs changed. Retry.' USING ERRCODE='PT409';
  END IF;
  IF v_game.status='Final' THEN RETURN 0; END IF;
  SELECT * INTO v_state FROM private.live_feed_state WHERE game_id=p_game_id;
  PERFORM set_config('app.live_feed_game',p_game_id::text,true);
  IF p_snapshot ? 'status' AND (v_state.scoreboard_updated_at IS NULL OR v_time>v_state.scoreboard_updated_at
      OR (v_time=v_state.scoreboard_updated_at AND (v_source='nba' OR v_state.scoreboard_source='espn')))
    AND (v_game.live_scoreboard_elapsed_seconds IS NULL OR v_elapsed>=v_game.live_scoreboard_elapsed_seconds) THEN
    IF public.save_live_scoreboard_atomic(p_game_id,p_provider_game_id,p_snapshot->>'status',
      (p_snapshot->>'home_score')::int,(p_snapshot->>'away_score')::int,p_snapshot->>'status_text',v_elapsed) THEN
      v_scoreboard_changed := ROW(v_game.status,v_game.home_score,v_game.away_score,v_game.game_status_text,v_game.live_scoreboard_elapsed_seconds)
        IS DISTINCT FROM ROW(p_snapshot->>'status',(p_snapshot->>'home_score')::int,(p_snapshot->>'away_score')::int,p_snapshot->>'status_text',v_elapsed);
      INSERT INTO private.live_feed_state(game_id,scoreboard_updated_at,scoreboard_source) VALUES(p_game_id,v_time,v_source)
      ON CONFLICT(game_id) DO UPDATE SET scoreboard_updated_at=EXCLUDED.scoreboard_updated_at,scoreboard_source=EXCLUDED.scoreboard_source
      WHERE ROW(live_feed_state.scoreboard_updated_at,live_feed_state.scoreboard_source) IS DISTINCT FROM ROW(EXCLUDED.scoreboard_updated_at,EXCLUDED.scoreboard_source);
    END IF;
  END IF;
  IF p_snapshot ? 'stats' AND (v_state.stats_updated_at IS NULL OR v_time>v_state.stats_updated_at
      OR (v_time=v_state.stats_updated_at AND (v_source='nba' OR v_state.stats_source='espn')))
    AND (v_game.live_stats_elapsed_seconds IS NULL OR v_elapsed>=v_game.live_stats_elapsed_seconds) THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_populate_recordset(NULL::public.player_game_stats,v_stats) incoming
      WHERE incoming.player_id IS NULL OR incoming.game_id IS DISTINCT FROM p_game_id OR incoming.did_not_play IS NULL
    ) OR (SELECT count(DISTINCT (item->>'player_id')::uuid) FROM jsonb_array_elements(v_stats) item)<>jsonb_array_length(v_stats) THEN
      RAISE EXCEPTION 'Box score rows do not match the current game or contain duplicate players.' USING ERRCODE='22023';
    END IF;
    v_nba_players := v_state.nba_player_ids;
    IF NOT coalesce(v_state.players_initialized,false) THEN
      SELECT private.live_nba_witnesses(coalesce(jsonb_agg(to_jsonb(stats)),'[]'::jsonb)) INTO v_nba_players
        FROM public.player_game_stats stats WHERE stats.game_id=p_game_id;
    END IF;
    v_nba_players := ARRAY(SELECT DISTINCT player FROM unnest(coalesce(v_nba_players,'{}'::uuid[])||ARRAY(
      SELECT value::uuid FROM jsonb_array_elements_text(coalesce(p_snapshot->'nba_witness_player_ids','[]'::jsonb)) value)) player ORDER BY player);
    v_espn_players := ARRAY(SELECT player FROM unnest(coalesce(v_state.espn_only_player_ids,'{}'::uuid[])) player WHERE NOT player=ANY(v_nba_players));
    IF v_source='nba' THEN
      v_nba_players := ARRAY(SELECT DISTINCT player FROM unnest(coalesce(v_nba_players,'{}'::uuid[])||private.live_nba_witnesses(v_stats)) player ORDER BY player);
      v_espn_players := ARRAY(SELECT player FROM unnest(v_espn_players) player WHERE NOT player=ANY(v_nba_players));
    ELSE
      SELECT coalesce(array_agg((item->>'player_id')::uuid),'{}'::uuid[]) INTO v_players FROM jsonb_array_elements(v_stats) item;
      v_espn_players := ARRAY(SELECT DISTINCT player FROM unnest(v_espn_players||v_players) player WHERE NOT player=ANY(v_nba_players) ORDER BY player);
    END IF;
    SELECT coalesce(jsonb_agg(incoming.item),'[]'::jsonb) INTO v_write_stats
      FROM jsonb_array_elements(v_snapshot->'stats') incoming(item)
      LEFT JOIN jsonb_array_elements(v_state.stats_snapshot->'stats') previous(item)
        ON previous.item->>'player_id'=incoming.item->>'player_id'
      WHERE incoming.item IS DISTINCT FROM previous.item;
    v_changed := public.save_live_game_stats_atomic(p_game_id,p_provider_game_id,v_write_stats,v_elapsed);
    INSERT INTO private.live_feed_state(game_id,stats_updated_at,stats_source,players_initialized,nba_player_ids,espn_only_player_ids,stats_snapshot)
      VALUES(p_game_id,v_time,v_source,true,v_nba_players,v_espn_players,v_snapshot)
    ON CONFLICT(game_id) DO UPDATE SET stats_updated_at=EXCLUDED.stats_updated_at,stats_source=EXCLUDED.stats_source,
      players_initialized=true,nba_player_ids=EXCLUDED.nba_player_ids,espn_only_player_ids=EXCLUDED.espn_only_player_ids,stats_snapshot=EXCLUDED.stats_snapshot
    WHERE ROW(live_feed_state.stats_updated_at,live_feed_state.stats_source,live_feed_state.players_initialized,live_feed_state.nba_player_ids,live_feed_state.espn_only_player_ids,live_feed_state.stats_snapshot)
      IS DISTINCT FROM ROW(EXCLUDED.stats_updated_at,EXCLUDED.stats_source,true,EXCLUDED.nba_player_ids,EXCLUDED.espn_only_player_ids,EXCLUDED.stats_snapshot);
  END IF;
  IF v_changed>0 OR v_scoreboard_changed THEN
    INSERT INTO private.live_feed_audit(game_id,source,source_updated_at,elapsed_seconds,stat_rows_changed,scoreboard_changed)
      VALUES(p_game_id,v_source,v_time,v_elapsed,v_changed,v_scoreboard_changed);
  END IF;
  PERFORM set_config('app.live_feed_game',coalesce(v_previous,''),true);
  RETURN v_changed;
END;
$$;
