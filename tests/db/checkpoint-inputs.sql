BEGIN;
\ir rules-support.sql
DO $$
DECLARE tick timestamptz:=((now() AT TIME ZONE 'America/New_York')::date::text||' 09:00 America/New_York')::timestamptz;
  day date:=(tick AT TIME ZONE 'America/New_York')::date;
  active uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); final uuid:=gen_random_uuid(); future uuid:=gen_random_uuid();
  expected jsonb; actual jsonb;
BEGIN
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time,stats_synced_at)
  VALUES(active,'002checkpoint-input-1',9572,1,day,'ATL','BOS','InProgress',tick-interval '1 hour',NULL),
    (other,'002checkpoint-input-2',9572,1,day,'BKN','CHA','InProgress',tick-interval '1 hour',NULL),
    (final,'002checkpoint-input-3',9572,1,day,'CHI','CLE','Final',tick-interval '3 hours',tick-interval '31 minutes'),
    (future,'002checkpoint-input-4',9572,1,day,'DAL','DEN','Scheduled',tick+interval '2 hours',NULL);
  INSERT INTO private.live_poll_game_state(game_id,stats_attempted_at) VALUES(final,tick-interval '29 minutes');
  SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id) INTO expected FROM public.get_live_poll_work(tick) row WHERE row.id=active;
  SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id) INTO actual FROM public.get_live_checkpoint_inputs(ARRAY[active],tick) row;
  PERFORM pg_temp.check_rules(actual=expected,'selected checkpoint inputs exactly match the existing save inputs');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.get_live_checkpoint_inputs(ARRAY[active,active],tick)),
    'repeated selected IDs do not duplicate input rows');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.get_live_checkpoint_inputs(ARRAY[final,future],tick)),
    'selection preserves final retry backoff and scheduled-game eligibility');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.get_live_checkpoint_inputs(ARRAY[]::uuid[],tick)),
    'empty selection never reads all games');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.get_live_checkpoint_inputs(NULL,tick)),
    'null selection never reads all games');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.get_live_checkpoint_inputs(ARRAY[gen_random_uuid()],tick)),
    'unknown selected IDs do not widen the read');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.get_live_poll_work(tick) WHERE id=other),
    'the off-switch reader keeps unselected eligible games');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('anon','public.get_live_checkpoint_inputs(uuid[],timestamptz)','EXECUTE')
    AND NOT has_function_privilege('authenticated','public.get_live_checkpoint_inputs(uuid[],timestamptz)','EXECUTE'),
    'anonymous and authenticated clients cannot call checkpoint inputs');
  PERFORM pg_temp.check_rules(has_function_privilege('service_role','public.get_live_checkpoint_inputs(uuid[],timestamptz)','EXECUTE'),
    'the worker role can read checkpoint inputs');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
