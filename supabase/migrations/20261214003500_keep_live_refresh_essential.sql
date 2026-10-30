CREATE SEQUENCE private.live_matchup_refresh_revision;
CREATE TABLE private.live_matchup_refresh_queue(
  matchup_id uuid PRIMARY KEY REFERENCES public.matchups(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT nextval('private.live_matchup_refresh_revision')
);
ALTER SEQUENCE private.live_matchup_refresh_revision OWNED BY private.live_matchup_refresh_queue.revision;
CREATE INDEX live_matchup_refresh_due ON private.live_matchup_refresh_queue(revision,matchup_id);
ALTER TABLE private.live_matchup_refresh_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.live_matchup_refresh_queue FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE private.live_matchup_refresh_revision FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO private.work_kinds(kind,function_name) VALUES('refresh-live-matchups',NULL);

CREATE OR REPLACE FUNCTION private.queue_live_matchup_refresh()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.is_voided OR TG_OP='UPDATE' AND
    ROW(NEW.home_points,NEW.away_points,NEW.home_max_possible_points,NEW.away_max_possible_points)
      IS NOT DISTINCT FROM ROW(OLD.home_points,OLD.away_points,OLD.home_max_possible_points,OLD.away_max_possible_points) THEN
    RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM public.league_seasons season
    JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=NEW.week_number
    JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(NEW.end_week_number,NEW.week_number)
    WHERE season.id=NEW.league_season_id AND season.is_current
      AND (now() AT TIME ZONE 'America/New_York')::date BETWEEN first_week.week_start AND last_week.week_end
      AND EXISTS(SELECT 1 FROM public.nba_games game WHERE game.season_year=season.season_year
        AND game.game_date=(now() AT TIME ZONE 'America/New_York')::date
        AND game.status IN('InProgress','Final') AND public.is_regular_season_game_id(game.nba_game_id))) THEN
    INSERT INTO private.live_matchup_refresh_queue AS queued(matchup_id) VALUES(NEW.id)
      ON CONFLICT(matchup_id) DO UPDATE SET revision=EXCLUDED.revision;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.queue_live_matchup_refresh() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.refresh_live_matchup_totals()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE refreshed integer;
BEGIN
  WITH ready AS MATERIALIZED (
    SELECT matchup_id,revision FROM private.live_matchup_refresh_queue
    ORDER BY revision,matchup_id LIMIT 8 FOR UPDATE SKIP LOCKED
  ), written AS (
    INSERT INTO public.matchup_totals AS cached(matchup_id,league_id,league_season_id,
      home_points,away_points,home_max_possible_points,away_max_possible_points,version)
    SELECT matchup.id,matchup.league_id,matchup.league_season_id,matchup.home_points,matchup.away_points,
      matchup.home_max_possible_points,matchup.away_max_possible_points,COALESCE(screen.version,1)
    FROM ready JOIN public.matchups matchup ON matchup.id=ready.matchup_id
    JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
    JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=matchup.week_number
    JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
    LEFT JOIN private.screen_refresh_queue screen ON screen.league_season_id=season.id
    WHERE NOT matchup.is_voided AND (now() AT TIME ZONE 'America/New_York')::date BETWEEN first_week.week_start AND last_week.week_end
      AND EXISTS(SELECT 1 FROM public.nba_games game WHERE game.season_year=season.season_year
        AND game.game_date=(now() AT TIME ZONE 'America/New_York')::date
        AND game.status IN('InProgress','Final') AND public.is_regular_season_game_id(game.nba_game_id))
    ORDER BY matchup.id
    ON CONFLICT(matchup_id) DO UPDATE SET home_points=EXCLUDED.home_points,away_points=EXCLUDED.away_points,
      home_max_possible_points=EXCLUDED.home_max_possible_points,away_max_possible_points=EXCLUDED.away_max_possible_points,
      version=GREATEST(cached.version,EXCLUDED.version),refreshed_at=now()
    WHERE ROW(cached.home_points,cached.away_points,cached.home_max_possible_points,cached.away_max_possible_points)
      IS DISTINCT FROM ROW(EXCLUDED.home_points,EXCLUDED.away_points,EXCLUDED.home_max_possible_points,EXCLUDED.away_max_possible_points)
    RETURNING matchup_id
  ) DELETE FROM private.live_matchup_refresh_queue queued USING ready
    WHERE queued.matchup_id=ready.matchup_id AND queued.revision=ready.revision;
  GET DIAGNOSTICS refreshed=ROW_COUNT;
  RETURN refreshed;
END;
$$;

REVOKE ALL ON FUNCTION private.refresh_live_matchup_totals() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.dispatch_live_matchup_refresh()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE revision bigint; item private.work_items%ROWTYPE;
BEGIN
  SELECT queued.revision INTO revision FROM private.live_matchup_refresh_queue queued ORDER BY queued.revision LIMIT 1;
  IF NOT FOUND THEN RETURN 0; END IF;
  PERFORM private.work_enqueue('refresh-live-matchups',revision::text,now());
  WITH due AS (
    SELECT id FROM private.work_items WHERE kind='refresh-live-matchups' AND status IN('pending','failed') AND due_at<=now()
    ORDER BY due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
  ) UPDATE private.work_items stored SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+interval '5 minutes',invocation_key=NULL
    FROM due WHERE stored.id=due.id RETURNING stored.* INTO item;
  IF NOT FOUND THEN RETURN 0; END IF;
  BEGIN
    PERFORM private.work_execute(item.id,item.lease_token);
  EXCEPTION WHEN OTHERS THEN
    PERFORM private.work_finish(item.id,item.lease_token,SQLERRM);
  END;
  RETURN 1;
END;
$$;

REVOKE ALL ON FUNCTION private.dispatch_live_matchup_refresh() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.work_execute(p_id bigint,p_token uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_function text; v_payload jsonb; v_tipoff timestamptz;
  v_previous text:=coalesce(current_setting('pancake.work_id',true),'');
BEGIN
  SELECT * INTO v_item FROM private.work_items WHERE id=p_id AND lease_token=p_token AND status='running' AND lease_until>now();
  IF NOT FOUND THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM private.work_kinds WHERE kind=v_item.kind AND retired_at IS NOT NULL) THEN
    UPDATE private.work_items SET status='dead',completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,
      invocation_key=NULL,last_error='Work kind is retired' WHERE id=p_id AND lease_token=p_token;
    RETURN;
  END IF;
  SELECT function_name INTO v_function FROM private.work_kinds WHERE kind=v_item.kind;
  v_payload:=v_item.payload;
  IF v_item.kind='league-inventory-hint-drain' AND (v_payload->>'delay')::int=0 THEN v_function:=NULL; END IF;
  IF v_item.kind='pre-tipoff' THEN
    v_tipoff:=(v_payload->>'tipoffAt')::timestamptz;
    IF v_tipoff<=now()-interval '1 minute' THEN RAISE EXCEPTION 'Tipoff window has closed'; END IF;
    INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date) VALUES(v_tipoff,(v_tipoff AT TIME ZONE 'America/New_York')::date) ON CONFLICT DO NOTHING;
    UPDATE public.lineup_tipoff_dispatches SET status='queued',token=p_token,attempts=attempts+1,
      lease_until=v_item.lease_until,error=NULL,input_revision=input_revision+(input_fingerprint IS DISTINCT FROM v_payload->>'fingerprint')::int,
      input_fingerprint=v_payload->>'fingerprint' WHERE tipoff_at=v_tipoff;
    v_payload:=(v_payload-'fingerprint')||jsonb_build_object('token',p_token);
  END IF;
  IF v_function IS NOT NULL THEN
    PERFORM set_config('pancake.work_id',p_id::text,true);
    PERFORM public.invoke_edge_function(v_function,v_payload);
    PERFORM set_config('pancake.work_id',v_previous,true);
    RETURN;
  END IF;
  CASE v_item.kind
    WHEN 'refresh-live-matchups' THEN PERFORM private.refresh_live_matchup_totals();
    WHEN 'trade-publication' THEN PERFORM private.publish_trade_changes((v_payload->>'publicationId')::uuid);
    WHEN 'setup-season-rollover' THEN PERFORM private.roll_setup_league_seasons(now());
    WHEN 'daily-stat-corrections' THEN PERFORM public.queue_daily_stat_corrections();
    WHEN 'missing-final-stats' THEN PERFORM private.reconcile_missing_final_stats(now(),(v_payload->>'beforeDate')::date);
    WHEN 'edge-invocation-reconcile' THEN PERFORM private.reconcile_edge_invocations();
    WHEN 'player-stats-hints' THEN PERFORM private.flush_player_stats_hints();
    WHEN 'league-inventory-hint-drain' THEN PERFORM private.flush_league_inventory_hints(1000);
    WHEN 'cleanup-trade-estimates' THEN PERFORM public.cleanup_trade_estimate_quotes();
    WHEN 'mock-room-expiry' THEN PERFORM public.expire_mock_draft_rooms();
    WHEN 'public-read-retention' THEN PERFORM public.public_prune_read_log();
    WHEN 'retention-prune' THEN PERFORM private.run_retention();
    ELSE RAISE EXCEPTION 'Unknown SQL work kind: %',v_item.kind;
  END CASE;
  PERFORM private.work_finish(p_id,p_token);
END;
$$;

CREATE OR REPLACE FUNCTION public.dispatch_work()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_count integer:=0;
  v_started timestamptz:=clock_timestamp(); v_level text; v_kinds text[]; v_waiver record; v_day date;
BEGIN
  IF (SELECT paused FROM private.worker_controls WHERE id) THEN RETURN 0; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('public.dispatch_work',0)) THEN RETURN 0; END IF;
  v_count:=private.dispatch_live_matchup_refresh();
  v_level:=private.apply_scheduler_health(private.scheduler_health());
  IF clock_timestamp()-v_started>=interval '2 seconds' THEN RETURN v_count; END IF;
  IF v_level='normal' THEN
    PERFORM private.enqueue_scheduled_work(now());
  ELSE
    IF v_level='paused' THEN
      UPDATE private.worker_controls SET scheduler_last_dispatch_at=clock_timestamp()
      WHERE id AND (scheduler_last_dispatch_at IS NULL OR scheduler_last_dispatch_at<=clock_timestamp()-interval '5 minutes');
      IF NOT FOUND THEN RETURN v_count; END IF;
      v_kinds:=ARRAY['process-waivers','process-trades','live-poll'];
    ELSE
      v_kinds:=ARRAY['live-poll','sync-scores','stats-sync','process-waivers','process-trades','edge-invocation-reconcile'];
      PERFORM private.enqueue_stats_sync_dispatch(now());
      IF extract(minute FROM now())::int%5=0 AND EXISTS(SELECT 1 FROM public.edge_invocations
        WHERE reconciled_at IS NULL OR worker_status='running') THEN
        PERFORM private.work_enqueue('edge-invocation-reconcile',date_trunc('minute',now())::text,now());
      END IF;
    END IF;
    PERFORM private.enqueue_process_trades(now());
    IF v_level='paused' OR extract(minute FROM now())::int%2=0 THEN PERFORM private.enqueue_live_poll(now()); END IF;
    IF v_level='paused' OR extract(minute FROM now())::int%15=0 THEN
      FOR v_waiver IN SELECT DISTINCT coalesce(timezone,'America/Los_Angeles') AS timezone
        FROM public.leagues WHERE status IN ('active','playoffs','offseason') LOOP
        v_day:=(now() AT TIME ZONE v_waiver.timezone)::date;
        PERFORM private.work_enqueue('process-waivers',v_waiver.timezone||':'||v_day::text,
          v_day::timestamp AT TIME ZONE v_waiver.timezone,jsonb_build_object('timezone',v_waiver.timezone,'date',v_day));
      END LOOP;
    END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM private.work_items
    WHERE status IN ('pending','failed') AND due_at<=now()
      OR status='running' AND lease_until<=now()) THEN RETURN v_count; END IF;
  LOOP
    EXIT WHEN v_count>=4 OR clock_timestamp()-v_started>=interval '2 seconds';
    IF v_level='normal' THEN
      SELECT * INTO v_item FROM private.work_claim(1);
    ELSE
      PERFORM private.work_claim(0);
      WITH due AS (
        SELECT id FROM private.work_items WHERE status IN ('pending','failed') AND due_at<=now()
          AND kind=ANY(v_kinds)
          AND (SELECT count(*) FROM private.work_items WHERE status='running' AND lease_until>clock_timestamp())<4
        ORDER BY due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE private.work_items item SET status='running',attempts=attempts+1,
        lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes',invocation_key=NULL
      FROM due WHERE item.id=due.id RETURNING item.* INTO v_item;
    END IF;
    EXIT WHEN NOT FOUND;
    BEGIN
      PERFORM private.work_execute(v_item.id,v_item.lease_token);
    EXCEPTION WHEN OTHERS THEN
      PERFORM private.work_finish(v_item.id,v_item.lease_token,SQLERRM);
    END;
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE TRIGGER queue_live_matchup_refresh AFTER INSERT OR UPDATE OF home_points,away_points,home_max_possible_points,away_max_possible_points ON public.matchups FOR EACH ROW EXECUTE FUNCTION private.queue_live_matchup_refresh();

INSERT INTO private.live_matchup_refresh_queue(matchup_id)
SELECT matchup.id FROM public.matchups matchup
JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=matchup.week_number
JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
WHERE NOT matchup.is_voided AND (now() AT TIME ZONE 'America/New_York')::date BETWEEN first_week.week_start AND last_week.week_end
  AND EXISTS(SELECT 1 FROM public.nba_games game WHERE game.season_year=season.season_year
    AND game.game_date=(now() AT TIME ZONE 'America/New_York')::date
    AND game.status IN('InProgress','Final') AND public.is_regular_season_game_id(game.nba_game_id))
ON CONFLICT DO NOTHING;
