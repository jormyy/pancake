BEGIN;
ALTER TABLE private.live_feed_state ADD COLUMN stats_snapshot jsonb;
CREATE TABLE private.live_game_identity_checks (
  game_id uuid PRIMARY KEY REFERENCES public.nba_games(id) ON DELETE CASCADE,
  season_year integer NOT NULL
);
ALTER TABLE private.live_game_identity_checks OWNER TO postgres;
ALTER TABLE private.live_game_identity_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.live_game_identity_checks FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.save_live_cache_invalidate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME='nba_games' THEN
    IF TG_OP='UPDATE' AND ROW(NEW.nba_game_id,NEW.season_year,NEW.game_date,NEW.home_team,NEW.away_team)
      IS NOT DISTINCT FROM ROW(OLD.nba_game_id,OLD.season_year,OLD.game_date,OLD.home_team,OLD.away_team) THEN
      IF NEW.id::text IS DISTINCT FROM current_setting('app.live_feed_game',true)
        AND ROW(NEW.status,NEW.home_score,NEW.away_score,NEW.game_status_text,NEW.live_stats_elapsed_seconds,NEW.live_scoreboard_elapsed_seconds)
          IS DISTINCT FROM ROW(OLD.status,OLD.home_score,OLD.away_score,OLD.game_status_text,OLD.live_stats_elapsed_seconds,OLD.live_scoreboard_elapsed_seconds) THEN
        UPDATE private.live_feed_state SET stats_snapshot=NULL WHERE game_id=NEW.id AND stats_snapshot IS NOT NULL;
      END IF;
      RETURN NULL;
    END IF;
    DELETE FROM private.live_game_identity_checks WHERE season_year=NEW.season_year;
    IF TG_OP='UPDATE' THEN
      DELETE FROM private.live_game_identity_checks WHERE season_year=OLD.season_year;
      UPDATE private.live_feed_state SET stats_snapshot=NULL WHERE game_id=NEW.id AND stats_snapshot IS NOT NULL;
    END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM changed_stats) THEN RETURN NULL; END IF;
    UPDATE private.live_feed_state feed SET stats_snapshot=NULL
      WHERE feed.stats_snapshot IS NOT NULL
        AND feed.game_id::text IS DISTINCT FROM current_setting('app.live_feed_game',true)
        AND feed.game_id IN (SELECT game_id FROM changed_stats);
    IF TG_OP='UPDATE' THEN
      UPDATE private.live_feed_state feed SET stats_snapshot=NULL
        WHERE feed.stats_snapshot IS NOT NULL
          AND feed.game_id::text IS DISTINCT FROM current_setting('app.live_feed_game',true)
          AND feed.game_id IN (SELECT game_id FROM prior_stats);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_nba_game_unambiguous(p_game_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_game public.nba_games%ROWTYPE; v_year int;
BEGIN
  SELECT season_year INTO v_year FROM public.nba_games WHERE id=p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NBA game not found.' USING ERRCODE='P0002'; END IF;
  PERFORM private.lock_nba_source(v_year,true);
  SELECT * INTO v_game FROM public.nba_games WHERE id=p_game_id;
  IF NOT FOUND OR v_game.season_year<>v_year THEN RAISE EXCEPTION 'Game inputs changed. Retry.' USING ERRCODE = 'PT409'; END IF;
  PERFORM private.assert_nba_game_candidate(v_game.nba_game_id,v_game.season_year,v_game.game_date,v_game.home_team,v_game.away_team,v_game.id);
  INSERT INTO private.live_game_identity_checks(game_id,season_year) VALUES(v_game.id,v_game.season_year) ON CONFLICT DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_live_game_stats_atomic(
  p_game_id uuid, p_provider_game_id text, p_stats jsonb, p_elapsed_seconds numeric
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_game public.nba_games%ROWTYPE; v_year integer; v_changed integer := 0;
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
  IF NOT EXISTS(SELECT 1 FROM private.live_game_identity_checks WHERE game_id=p_game_id) THEN
    PERFORM public.assert_nba_game_unambiguous(p_game_id);
  END IF;
  IF EXISTS (SELECT 1 FROM private.game_stat_revisions WHERE game_id=p_game_id)
    AND current_setting('app.verified_stats_game',true) IS DISTINCT FROM p_game_id::text THEN
    RAISE EXCEPTION 'A versioned snapshot is required for verified game data.' USING ERRCODE='PT409';
  END IF;
  IF v_game.nba_game_id IS DISTINCT FROM p_provider_game_id THEN
    RAISE EXCEPTION 'Game provider identity changed. Fetch the game again.' USING ERRCODE = 'PT409';
  END IF;
  IF jsonb_typeof(p_stats) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'A complete parsed box score is required.' USING ERRCODE = '22023';
  END IF;
  IF v_game.status = 'Final' THEN
    RAISE EXCEPTION 'Final game box score is not final.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_stats)>0 THEN
  IF EXISTS (
    SELECT 1 FROM jsonb_populate_recordset(NULL::public.player_game_stats, p_stats) AS row
    WHERE row.player_id IS NULL OR row.game_id IS DISTINCT FROM p_game_id
       OR row.did_not_play IS NULL
  ) OR (SELECT count(DISTINCT (row->>'player_id')::uuid) FROM jsonb_array_elements(p_stats) AS row) <> jsonb_array_length(p_stats) THEN
    RAISE EXCEPTION 'Box score rows do not match the current game or contain duplicate players.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.player_game_stats AS stored (
    player_id, game_id, is_home, season_year, week_number, minutes_played, points, rebounds, offensive_rebounds, defensive_rebounds, assists, steals, blocks, turnovers, personal_fouls, field_goals_made, field_goals_attempted, three_pointers_made, three_pointers_attempted, free_throws_made, free_throws_attempted, plus_minus, double_double, triple_double, did_not_play, updated_at
  )
  SELECT incoming.player_id, v_game.id, incoming.is_home, v_game.season_year, v_game.week_number, incoming.minutes_played, incoming.points, incoming.rebounds, incoming.offensive_rebounds, incoming.defensive_rebounds, incoming.assists, incoming.steals, incoming.blocks, incoming.turnovers, incoming.personal_fouls, incoming.field_goals_made, incoming.field_goals_attempted, incoming.three_pointers_made, incoming.three_pointers_attempted, incoming.free_throws_made, incoming.free_throws_attempted, incoming.plus_minus, incoming.double_double, incoming.triple_double, incoming.did_not_play, clock_timestamp()
  FROM jsonb_populate_recordset(NULL::public.player_game_stats, p_stats) AS incoming
  LEFT JOIN public.player_game_stats previous ON previous.player_id=incoming.player_id AND previous.game_id=v_game.id
  WHERE previous.player_id IS NULL OR ROW(previous.player_id, previous.game_id, previous.is_home, previous.season_year, previous.week_number, previous.minutes_played, previous.points, previous.rebounds, previous.offensive_rebounds, previous.defensive_rebounds, previous.assists, previous.steals, previous.blocks, previous.turnovers, previous.personal_fouls, previous.field_goals_made, previous.field_goals_attempted, previous.three_pointers_made, previous.three_pointers_attempted, previous.free_throws_made, previous.free_throws_attempted, previous.plus_minus, previous.double_double, previous.triple_double, previous.did_not_play)
    IS DISTINCT FROM ROW(incoming.player_id, v_game.id, COALESCE(incoming.is_home, previous.is_home), v_game.season_year, v_game.week_number, incoming.minutes_played, incoming.points, incoming.rebounds, incoming.offensive_rebounds, incoming.defensive_rebounds, incoming.assists, incoming.steals, incoming.blocks, incoming.turnovers, incoming.personal_fouls, incoming.field_goals_made, incoming.field_goals_attempted, incoming.three_pointers_made, incoming.three_pointers_attempted, incoming.free_throws_made, incoming.free_throws_attempted, incoming.plus_minus, incoming.double_double, incoming.triple_double, incoming.did_not_play)
  ON CONFLICT (player_id, game_id) DO UPDATE SET
    is_home = COALESCE(EXCLUDED.is_home, stored.is_home),
    season_year = EXCLUDED.season_year,
    week_number = EXCLUDED.week_number,
    minutes_played = EXCLUDED.minutes_played,
    points = EXCLUDED.points,
    rebounds = EXCLUDED.rebounds,
    offensive_rebounds = EXCLUDED.offensive_rebounds,
    defensive_rebounds = EXCLUDED.defensive_rebounds,
    assists = EXCLUDED.assists,
    steals = EXCLUDED.steals,
    blocks = EXCLUDED.blocks,
    turnovers = EXCLUDED.turnovers,
    personal_fouls = EXCLUDED.personal_fouls,
    field_goals_made = EXCLUDED.field_goals_made,
    field_goals_attempted = EXCLUDED.field_goals_attempted,
    three_pointers_made = EXCLUDED.three_pointers_made,
    three_pointers_attempted = EXCLUDED.three_pointers_attempted,
    free_throws_made = EXCLUDED.free_throws_made,
    free_throws_attempted = EXCLUDED.free_throws_attempted,
    plus_minus = EXCLUDED.plus_minus,
    double_double = EXCLUDED.double_double,
    triple_double = EXCLUDED.triple_double,
    did_not_play = EXCLUDED.did_not_play,
    updated_at = EXCLUDED.updated_at
  WHERE ROW(stored.player_id, stored.game_id, stored.is_home, stored.season_year, stored.week_number, stored.minutes_played, stored.points, stored.rebounds, stored.offensive_rebounds, stored.defensive_rebounds, stored.assists, stored.steals, stored.blocks, stored.turnovers, stored.personal_fouls, stored.field_goals_made, stored.field_goals_attempted, stored.three_pointers_made, stored.three_pointers_attempted, stored.free_throws_made, stored.free_throws_attempted, stored.plus_minus, stored.double_double, stored.triple_double, stored.did_not_play)
    IS DISTINCT FROM ROW(EXCLUDED.player_id, EXCLUDED.game_id, COALESCE(EXCLUDED.is_home, stored.is_home), EXCLUDED.season_year, EXCLUDED.week_number, EXCLUDED.minutes_played, EXCLUDED.points, EXCLUDED.rebounds, EXCLUDED.offensive_rebounds, EXCLUDED.defensive_rebounds, EXCLUDED.assists, EXCLUDED.steals, EXCLUDED.blocks, EXCLUDED.turnovers, EXCLUDED.personal_fouls, EXCLUDED.field_goals_made, EXCLUDED.field_goals_attempted, EXCLUDED.three_pointers_made, EXCLUDED.three_pointers_attempted, EXCLUDED.free_throws_made, EXCLUDED.free_throws_attempted, EXCLUDED.plus_minus, EXCLUDED.double_double, EXCLUDED.triple_double, EXCLUDED.did_not_play);
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  UPDATE public.nba_games SET stats_synced_at=NULL WHERE id=p_game_id AND stats_synced_at IS NOT NULL;
  END IF;
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

CREATE OR REPLACE FUNCTION public.record_live_poll_attempts(
  p_holder uuid, p_checked_ids uuid[] DEFAULT ARRAY[]::uuid[], p_stats_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.lock_live_poll_holder(p_holder);
  INSERT INTO private.live_poll_game_state(game_id,checked_at,stats_attempted_at)
    SELECT game.id,
      CASE WHEN game.id=ANY(p_checked_ids) AND game.status<>'InProgress' THEN clock_timestamp() END,
      CASE WHEN game.id=ANY(p_stats_ids) AND game.status='Final' THEN clock_timestamp() END
    FROM public.nba_games game WHERE (game.id=ANY(p_checked_ids) AND game.status<>'InProgress') OR (game.id=ANY(p_stats_ids) AND game.status='Final')
    ORDER BY game.id
    ON CONFLICT(game_id) DO UPDATE SET
      checked_at=COALESCE(EXCLUDED.checked_at,live_poll_game_state.checked_at),
      stats_attempted_at=COALESCE(EXCLUDED.stats_attempted_at,live_poll_game_state.stats_attempted_at);
END;
$$;

DROP FUNCTION public.get_live_poll_work(timestamptz);
CREATE OR REPLACE FUNCTION public.get_live_poll_work(p_now timestamptz DEFAULT now())
RETURNS TABLE (
  id uuid, nba_game_id text, game_date date, season_year int, week_number int, status text,
  game_time timestamptz, started_at timestamptz, home_team text, away_team text,
  home_score int, away_score int, game_status_text text, stats_synced_at timestamptz,
  needs_scoreboard boolean, needs_stats boolean, live_cache jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.nba_games game
    WHERE game.game_date IN ((p_now AT TIME ZONE 'America/New_York')::date-1,(p_now AT TIME ZONE 'America/New_York')::date)
      AND game.nba_game_id LIKE '002%'
      AND (game.status='InProgress' OR game.status='Scheduled' AND (
        COALESCE(game.game_time,game.started_at)<=p_now+interval '2 minutes'
        OR COALESCE(game.game_time,game.started_at) IS NULL AND (
          (p_now AT TIME ZONE 'America/New_York')::time>=time '11:00'
          OR game.game_date<(p_now AT TIME ZONE 'America/New_York')::date))
        OR game.status='Final' AND (game.stats_synced_at IS NULL OR game.stats_synced_at<=p_now-interval '30 minutes'))) THEN RETURN; END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT game.*,
      game.status = 'InProgress' OR (
        game.status = 'Scheduled'
        AND (
          COALESCE(game.game_time,game.started_at) BETWEEN p_now-interval '45 minutes' AND p_now+interval '2 minutes'
          OR (
            (COALESCE(game.game_time,game.started_at) < p_now-interval '45 minutes'
              OR (COALESCE(game.game_time,game.started_at) IS NULL AND
                ((p_now AT TIME ZONE 'America/New_York')::time >= time '11:00' OR game.game_date < (p_now AT TIME ZONE 'America/New_York')::date)))
            AND (attempt.checked_at IS NULL OR attempt.checked_at <= p_now-interval '30 minutes')
          )
        )
      ) AS board_due,
      game.status = 'InProgress' OR (game.status = 'Final'
        AND (game.stats_synced_at IS NULL OR game.stats_synced_at <= p_now-interval '30 minutes')
        AND (attempt.stats_attempted_at IS NULL OR attempt.stats_attempted_at <= p_now-interval '30 minutes')) AS stats_due
    FROM public.nba_games game
    LEFT JOIN private.live_poll_game_state attempt ON attempt.game_id=game.id
    WHERE game.game_date IN ((p_now AT TIME ZONE 'America/New_York')::date-1,(p_now AT TIME ZONE 'America/New_York')::date)
      AND game.nba_game_id LIKE '002%'
      AND private.lineup_game_available(game.status,game.game_status_text)
  )
  SELECT game.id,game.nba_game_id,game.game_date,game.season_year,game.week_number,game.status,
    game.game_time,game.started_at,game.home_team,game.away_team,game.home_score,game.away_score,
    game.game_status_text,game.stats_synced_at,game.board_due,game.stats_due,
    jsonb_build_object('snapshot',feed.stats_snapshot,'players',coalesce((
      SELECT jsonb_agg(jsonb_build_object('provider_id',player.nba_id,'player_id',player.id,'nba_team',member.nba_team) ORDER BY player.id)
      FROM private.player_game_memberships member JOIN public.players player ON player.id=member.player_id
      WHERE member.game_id=game.id AND player.nba_id IS NOT NULL AND member.nba_team IS NOT NULL
    ),'[]'::jsonb))
  FROM candidates game
  LEFT JOIN private.live_feed_state feed ON feed.game_id=game.id
  WHERE game.board_due OR game.stats_due
  ORDER BY game.game_date,game.id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_live_cache_invalidate() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_live_poll_work(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_live_poll_work(timestamptz) TO service_role;
CREATE TRIGGER live_identity_cache_invalidate AFTER INSERT OR UPDATE OF nba_game_id,season_year,game_date,home_team,away_team,status,home_score,away_score,game_status_text,live_stats_elapsed_seconds,live_scoreboard_elapsed_seconds
  ON public.nba_games FOR EACH ROW EXECUTE FUNCTION public.save_live_cache_invalidate();
CREATE TRIGGER live_stats_cache_insert AFTER INSERT ON public.player_game_stats
  REFERENCING NEW TABLE AS changed_stats FOR EACH STATEMENT EXECUTE FUNCTION public.save_live_cache_invalidate();
CREATE TRIGGER live_stats_cache_update AFTER UPDATE ON public.player_game_stats
  REFERENCING OLD TABLE AS prior_stats NEW TABLE AS changed_stats FOR EACH STATEMENT EXECUTE FUNCTION public.save_live_cache_invalidate();
CREATE TRIGGER live_stats_cache_delete AFTER DELETE ON public.player_game_stats
  REFERENCING OLD TABLE AS changed_stats FOR EACH STATEMENT EXECUTE FUNCTION public.save_live_cache_invalidate();
COMMIT;
