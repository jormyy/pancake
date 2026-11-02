BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='live-score-view';
\ir rules-support.sql
DO $$
DECLARE f record; player_a uuid:=gen_random_uuid(); player_b uuid:=gen_random_uuid(); bench uuid:=gen_random_uuid(); game uuid:=gen_random_uuid();
  past_game uuid:=gen_random_uuid(); own_match uuid:=gen_random_uuid(); other_match uuid:=gen_random_uuid(); result jsonb; basis jsonb; compact jsonb; restored jsonb;
  holder uuid; messages_before integer;
  day date:=(now() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(4,9568);
  UPDATE public.leagues SET scoring_settings='{"points":1}' WHERE id=f.league_id;
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9568,1,day-1,day+5);
  INSERT INTO public.players(id,first_name,last_name,nba_id,espn_id,nba_team,position)
    VALUES(player_a,'Live','Home','101','201','BOS','PG'),(player_b,'Live','Away','102','202','NYK','PG'),(bench,'Bench','Other','103','203','NYK','PG');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[3],player_a,'draft'),(f.league_id,f.season_id,f.member_ids[4],player_b,'draft'),(f.league_id,f.season_id,f.member_ids[1],bench,'draft');
  INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,game_date,slot_type)
    VALUES(f.league_id,f.season_id,f.member_ids[3],player_a,day,'PG'),(f.league_id,f.season_id,f.member_ids[4],player_b,day,'PG');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(game,'002live-score-view',9568,1,day,'BOS','NYK','InProgress');
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,minutes_played)
    VALUES(player_a,game,9568,1,10,10),(player_b,game,9568,1,7,10);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,home_points,away_points)
    VALUES(own_match,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2],0,0),
      (other_match,f.league_id,f.season_id,1,f.member_ids[3],f.member_ids[4],10,7);
  INSERT INTO public.matchup_forecasts(matchup_id,league_id,input_revision,forecast,valid_until)
    VALUES(other_match,f.league_id,1,jsonb_build_object('modelVersion','fixture','status','limited','lineupBasis','unused',
      'teams',jsonb_build_array(jsonb_build_object('memberId',f.member_ids[3],'currentPoints',10,'projectedFinal',20,'winProbability',0.6,'variance',3)),
      'tieProbability',0,'missingInputs',jsonb_build_array('Unused detail','Projection substituted: '||player_a::text||':'||game::text),
      'games',jsonb_build_array(jsonb_build_object('memberId',f.member_ids[3],'playerId',player_a,'gameId',game,'date',day,'projection',20),
        jsonb_build_object('memberId',f.member_ids[4],'playerId',player_b,'gameId',game,'date',day,'projection',30))),now()+interval '30 minutes');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  result:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('matchupId',other_match));
  PERFORM pg_temp.check_rules(result->'matchup'->>'id'=other_match::text,'other-team matchup selects requested match');
  PERFORM pg_temp.check_rules(result->'matchup'->>'myMemberId'=f.member_ids[3]::text,'other-team matchup displays its home member');
  PERFORM pg_temp.check_rules(result->'myLineup'->'starters' @> jsonb_build_array(jsonb_build_object('player',jsonb_build_object('playerId',player_a))), 'other-team lineup belongs to displayed member');
  SELECT value INTO basis FROM jsonb_array_elements(result->'liveBasis') WHERE value->>'id'=other_match::text;
  PERFORM pg_temp.check_rules((basis->>'ready')::boolean,'saved score basis agrees with stored official score');
  PERFORM pg_temp.check_rules(basis->'players' @> jsonb_build_array(jsonb_build_object('nbaId','101','espnId','201','savedPoints',10)), 'live basis includes both provider IDs and saved contribution');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'liveBasis') m, jsonb_array_elements(m->'players') p WHERE p->>'playerId'=bench::text),'other matchup bench is absent from live payload');
  compact:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('matchupId',other_match,'compact',true));
  SELECT jsonb_agg(jsonb_build_object('id',m->0,'homeMemberId',m->1,'awayMemberId',m->2,'homePoints',m->3,
    'awayPoints',m->4,'finalized',m->5,'ready',m->6,'players',(SELECT COALESCE(jsonb_agg(jsonb_build_object('playerId',p->0,
      'memberId',CASE WHEN p->>1='0' THEN m->1 ELSE m->2 END,'nbaId',p->2,'espnId',p->3,'team',p->4,'gameId',p->5,
      'savedPoints',p->6,'savedAt',p->7,'starter',p->8,'final',p->9)),'[]'::jsonb) FROM jsonb_array_elements(m->7) p)))
    INTO restored FROM jsonb_array_elements(compact->'liveBasis') m;
  PERFORM pg_temp.check_rules(restored=result->'liveBasis','compact basis preserves every scoring input');
  PERFORM pg_temp.check_rules(octet_length(compact::text)<octet_length(result::text),'compact view sends fewer bytes');
  PERFORM pg_temp.check_rules(compact->'context'->'league'->'scoring_settings'=result->'context'->'league'->'scoring_settings','compact view retains scoring settings');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM jsonb_array_elements(compact->'myLineup'->'starters') slot
    WHERE slot->1->>1=player_a::text AND slot->1->>2='Live Home'),'compact lineup retains the displayed player identity');
  PERFORM pg_temp.check_rules(compact->'liveStats'->player_a::text->>0='10','compact stat row retains its points');
  PERFORM pg_temp.check_rules(compact->'forecast'->'teams'->0->>'projectedFinal'='20','compact forecast keeps displayed projections');
  PERFORM pg_temp.check_rules(jsonb_array_length(compact->'forecast'->'games')=1
    AND jsonb_array_length(compact->'forecast'->'missingInputs')=1 AND NOT (compact->'forecast' ? 'lineupBasis'),
    'compact forecast keeps only the displayed substitution details');
  SELECT value INTO basis FROM jsonb_array_elements(public.view_home(f.league_id,f.member_ids[1])->'liveBasis') WHERE value->>'id'=own_match::text;
  PERFORM pg_temp.check_rules(basis->'players' @> jsonb_build_array(jsonb_build_object('playerId',bench,'starter',false)),'displayed bench still receives live lines');
  UPDATE public.player_game_stats SET points=12 WHERE player_id=player_a AND game_id=game;
  SELECT value INTO basis FROM jsonb_array_elements(public.view_home(f.league_id,f.member_ids[1])->'liveBasis') WHERE value->>'id'=other_match::text;
  PERFORM pg_temp.check_rules(NOT (basis->>'ready')::boolean,'unfinished score publication cannot double count new stats');
  UPDATE public.matchups SET home_points=12 WHERE id=other_match;
  UPDATE public.nba_games SET status='Final',stats_synced_at=now() WHERE id=game;
  SELECT value INTO basis FROM jsonb_array_elements(public.view_home(f.league_id,f.member_ids[1])->'liveBasis') WHERE value->>'id'=other_match::text;
  PERFORM pg_temp.check_rules((basis->>'ready')::boolean AND basis->'players' @> '[{"nbaId":"101","final":true}]','saved final ignores cached live lines');
  holder:=public.try_live_poll_lease(779001,600);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.headers',jsonb_build_object('x-pancake-live-holder',holder,'x-pancake-public-checkpoint','true')::text,true);
  PERFORM set_config('pancake.official_broadcast','false',true);
  SELECT count(*) INTO messages_before FROM realtime.messages;
  UPDATE public.player_game_stats SET points=13 WHERE player_id=player_a AND game_id=game;
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.check_rules((SELECT count(*) FROM realtime.messages)>messages_before,'checkpoint context never hides a final-stat correction');
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM set_config('pancake.official_broadcast','false',true);
  UPDATE public.matchups SET home_points=13 WHERE id=other_match;
  PERFORM pg_temp.check_rules(current_setting('pancake.official_broadcast',true)='true','score publication retains an unpublished final correction');
  PERFORM set_config('request.headers','{}',true);
  PERFORM set_config('request.jwt.claims','{}',true);
  PERFORM public.release_live_poll_lease(779001,holder);
  UPDATE public.player_game_stats SET points=12 WHERE player_id=player_a AND game_id=game;
  UPDATE public.matchups SET home_points=12 WHERE id=other_match;
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,stats_synced_at)
    VALUES(past_game,'002live-score-past',9568,1,day-1,'BOS','NYK','Final',now());
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,minutes_played)
    VALUES(player_a,past_game,9568,1,22,20);
  INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,game_date,slot_type)
    VALUES(f.league_id,f.season_id,f.member_ids[3],player_a,day-1,'PG');
  UPDATE public.matchups SET home_points=34 WHERE id=other_match;
  result:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('date',day-1,'matchupId',other_match));
  PERFORM pg_temp.check_rules(result->'liveBasis'='[]','past-day view uses only official stats');
  PERFORM pg_temp.check_rules((result->'liveStats'->(player_a::text)->>'points')::integer=22,'past-day stats come from the saved official game');
  result:=public.view_player(f.league_id,f.member_ids[1],jsonb_build_object('playerId',player_a,'seasonYear',9568));
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'gameLog') line WHERE line->>'nbaGameId'=past_game::text AND (line->>'points')::integer=22 AND NOT (line->>'live')::boolean),'past player game log comes from official stats');
  PERFORM pg_temp.reject_rules(format('SELECT public.view_home(%L,%L,%L)',f.league_id,f.member_ids[1],jsonb_build_object('matchupId',gen_random_uuid())), 'This matchup is not available.','unavailable matchup is rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.view_home(%L,%L)',f.league_id,f.member_ids[3]),'This screen is not available.','viewer identity remains authorized');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','private.live_score_basis(uuid,uuid,integer,date,uuid)','EXECUTE'),'private basis cannot bypass view authorization');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
