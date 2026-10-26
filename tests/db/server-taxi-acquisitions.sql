BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; players uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()]; claim uuid; result record;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,public.current_season_year_et());
  UPDATE leagues SET roster_size=1,taxi_slots=2,ir_slots=1 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games,nba_team)
    SELECT id,'Taxi',ordinal::text,'PG',ARRAY['PG'],1,64,'FTX' FROM unnest(players) WITH ORDINALITY p(id,ordinal);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],players[1],'draft');
  INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
    VALUES('002ftaxi',public.current_season_year_et(),1,(now() AT TIME ZONE 'America/New_York')::date,'FTX','FTY','InProgress',now()-interval '1 hour');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  claim:=public.create_waiver_claim_atomic(p_member_id=>f.member_ids[1],p_league_id=>f.league_id,p_player_id=>players[2],p_drop_player_id=>NULL,p_user_id=>f.user_ids[1],p_to_ir=>false,p_to_taxi=>true);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE player_id=players[2] AND league_id=f.league_id),'taxi claim waits for its award');
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id=claim;
  PERFORM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date);
  PERFORM pg_temp.check_rules((SELECT is_on_taxi AND NOT is_on_ir FROM roster_players WHERE player_id=players[2] AND league_id=f.league_id),'post-tipoff award enters taxi while active roster is full');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM league_activity WHERE league_id=f.league_id AND related_player_id=players[2] AND body ILIKE '%taxi%'),'award activity names taxi');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.get_league_activity_feed(f.league_id,50,0) WHERE player_id=players[2] AND body ILIKE '%taxi%'),'visible award activity names taxi');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM roster_transactions WHERE league_id=f.league_id AND player_id=players[2] AND acquired_to_taxi),'award history records taxi tenure');
  PERFORM pg_temp.reject_rules(format('SELECT public.add_free_agent_atomic(%L,%L,%L,true,true)',f.member_ids[1],f.league_id,players[3]),'Choose IR or taxi, not both.','both add destinations rejected');
  INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at,clears_at)
    VALUES(f.league_id,f.season_id,players[3],now()-interval '4 days',now()-interval '1 hour');
  claim:=public.create_waiver_claim_atomic(p_league_id=>f.league_id,p_member_id=>f.member_ids[1],p_player_id=>players[3],p_drop_player_id=>players[1],p_user_id=>f.user_ids[1],p_bid_amount=>0,p_to_ir=>false,p_to_taxi=>true);
  PERFORM public.edit_waiver_claim_atomic(p_claim_id=>claim,p_member_id=>f.member_ids[1],p_user_id=>f.user_ids[1],p_drop_player_id=>players[1],p_bid_amount=>0,p_to_ir=>false);
  PERFORM pg_temp.check_rules((SELECT to_taxi FROM waiver_claims WHERE id=claim),'omitted taxi edit keeps the choice');
  PERFORM public.edit_waiver_claim_atomic(p_claim_id=>claim,p_member_id=>f.member_ids[1],p_user_id=>f.user_ids[1],p_drop_player_id=>players[1],p_to_ir=>false,p_to_taxi=>false);
  PERFORM pg_temp.check_rules((SELECT NOT to_taxi FROM waiver_claims WHERE id=claim),'explicit false edit clears taxi');
  PERFORM public.edit_waiver_claim_atomic(p_claim_id=>claim,p_member_id=>f.member_ids[1],p_user_id=>f.user_ids[1],p_drop_player_id=>players[1],p_to_ir=>false,p_to_taxi=>true);
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id=claim;
  SELECT * INTO result FROM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date);
  PERFORM pg_temp.check_rules(result.status='succeeded' AND EXISTS(SELECT 1 FROM roster_players WHERE player_id=players[3] AND league_id=f.league_id AND is_on_taxi),'waiver award enters taxi after tipoff');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM roster_players WHERE player_id=players[1] AND league_id=f.league_id),'taxi award skips stored drop');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM league_activity WHERE related_claim_id=claim AND body ILIKE '%taxi%'),'waiver activity names taxi');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM notification_outbox WHERE data->>'claimId'=claim::text AND body ILIKE '%taxi%'),'winning notification names taxi');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM roster_transactions WHERE related_claim_id=claim AND acquired_to_taxi),'waiver history records taxi tenure');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
