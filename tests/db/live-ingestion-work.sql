BEGIN;
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE live_checks(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.check_live(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  INSERT INTO live_checks VALUES(label);
END;
$$;
SELECT set_config('app.supabase_url','http://127.0.0.1:1',true);
SELECT set_config('app.edge_internal_token','local-database-ci-token',true);
DO $$
DECLARE
  game uuid:=gen_random_uuid(); player uuid:=gen_random_uuid(); ref timestamptz;
  holder uuid; replacement uuid; before_count bigint; saved_updated timestamptz; saved_revision bigint;
BEGIN
  FOREACH ref IN ARRAY ARRAY['2026-01-15 01:30 America/New_York'::timestamptz,'2026-07-15 01:30 America/New_York'::timestamptz] LOOP
    INSERT INTO nba_games(id,nba_game_id,game_date,season_year,week_number,home_team,away_team,status,game_time)
    VALUES(game,'0029910777',(ref AT TIME ZONE 'America/New_York')::date,9001,1,'BOS','MIA','Scheduled',ref+interval '6 hours');
    PERFORM pg_temp.check_live(NOT EXISTS(SELECT 1 FROM get_live_poll_work(ref) WHERE id=game),'future slate idle '||ref);
    UPDATE nba_games SET game_time=ref+interval '2 minutes' WHERE id=game;
    PERFORM pg_temp.check_live(EXISTS(SELECT 1 FROM get_live_poll_work(ref) WHERE id=game AND needs_scoreboard AND NOT needs_stats),'tipoff horizon inclusive '||ref);
    UPDATE nba_games SET game_time=ref+interval '2 minutes 0.001 seconds' WHERE id=game;
    PERFORM pg_temp.check_live(NOT EXISTS(SELECT 1 FROM get_live_poll_work(ref) WHERE id=game),'tipoff outside horizon '||ref);
    UPDATE nba_games SET status='InProgress',game_date=(ref AT TIME ZONE 'America/New_York')::date-1,game_time=ref-interval '3 hours' WHERE id=game;
    PERFORM pg_temp.check_live(EXISTS(SELECT 1 FROM get_live_poll_work(ref) WHERE id=game AND needs_scoreboard AND needs_stats),'late previous-day game live '||ref);
    UPDATE nba_games SET status='Scheduled',game_status_text='PPD - postponed to a later date' WHERE id=game;
    PERFORM pg_temp.check_live(NOT EXISTS(SELECT 1 FROM get_live_poll_work(ref) WHERE id=game),'postponed does not poll '||ref);
    UPDATE nba_games SET game_status_text='',game_time=ref-interval '1 hour' WHERE id=game;
    INSERT INTO private.live_poll_game_state(game_id,checked_at) VALUES(game,ref);
    PERFORM pg_temp.check_live(NOT EXISTS(SELECT 1 FROM get_live_poll_work(ref) WHERE id=game),'stale scheduled backoff '||ref);
    UPDATE private.live_poll_game_state SET checked_at=ref-interval '30 minutes' WHERE game_id=game;
    PERFORM pg_temp.check_live(EXISTS(SELECT 1 FROM get_live_poll_work(ref) WHERE id=game AND needs_scoreboard),'stale scheduled recovers '||ref);
    UPDATE nba_games SET status='Final',updated_at=ref WHERE id=game;
    PERFORM pg_temp.check_live(EXISTS(SELECT 1 FROM get_live_poll_work(ref) WHERE id=game AND needs_stats AND NOT needs_scoreboard),'first final uses marker not updated timestamp '||ref);
    UPDATE private.live_poll_game_state SET stats_attempted_at=ref-interval '29 minutes 59.999 seconds' WHERE game_id=game;
    PERFORM pg_temp.check_live(NOT EXISTS(SELECT 1 FROM get_live_poll_work(ref) WHERE id=game),'final backoff strict boundary '||ref);
    UPDATE private.live_poll_game_state SET stats_attempted_at=ref-interval '30 minutes' WHERE game_id=game;
    PERFORM pg_temp.check_live(EXISTS(SELECT 1 FROM get_live_poll_work(ref) WHERE id=game AND needs_stats),'final retry inclusive boundary '||ref);
    UPDATE nba_games SET stats_synced_at=ref WHERE id=game;
    PERFORM pg_temp.check_live(NOT EXISTS(SELECT 1 FROM get_live_poll_work(ref) WHERE id=game),'completed final idle '||ref);
    DELETE FROM nba_games WHERE id=game;
  END LOOP;
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(9001,1,(now() AT TIME ZONE 'America/New_York')::date,(now() AT TIME ZONE 'America/New_York')::date);
  INSERT INTO nba_games(id,nba_game_id,game_date,season_year,week_number,home_team,away_team,status,stats_synced_at)
  VALUES(game,'0029910777',(now() AT TIME ZONE 'America/New_York')::date,9001,1,'BOS','MIA','Final',NULL);
  INSERT INTO players(id,first_name,last_name,position,eligible_positions) VALUES(player,'Live','Partial','PG',ARRAY['PG']);
  INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,game_date,points)
    VALUES(player,game,9001,1,(now() AT TIME ZONE 'America/New_York')::date,1);
  PERFORM pg_temp.check_live(EXISTS(SELECT 1 FROM get_live_poll_work() WHERE id=game AND needs_stats),'partial stat row does not certify final');
  SELECT count(*) INTO before_count FROM edge_invocations WHERE function_name='live-poll';
  holder:=try_live_poll_lease(779001,90);
  PERFORM pg_temp.check_live(holder IS NOT NULL,'lease admitted');
  PERFORM invoke_live_poll_if_due();
  PERFORM pg_temp.check_live((SELECT count(*)=before_count FROM edge_invocations WHERE function_name='live-poll'),'held lease suppresses dispatch');
  SELECT updated_at INTO saved_updated FROM nba_games WHERE id=game;
  SELECT revision INTO saved_revision FROM private.score_input_revisions WHERE scope='nba:9001:1';
  PERFORM record_live_poll_attempts(holder,ARRAY[game],ARRAY[game]);
  PERFORM pg_temp.check_live((SELECT revision=saved_revision FROM private.score_input_revisions WHERE scope='nba:9001:1'),'attempts do not invalidate score inputs');
  PERFORM pg_temp.check_live((SELECT attempt.checked_at IS NOT NULL AND attempt.stats_attempted_at IS NOT NULL AND nba.updated_at=saved_updated AND nba.stats_synced_at IS NULL FROM nba_games nba JOIN private.live_poll_game_state attempt ON attempt.game_id=nba.id WHERE nba.id=game),'attempts preserve game content and completion');
  PERFORM pg_temp.check_live(NOT EXISTS(SELECT 1 FROM get_live_poll_work() WHERE id=game),'worker stamp and gate share backoff');
  PERFORM pg_temp.check_live(NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE schemaname='private' AND tablename='live_poll_game_state'),'retry bookkeeping never emits client events');
  PERFORM set_config('request.headers',jsonb_build_object('x-pancake-live-holder',holder)::text,true);
  UPDATE player_game_stats SET points=2 WHERE game_id=game;
  PERFORM pg_temp.check_live((SELECT points=2 FROM player_game_stats WHERE game_id=game),'current holder writes stats');
  UPDATE live_poll_leases SET expires_at=now()-interval '1 second' WHERE lock_key=779001;
  replacement:=try_live_poll_lease(779001,90);
  PERFORM pg_temp.check_live(replacement IS NOT NULL AND replacement<>holder,'stale holder replaced');
  BEGIN
    UPDATE player_game_stats SET points=999 WHERE game_id=game;
    RAISE EXCEPTION 'old holder writes stats';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  BEGIN
    UPDATE nba_games SET home_score=999 WHERE id=game;
    RAISE EXCEPTION 'old holder writes games';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  BEGIN
    UPDATE matchups SET home_points=home_points WHERE false;
    RAISE EXCEPTION 'old holder reaches matchup writes';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  BEGIN
    UPDATE standings SET wins=wins WHERE false;
    RAISE EXCEPTION 'old holder reaches standings writes';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  PERFORM pg_temp.check_live((SELECT points=2 FROM player_game_stats WHERE game_id=game),'lost holder cannot partially overwrite');
  PERFORM set_config('request.headers',jsonb_build_object('x-pancake-live-holder',replacement)::text,true);
  UPDATE player_game_stats SET points=3 WHERE game_id=game;
  PERFORM pg_temp.check_live((SELECT points=3 FROM player_game_stats WHERE game_id=game),'replacement writes');
  PERFORM set_config('request.headers','{}',true);
  PERFORM release_live_poll_lease(779001,replacement);
END;
$$;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I',role_name);
    BEGIN
      PERFORM 1 FROM private.live_poll_game_state;
      RAISE EXCEPTION 'client reads private retry state';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM get_live_poll_work();
      RAISE EXCEPTION 'client reads internal ingestion work';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM record_live_poll_attempts(gen_random_uuid());
      RAISE EXCEPTION 'client alters retry timestamps';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
  END LOOP;
END;
$$;
SET LOCAL ROLE service_role;
SELECT count(*) FROM get_live_poll_work();
DO $$
BEGIN
  BEGIN
    PERFORM record_live_poll_attempts(gen_random_uuid());
    RAISE EXCEPTION 'service may stamp without its lease';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
END;
$$;
RESET ROLE;
SELECT count(*) AS passed FROM live_checks;
ROLLBACK;
