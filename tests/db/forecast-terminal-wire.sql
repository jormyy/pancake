BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE terminal_context(payload jsonb);
INSERT INTO terminal_context VALUES(jsonb_build_object(
  'teams',jsonb_build_array(jsonb_build_object('memberId','home','currentPoints',100),jsonb_build_object('memberId','away','currentPoints',90)),
  'roster',jsonb_build_array(jsonb_build_object('member_id','home','player_id','player','nba_team','BOS','eligible_positions',jsonb_build_array('PG'),'is_on_ir',false,'is_on_taxi',false)),
  'games',jsonb_build_array(jsonb_build_object('id','game','status','Final','game_date','2026-11-01','home_team','BOS','away_team','NYK')),
  'history',jsonb_build_array(jsonb_build_object('player_id','player','scores',jsonb_build_array(10,20,30))),
  'projections','[]'::jsonb,'lineups','[]'::jsonb,'templates','[]'::jsonb,'seasonAverages','[]'::jsonb,'previous',NULL));
CREATE OR REPLACE FUNCTION public.get_prepared_matchup_forecast_context(p_matchup_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$ SELECT payload FROM pg_temp.terminal_context $$;
DO $$
DECLARE packed jsonb; state text;
BEGIN
  FOREACH state IN ARRAY ARRAY['Final','Cancelled','Postponed'] LOOP
    UPDATE terminal_context SET payload=jsonb_set(payload,'{games,0,status}',to_jsonb(state));
    packed:=public.get_compact_matchup_forecast_context(gen_random_uuid());
    PERFORM pg_temp.check_rules(packed->'roster'='[]'::jsonb AND packed->'history'='[]'::jsonb,'terminal context removes unused player inputs: '||state);
    PERFORM pg_temp.check_rules(packed->'teams'->0->1='100'::jsonb AND jsonb_array_length(packed->'games')=1,'terminal context retains score and schedule: '||state);
  END LOOP;
  UPDATE terminal_context SET payload=jsonb_set(payload,'{games,0,status}','"Scheduled"');
  packed:=public.get_compact_matchup_forecast_context(gen_random_uuid());
  PERFORM pg_temp.check_rules(jsonb_array_length(packed->'roster')=1 AND jsonb_array_length(packed->'history')=1,'a future game retains all player inputs');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
