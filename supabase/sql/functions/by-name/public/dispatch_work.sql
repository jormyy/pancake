-- Canonical SQL source for public.dispatch_work.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.dispatch_work()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_count integer:=0;
  v_started timestamptz:=clock_timestamp(); v_level text; v_kinds text[]; v_waiver record; v_floor record; v_day date;
BEGIN
  IF (SELECT paused FROM private.worker_controls WHERE id) THEN RETURN 0; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('public.dispatch_work',0)) THEN RETURN 0; END IF;
  BEGIN
    PERFORM private.flush_player_stats_hints();
    PERFORM private.flush_league_inventory_hints(1000);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Hint publication will retry: %',SQLERRM;
  END;
  PERFORM private.release_stalled_live_poll();
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
      v_kinds:=ARRAY['process-waivers','process-trades','live-poll','refresh-live-matchups','roster-floor'];
    ELSE
      v_kinds:=ARRAY['live-poll','sync-scores','stats-sync','process-waivers','process-trades','edge-invocation-reconcile','refresh-live-matchups','roster-floor'];
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
    FOR v_floor IN
      SELECT policy.league_id, season.id AS season_id, weeks.week_end
        FROM private.league_roster_policies policy
        JOIN public.leagues league ON league.id = policy.league_id
          AND league.status IN ('active', 'playoffs')
        JOIN public.league_seasons season ON season.league_id = league.id AND season.is_current
        JOIN public.season_weeks weeks ON weeks.season_year = season.season_year
          AND weeks.week_end <= (now() AT TIME ZONE 'America/New_York')::date
       WHERE policy.weekly_roster_floor IS NOT NULL
         AND policy.floor_activated_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM public.matchups matchup
            WHERE matchup.league_id = league.id
              AND matchup.league_season_id = season.id
              AND matchup.week_number = weeks.week_number
         )
         AND (weeks.week_end + time '00:00') AT TIME ZONE COALESCE(league.timezone, 'America/Los_Angeles') <= now()
         AND NOT EXISTS (
           SELECT 1 FROM private.roster_floor_weeks week_row
            WHERE week_row.league_id = policy.league_id
              AND week_row.league_season_id = season.id
              AND week_row.week_number = weeks.week_number
              AND week_row.status IN ('completed', 'expired')
         )
         AND (
           weeks.week_end = (
             SELECT max(latest.week_end)
               FROM public.season_weeks latest
              WHERE latest.season_year = season.season_year
                AND latest.week_end <= (now() AT TIME ZONE 'America/New_York')::date
                AND EXISTS (
                  SELECT 1 FROM public.matchups matchup
                   WHERE matchup.league_id = league.id
                     AND matchup.league_season_id = season.id
                     AND matchup.week_number = latest.week_number
                )
           )
           OR EXISTS (
             SELECT 1 FROM private.roster_floor_weeks pending
              WHERE pending.league_id = policy.league_id
                AND pending.league_season_id = season.id
                AND pending.week_number = weeks.week_number
                AND pending.status = 'pending'
           )
         )
    LOOP
      PERFORM private.work_enqueue(
        'roster-floor',
        v_floor.league_id::text || ':' || v_floor.week_end::text || ':' || (extract(epoch FROM now()) / 900)::bigint::text,
        now(),
        jsonb_build_object('leagueId', v_floor.league_id, 'leagueSeasonId', v_floor.season_id,
          'weekEnd', v_floor.week_end, 'bucket', (extract(epoch FROM now()) / 900)::bigint),
        v_floor.league_id
      );
    END LOOP;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM private.work_items
    WHERE status IN ('pending','failed') AND due_at<=now()
      OR status='running' AND lease_until<=now()) THEN RETURN v_count; END IF;
  LOOP
    EXIT WHEN v_count>=32 OR clock_timestamp()-v_started>=interval '2 seconds';
    IF v_level='normal' THEN
      SELECT * INTO v_item FROM private.work_claim(1);
    ELSE
      PERFORM private.work_claim(0);
      WITH due AS (
        SELECT id FROM private.work_items WHERE status IN ('pending','failed') AND due_at<=now()
          AND kind=ANY(v_kinds)
          AND (SELECT count(*) FROM private.work_items WHERE status='running' AND lease_until>clock_timestamp())<4
        ORDER BY CASE WHEN kind='live-poll' THEN 0 ELSE 1 END,due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
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
