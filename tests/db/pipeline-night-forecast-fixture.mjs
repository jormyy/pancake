import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
assert.equal(process.env.DOCKER_CONTEXT,'desktop-linux')
const url='postgresql://supabase_admin:postgres@127.0.0.1:64822/postgres'
const sql=input=>execFileSync('psql',[url,'-XqAtv','ON_ERROR_STOP=1'],{input,encoding:'utf8'})
sql(`SET pg_stat_statements.track='none'; SET app.supabase_url='http://127.0.0.1:64821'; SET app.edge_internal_token='private-pipeline-night';
  UPDATE public.nba_games SET status='Final',stats_synced_at=now() WHERE game_date=(now() AT TIME ZONE 'America/New_York')::date-1;
  DELETE FROM private.work_items; DELETE FROM public.edge_invocations; DELETE FROM public.notification_outbox;
  UPDATE public.trades SET expires_at=now()+interval '1 day' WHERE status='pending';
  UPDATE public.trades SET veto_window_expires_at=now()+interval '1 day' WHERE status='accepted';
  UPDATE private.worker_controls SET paused=false,scheduler_level='normal',scheduler_checked_at=NULL,scheduler_healthy_since=NULL WHERE id;
  UPDATE private.screen_refresh_queue SET dirty=false; UPDATE private.matchup_forecast_queue SET dirty=false;
  UPDATE private.forecast_refresh_requests SET available_at=now()+interval '1 day';
  UPDATE private.matchup_forecast_expiries SET available_at=now()+interval '1 day';
  UPDATE private.notification_scan_state SET available_at=now()+interval '1 day',scan_at=NULL; DELETE FROM private.notification_scan_dirty;
  DELETE FROM private.live_matchup_refresh_queue;
  SELECT private.enqueue_scheduled_work(now()); UPDATE private.work_items SET status='succeeded',completed_at=now();`)
if(process.argv[2]!=='settled')sql(`DO $$ DECLARE target uuid; actor uuid; league uuid; BEGIN
  SELECT q.matchup_id,m.league_id INTO target,league FROM private.matchup_forecast_queue q JOIN public.matchups m ON m.id=q.matchup_id WHERE m.week_number=2 ORDER BY q.matchup_id LIMIT 1;
  SELECT r.player_id INTO actor FROM public.roster_players r JOIN public.matchups m ON m.league_season_id=r.league_season_id
    AND r.member_id IN(m.home_member_id,m.away_member_id) WHERE m.id=target ORDER BY r.player_id LIMIT 1;
  UPDATE public.players SET injury_status=CASE WHEN injury_status='Out' THEN 'Day-To-Day' ELSE 'Out' END WHERE id=actor;
  PERFORM private.queue_matchup_forecasts(league); PERFORM private.refresh_matchup_forecast_input(target);
  IF ${process.argv[2]==='priority'?'true':'false'} THEN
    INSERT INTO private.work_items(kind,key,status,attempts,lease_token,lease_until,payload)
      SELECT 'stats-sync','priority-holder-'||n,'running',1,gen_random_uuid(),clock_timestamp()+interval '5 minutes',jsonb_build_object('holder',n) FROM generate_series(1,2) n;
    PERFORM private.work_enqueue('forecast-inputs','priority-input',now()-interval '6 hours','{"schedulerChunk":"forecasts"}');
    PERFORM private.work_enqueue('matchup-forecasts','priority-empty',now());
  ELSE
    INSERT INTO private.work_items(kind,key,status,attempts,lease_token,lease_until,payload)
      VALUES('forecast-inputs','forecast-held','running',1,gen_random_uuid(),clock_timestamp()+interval '2 hours','{"schedulerChunk":"forecasts"}');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty AND private.matchup_forecast_refresh_pending(matchup_id)) THEN RAISE EXCEPTION 'No blocked forecast'; END IF;
END; $$;`)
if(process.argv[2]==='priority')sql("DELETE FROM public.notification_outbox; UPDATE private.screen_refresh_queue SET dirty=false;")
process.stdout.write(`Prepared ${process.argv[2]??'blocked'} forecast fixture.\n`)
