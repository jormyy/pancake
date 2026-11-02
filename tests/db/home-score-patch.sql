BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='score-patch';
\ir rules-support.sql
DO $$
DECLARE f record; matchup uuid:=gen_random_uuid(); full_view jsonb; patch jsonb; key text;
  day date:=(now() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9527);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9527,1,day,day+6);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(matchup,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]);
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  full_view:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('matchupId',matchup,'date',day,'compact',true));
  patch:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('matchupId',matchup,'date',day,'compact',true,'section','scores'));
  PERFORM pg_temp.check_rules(patch->>'section'='scores','score updates return a bounded section');
  FOREACH key IN ARRAY ARRAY['matchup','selectedDate','weekDays','leagueMatchups','todaysGames','liveStats','startedTeams','teamMatchups','liveBasis'] LOOP
    PERFORM pg_temp.check_rules(patch->key IS NOT DISTINCT FROM full_view->key,'score patch preserves '||key);
  END LOOP;
  PERFORM pg_temp.check_rules(NOT patch ? 'myLineup' AND NOT patch ? 'oppLineup' AND NOT patch ? 'forecast','score patch omits unchanged roster and forecast payloads');
  PERFORM pg_temp.check_rules(patch->'forecastStale' IS NOT DISTINCT FROM COALESCE(full_view->'forecast'->'stale','null'::jsonb),'score patch preserves forecast freshness state');
  INSERT INTO public.matchup_forecasts(matchup_id,league_id,input_revision,forecast,valid_until)
    VALUES(matchup,f.league_id,1,'{"modelVersion":"test","teams":[{},{}],"games":[],"missingInputs":[]}',now()+interval '1 hour');
  full_view:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('matchupId',matchup,'date',day,'compact',true));
  patch:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('matchupId',matchup,'date',day,'compact',true,'section','scores'));
  PERFORM pg_temp.check_rules(patch->'forecastStale'=full_view->'forecast'->'stale','score patch carries an existing forecast freshness state');
  PERFORM set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  PERFORM pg_temp.reject_rules(format('SELECT public.view_home(%L,%L,%L)',f.league_id,f.member_ids[1],jsonb_build_object('matchupId',matchup,'section','scores')),'%This screen is not available.%','score section keeps membership checks');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
