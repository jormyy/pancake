CREATE TABLE private.live_feed_state (
  game_id uuid PRIMARY KEY REFERENCES public.nba_games(id) ON DELETE CASCADE,
  stats_updated_at timestamptz,
  stats_source text CHECK(stats_source IN ('nba','espn')),
  players_initialized boolean NOT NULL DEFAULT false,
  nba_player_ids uuid[] NOT NULL DEFAULT '{}',
  espn_only_player_ids uuid[] NOT NULL DEFAULT '{}',
  scoreboard_updated_at timestamptz,
  scoreboard_source text CHECK(scoreboard_source IN ('nba','espn'))
);
ALTER TABLE private.live_feed_state OWNER TO postgres;
ALTER TABLE private.live_feed_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.live_feed_state FROM PUBLIC,anon,authenticated;

CREATE TABLE private.live_feed_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES public.nba_games(id) ON DELETE CASCADE,
  source text NOT NULL CHECK(source IN ('nba','espn')),
  source_updated_at timestamptz,
  elapsed_seconds numeric NOT NULL,
  stat_rows_changed integer NOT NULL,
  scoreboard_changed boolean NOT NULL,
  written_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX live_feed_audit_game_time ON private.live_feed_audit(game_id,written_at DESC);
ALTER TABLE private.live_feed_audit OWNER TO postgres;
ALTER TABLE private.live_feed_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.live_feed_audit FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.live_nba_witnesses(p_stats jsonb)
RETURNS uuid[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(array_agg(row.player_id ORDER BY row.player_id),'{}'::uuid[])
  FROM jsonb_populate_recordset(NULL::public.player_game_stats,p_stats) AS row
  WHERE NOT (row.did_not_play IS TRUE AND ROW(row.minutes_played, row.points, row.rebounds, row.offensive_rebounds,
          row.defensive_rebounds, row.assists, row.steals, row.blocks, row.turnovers,
          row.personal_fouls, row.field_goals_made, row.field_goals_attempted,
          row.three_pointers_made, row.three_pointers_attempted, row.free_throws_made,
          row.free_throws_attempted, row.plus_minus, row.double_double, row.triple_double)
          IS NOT DISTINCT FROM ROW(0::numeric, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, false));
$$;

CREATE OR REPLACE FUNCTION private.reconcile_espn_live_stats(p_game_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_players uuid[]; v_removed jsonb; v_started_at timestamptz := clock_timestamp();
BEGIN
  IF current_setting('app.verified_stats_game',true) IS DISTINCT FROM p_game_id::text THEN
    RAISE EXCEPTION 'An official NBA snapshot is required.' USING ERRCODE='PT409';
  END IF;
  SELECT espn_only_player_ids INTO v_players FROM private.live_feed_state WHERE game_id=p_game_id;
  IF coalesce(cardinality(v_players),0)=0 THEN RETURN; END IF;
  WITH removed AS (
    DELETE FROM public.player_game_stats WHERE game_id=p_game_id AND player_id=ANY(v_players) RETURNING *
  ) SELECT coalesce(jsonb_agg(to_jsonb(removed)),'[]'::jsonb) INTO v_removed FROM removed;
  IF jsonb_array_length(v_removed)>0 THEN
    INSERT INTO public.sync_runs(function_name,started_at,finished_at,status,rows_affected,details)
      VALUES('sync-stats:espn-live-reconcile',v_started_at,clock_timestamp(),'success',jsonb_array_length(v_removed),
        jsonb_build_object('game_id',p_game_id,'source','espn','removed_provisional_rows',v_removed));
  END IF;
  UPDATE private.live_feed_state SET espn_only_player_ids='{}' WHERE game_id=p_game_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_live_game_stats_atomic(
  p_game_id uuid, p_provider_game_id text, p_stats jsonb, p_elapsed_seconds numeric
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_game public.nba_games%ROWTYPE; v_year integer; v_changed integer;
BEGIN
  IF p_elapsed_seconds IS NULL OR p_elapsed_seconds<0 OR p_elapsed_seconds='NaN'::numeric THEN
    RAISE EXCEPTION 'Live game progress is required.' USING ERRCODE='22023';
  END IF;
  SELECT season_year INTO v_year FROM public.nba_games WHERE id=p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NBA game not found.' USING ERRCODE='P0002'; END IF;
  PERFORM private.lock_nba_source(v_year);
  SELECT * INTO v_game FROM public.nba_games WHERE id=p_game_id FOR UPDATE;
  IF v_game.season_year IS DISTINCT FROM v_year OR v_game.nba_game_id IS DISTINCT FROM p_provider_game_id THEN
    RAISE EXCEPTION 'Game inputs changed. Retry.' USING ERRCODE='PT409';
  END IF;
  IF current_setting('app.live_feed_game',true) IS DISTINCT FROM p_game_id::text
    AND EXISTS(SELECT 1 FROM private.live_feed_state WHERE game_id=p_game_id AND stats_source='espn')
    AND v_game.live_stats_elapsed_seconds>=p_elapsed_seconds THEN RETURN 0; END IF;
  IF v_game.status='Final' OR v_game.live_stats_elapsed_seconds>p_elapsed_seconds THEN RETURN 0; END IF;
  v_changed := public.save_game_stats_atomic(p_game_id,p_provider_game_id,p_stats,false);
  IF current_setting('app.live_feed_game',true) IS DISTINCT FROM p_game_id::text THEN
    UPDATE private.live_feed_state SET nba_player_ids=ARRAY(
      SELECT DISTINCT player FROM unnest(nba_player_ids||private.live_nba_witnesses(p_stats)) player ORDER BY player),
      espn_only_player_ids=ARRAY(SELECT player FROM unnest(espn_only_player_ids) player
        WHERE NOT player=ANY(private.live_nba_witnesses(p_stats)))
      WHERE game_id=p_game_id AND players_initialized
        AND (NOT private.live_nba_witnesses(p_stats)<@nba_player_ids OR private.live_nba_witnesses(p_stats)&&espn_only_player_ids);
    IF v_changed>0 THEN
      INSERT INTO private.live_feed_audit(game_id,source,source_updated_at,elapsed_seconds,stat_rows_changed,scoreboard_changed)
        VALUES(p_game_id,'nba',NULL,p_elapsed_seconds,v_changed,false);
    END IF;
  END IF;
  UPDATE public.nba_games SET live_stats_elapsed_seconds=p_elapsed_seconds WHERE id=p_game_id AND live_stats_elapsed_seconds IS DISTINCT FROM p_elapsed_seconds;
  RETURN v_changed;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_live_scoreboard_atomic(
  p_game_id uuid, p_provider_game_id text, p_status text, p_home_score int, p_away_score int,
  p_status_text text, p_elapsed_seconds numeric
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_game public.nba_games%ROWTYPE; v_year integer; v_changed integer;
BEGIN
  IF p_status NOT IN ('Scheduled','InProgress','Final') OR p_status IS NULL
    OR p_home_score IS NULL OR p_away_score IS NULL OR p_home_score<0 OR p_away_score<0
    OR (p_status<>'Final' AND (p_elapsed_seconds IS NULL OR p_elapsed_seconds<0 OR p_elapsed_seconds='NaN'::numeric)) THEN
    RAISE EXCEPTION 'Valid scoreboard progress and scores are required.' USING ERRCODE='22023';
  END IF;
  SELECT season_year INTO v_year FROM public.nba_games WHERE id=p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NBA game not found.' USING ERRCODE='P0002'; END IF;
  PERFORM private.lock_nba_source(v_year);
  SELECT * INTO v_game FROM public.nba_games WHERE id=p_game_id FOR UPDATE;
  IF v_game.season_year IS DISTINCT FROM v_year OR v_game.nba_game_id IS DISTINCT FROM p_provider_game_id THEN
    RAISE EXCEPTION 'Game inputs changed. Retry.' USING ERRCODE='PT409';
  END IF;
  IF current_setting('app.live_feed_game',true) IS DISTINCT FROM p_game_id::text
    AND EXISTS(SELECT 1 FROM private.live_feed_state WHERE game_id=p_game_id AND scoreboard_source='espn')
    AND v_game.live_scoreboard_elapsed_seconds>=p_elapsed_seconds AND p_status<>'Final' THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM private.game_stat_revisions WHERE game_id=p_game_id)
    AND current_setting('app.verified_stats_game',true) IS DISTINCT FROM p_game_id::text THEN
    RAISE EXCEPTION 'A versioned snapshot is required for verified game data.' USING ERRCODE='PT409';
  END IF;
  IF p_status='Final' AND current_setting('app.verified_stats_game',true)=p_game_id::text THEN
    PERFORM private.reconcile_espn_live_stats(p_game_id);
  END IF;
  IF p_status<>'Final' AND (v_game.status='Final' OR v_game.live_scoreboard_elapsed_seconds>p_elapsed_seconds
    OR (v_game.status='InProgress' AND p_status='Scheduled')) THEN RETURN false; END IF;
  UPDATE public.nba_games SET status=p_status,home_score=p_home_score,away_score=p_away_score,
    game_status_text=CASE WHEN NOT private.lineup_game_available(v_game.status,v_game.game_status_text)
      AND p_status='Scheduled' AND private.lineup_game_available(p_status,p_status_text)
      THEN v_game.game_status_text ELSE p_status_text END,live_scoreboard_elapsed_seconds=p_elapsed_seconds,updated_at=clock_timestamp()
    WHERE id=p_game_id AND ROW(status,home_score,away_score,game_status_text,live_scoreboard_elapsed_seconds)
      IS DISTINCT FROM ROW(p_status,p_home_score,p_away_score,
        CASE WHEN NOT private.lineup_game_available(v_game.status,v_game.game_status_text)
          AND p_status='Scheduled' AND private.lineup_game_available(p_status,p_status_text)
          THEN v_game.game_status_text ELSE p_status_text END,p_elapsed_seconds);
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed>0 AND p_status<>'Final' AND current_setting('app.live_feed_game',true) IS DISTINCT FROM p_game_id::text THEN
    INSERT INTO private.live_feed_audit(game_id,source,source_updated_at,elapsed_seconds,stat_rows_changed,scoreboard_changed)
      VALUES(p_game_id,'nba',NULL,p_elapsed_seconds,0,true);
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_live_feed_snapshot_atomic(p_game_id uuid, p_provider_game_id text, p_snapshot jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_game public.nba_games%ROWTYPE;
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
    v_nba_players := v_state.nba_player_ids;
    IF NOT coalesce(v_state.players_initialized,false) THEN
      SELECT private.live_nba_witnesses(coalesce(jsonb_agg(to_jsonb(stats)),'[]'::jsonb)) INTO v_nba_players
        FROM public.player_game_stats stats WHERE stats.game_id=p_game_id;
    END IF;
    v_nba_players := ARRAY(SELECT DISTINCT player FROM unnest(coalesce(v_nba_players,'{}'::uuid[])||ARRAY(
      SELECT value::uuid FROM jsonb_array_elements_text(coalesce(p_snapshot->'nba_witness_player_ids','[]'::jsonb)) value)) player ORDER BY player);
    v_espn_players := ARRAY(SELECT player FROM unnest(coalesce(v_state.espn_only_player_ids,'{}'::uuid[])) player WHERE NOT player=ANY(v_nba_players));
    IF v_source='nba' THEN
      v_nba_players := ARRAY(SELECT DISTINCT player FROM unnest(coalesce(v_nba_players,'{}'::uuid[])||private.live_nba_witnesses(p_snapshot->'stats')) player ORDER BY player);
      v_espn_players := ARRAY(SELECT player FROM unnest(v_espn_players) player WHERE NOT player=ANY(v_nba_players));
    ELSE
      SELECT coalesce(array_agg((item->>'player_id')::uuid),'{}'::uuid[]) INTO v_players FROM jsonb_array_elements(p_snapshot->'stats') item;
      v_espn_players := ARRAY(SELECT DISTINCT player FROM unnest(v_espn_players||v_players) player WHERE NOT player=ANY(v_nba_players) ORDER BY player);
    END IF;
    v_changed := public.save_live_game_stats_atomic(p_game_id,p_provider_game_id,p_snapshot->'stats',v_elapsed);
    INSERT INTO private.live_feed_state(game_id,stats_updated_at,stats_source,players_initialized,nba_player_ids,espn_only_player_ids)
      VALUES(p_game_id,v_time,v_source,true,v_nba_players,v_espn_players)
    ON CONFLICT(game_id) DO UPDATE SET stats_updated_at=EXCLUDED.stats_updated_at,stats_source=EXCLUDED.stats_source,
      players_initialized=true,nba_player_ids=EXCLUDED.nba_player_ids,espn_only_player_ids=EXCLUDED.espn_only_player_ids
    WHERE ROW(live_feed_state.stats_updated_at,live_feed_state.stats_source,live_feed_state.players_initialized,live_feed_state.nba_player_ids,live_feed_state.espn_only_player_ids)
      IS DISTINCT FROM ROW(EXCLUDED.stats_updated_at,EXCLUDED.stats_source,true,EXCLUDED.nba_player_ids,EXCLUDED.espn_only_player_ids);
  END IF;
  IF v_changed>0 OR v_scoreboard_changed THEN
    INSERT INTO private.live_feed_audit(game_id,source,source_updated_at,elapsed_seconds,stat_rows_changed,scoreboard_changed)
      VALUES(p_game_id,v_source,v_time,v_elapsed,v_changed,v_scoreboard_changed);
  END IF;
  PERFORM set_config('app.live_feed_game',coalesce(v_previous,''),true);
  RETURN v_changed;
END;
$$;

ALTER FUNCTION private.live_nba_witnesses(jsonb) OWNER TO postgres;
ALTER FUNCTION private.reconcile_espn_live_stats(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.live_nba_witnesses(jsonb),private.reconcile_espn_live_stats(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.save_live_feed_snapshot_atomic(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_live_feed_snapshot_atomic(uuid,text,jsonb) TO service_role;
