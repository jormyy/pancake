BEGIN;
\ir rules-support.sql
UPDATE private.screen_refresh_queue SET dirty=false,claimed_at='infinity';
DELETE FROM private.work_items;
CREATE TEMP TABLE idle_fixture(league_id uuid,season_id uuid,trade_id uuid,values jsonb,version bigint);
DO $$
DECLARE f record; trade uuid:=gen_random_uuid(); version bigint; values jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,2027);
  INSERT INTO public.trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id)
  VALUES(trade,f.league_id,f.season_id,f.member_ids[1],f.member_ids[2]);
  SELECT queued.version INTO version FROM private.screen_refresh_queue queued WHERE league_season_id=f.season_id;
  values:=jsonb_build_array(jsonb_build_object('tradeId',trade,'revaluation',jsonb_build_object('modelVersion','idle-fixture','expiresAt',now()-interval '1 hour','analysis',jsonb_build_object('teams','[]'::jsonb))));
  PERFORM private.refresh_standings(f.league_id,f.season_id,version);
  PERFORM private.refresh_matchup_totals(f.league_id,f.season_id,version);
  PERFORM private.refresh_player_averages(f.league_id,f.season_id,version);
  PERFORM private.refresh_trade_values(f.league_id,f.season_id,version,values);
  UPDATE private.screen_refresh_queue SET dirty=false,claimed_at=NULL,claim_token=NULL,claimed_version=NULL WHERE league_season_id=f.season_id;
  INSERT INTO idle_fixture VALUES(f.league_id,f.season_id,trade,values,version);
END;
$$;
UPDATE public.leagues SET name=name WHERE id=(SELECT league_id FROM idle_fixture);
CREATE TEMP TABLE idle_results(worker_calls integer,completed integer,version_changes bigint,cache_hash text);
CREATE FUNCTION pg_temp.idle_minutes() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE fixture idle_fixture%ROWTYPE; claim jsonb; calls integer:=0; completions integer:=0; version bigint; content text;
BEGIN
  SELECT * INTO fixture FROM idle_fixture;
  FOR minute IN 1..60 LOOP
    UPDATE private.screen_refresh_queue SET available_at=now()-interval '1 minute' WHERE league_season_id=fixture.season_id;
    PERFORM private.enqueue_screen_views(now()-make_interval(mins=>60-minute));
    SELECT value INTO claim FROM jsonb_array_elements(public.view_refresh_work()) WHERE value->>'seasonId'=fixture.season_id::text;
    IF claim IS NOT NULL THEN
      calls:=calls+1;
      IF public.view_refresh_work(fixture.league_id,NULL,claim||jsonb_build_object('operation','complete','tradeValues',fixture.values))='true'::jsonb THEN completions:=completions+1; END IF;
    END IF;
  END LOOP;
  SELECT queued.version INTO version FROM private.screen_refresh_queue queued WHERE league_season_id=fixture.season_id;
  SELECT md5(string_agg((to_jsonb(cached)-ARRAY['league_id','league_season_id','version','refreshed_at'])::text,',' ORDER BY player_id)) INTO content
  FROM public.player_season_averages cached WHERE league_season_id=fixture.season_id;
  INSERT INTO idle_results VALUES(calls,completions,version-fixture.version,content);
  RETURN calls;
END;
$$;
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) SELECT pg_temp.idle_minutes();
SELECT row_to_json(idle_results) FROM idle_results;
DO $$
BEGIN
  IF EXISTS(SELECT FROM idle_results WHERE worker_calls<>0 OR version_changes<>0) THEN
    RAISE EXCEPTION 'An unchanged league starts idle screen refresh work';
  END IF;
END;
$$;
ROLLBACK;
