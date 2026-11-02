BEGIN;
\ir rules-support.sql
DO $$
DECLARE tick timestamptz:=((now() AT TIME ZONE 'America/New_York')::date::text||' 09:00 America/New_York')::timestamptz;
  day date:=(tick AT TIME ZONE 'America/New_York')::date;
  deferred uuid:=gen_random_uuid(); prior uuid:=gen_random_uuid(); future uuid:=gen_random_uuid(); soon uuid:=gen_random_uuid();
  active uuid:=gen_random_uuid(); final uuid:=gen_random_uuid(); legacy uuid[]; compact uuid[];
BEGIN
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time,stats_synced_at)
  VALUES(deferred,'002checkpoint-candidate-1',9571,1,day,'ATL','BOS','Scheduled',tick-interval '2 hours',NULL),
    (prior,'002checkpoint-candidate-2',9571,1,day-1,'BKN','CHA','Scheduled',NULL,NULL),
    (future,'002checkpoint-candidate-3',9571,1,day,'CHI','CLE','Scheduled',tick+interval '2 hours',NULL),
    (soon,'002checkpoint-candidate-4',9571,1,day,'DAL','DEN','Scheduled',tick+interval '1 minute',NULL),
    (active,'002checkpoint-candidate-5',9571,1,day,'DET','GSW','InProgress',tick-interval '1 hour',NULL),
    (final,'002checkpoint-candidate-6',9571,1,day,'HOU','IND','Final',tick-interval '3 hours',tick-interval '31 minutes');
  INSERT INTO private.live_poll_game_state(game_id,checked_at,stats_attempted_at)
    VALUES(deferred,tick,NULL),(final,NULL,tick-interval '29 minutes');
  SELECT array_agg(id ORDER BY id) INTO legacy FROM public.get_live_poll_work(tick) WHERE nba_game_id LIKE '002checkpoint-candidate-%';
  SELECT array_agg(id ORDER BY id) INTO compact FROM public.get_live_checkpoint_work(tick) WHERE nba_game_id LIKE '002checkpoint-candidate-%';
  PERFORM pg_temp.check_rules(legacy=compact,'compact work preserves the existing scheduled retry and final correction rules');
  PERFORM pg_temp.check_rules(NOT deferred=ANY(compact),'recently checked delayed tipoff does not create repeated polling');
  PERFORM pg_temp.check_rules(prior=ANY(compact),'a previous-day unknown tipoff remains recoverable before eleven');
  PERFORM pg_temp.check_rules(NOT future=ANY(compact) AND soon=ANY(compact),'only imminent future games enter live work');
  PERFORM pg_temp.check_rules(active=ANY(compact) AND NOT final=ANY(compact),'active games run and recent final attempts retain backoff');
  DELETE FROM private.work_items WHERE kind='live-poll';
  EXECUTE replace(pg_get_functiondef('public.get_live_poll_work(timestamptz)'::regprocedure),E'BEGIN\n',
    E'BEGIN\n RAISE EXCEPTION ''Legacy cache payload must not load during dispatch'';\n');
  PERFORM private.enqueue_live_poll(tick);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='live-poll'),
    'the dispatcher uses compact eligibility without materializing cached player rows');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
