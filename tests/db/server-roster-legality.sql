BEGIN;
\ir rules-support.sql
CREATE FUNCTION pg_temp.roster_error(command text,code text,fragment text,label text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual_code text; actual_message text;
BEGIN
  BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN actual_code:=SQLSTATE; actual_message:=SQLERRM; END;
  PERFORM pg_temp.check_rules(actual_code=code AND actual_message ILIKE '%'||fragment||'%',label||COALESCE(': '||actual_message,': unexpected success'));
END;
$$;
DO $$
DECLARE f record; taxi uuid:=gen_random_uuid(); target uuid:=gen_random_uuid(); claimed uuid:=gen_random_uuid(); claim uuid; target_claim uuid; offer uuid;
  picks uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()]; roster uuid; outcome record;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3,9544);
  UPDATE leagues SET roster_size=2,taxi_slots=2 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number,career_regular_season_games)
    VALUES(taxi,'Taxi','Expired','PG',ARRAY['PG'],0,1,64),(target,'Legal','Target','PG',ARRAY['PG'],4,NULL,100),(claimed,'Pending','Target','PG',ARRAY['PG'],4,NULL,100);
  PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],taxi,'draft',gen_random_uuid());
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,is_on_taxi,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],taxi,true,'draft') RETURNING id INTO roster;
  INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at,clears_at) VALUES(f.league_id,f.season_id,claimed,now()-interval '4 days',now()-interval '1 hour');
  claim:=public.create_waiver_claim_atomic(f.league_id,f.member_ids[1],claimed,NULL,f.user_ids[1]);
  INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES(picks[1],f.league_id,9545,1,f.member_ids[1],f.member_ids[1]),(picks[2],f.league_id,9545,1,f.member_ids[2],f.member_ids[2]),(picks[3],f.league_id,9545,1,f.member_ids[3],f.member_ids[3]);
  offer:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[2],f.member_ids[1],'{}','{}',ARRAY[picks[2]],ARRAY[picks[1]]);
  UPDATE players SET years_exp=1,career_regular_season_games=65 WHERE id=taxi;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM pg_temp.roster_error(format('SELECT public.create_waiver_claim_atomic(%L,%L,%L,NULL,%L)',f.league_id,f.member_ids[1],target,f.user_ids[1]),'PA009','Taxi Expired','taxi blocks an available-player claim');
  PERFORM pg_temp.roster_error(format('SELECT public.create_waiver_claim_atomic(%L,%L,%L,NULL,%L)',f.league_id,f.member_ids[1],claimed,f.user_ids[1]),'PA009','Taxi Expired','taxi blocks claim creation');
  PERFORM pg_temp.roster_error(format('SELECT public.edit_waiver_claim_atomic(%L,%L,%L)',claim,f.member_ids[1],f.user_ids[1]),'PA009','Taxi Expired','taxi blocks claim edits');
  PERFORM pg_temp.roster_error(format('SELECT public.submit_trade_offer_atomic(%L,%L,%L,%L,%L)',f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,'recipientMemberId',f.member_ids[2],'offerPickIds',ARRAY[picks[1]],'requestPickIds',ARRAY[picks[2]])),'PT409','Taxi Expired','taxi blocks sent offers');
  PERFORM pg_temp.roster_error(format('SELECT public.submit_trade_offer_atomic(%L,%L,%L,%L,%L)',f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose-multi',jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,'participantMemberIds',f.member_ids,'items',jsonb_build_array(jsonb_build_object('fromMemberId',f.member_ids[1],'toMemberId',f.member_ids[2],'pickId',picks[1]),jsonb_build_object('fromMemberId',f.member_ids[2],'toMemberId',f.member_ids[3],'pickId',picks[2]),jsonb_build_object('fromMemberId',f.member_ids[3],'toMemberId',f.member_ids[1],'pickId',picks[3])))),'PT409','Taxi Expired','taxi blocks multi-team offers');
  PERFORM pg_temp.roster_error(format('SELECT public.accept_trade_atomic(%L,%L)',offer,f.member_ids[1]),'PT409','Taxi Expired','taxi blocks acceptance');
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id=claim;
  SELECT * INTO outcome FROM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date);
  PERFORM pg_temp.check_rules(outcome.status='failed_roster' AND outcome.failure_reason ILIKE '%Taxi Expired%','pending claim fails with the taxi player name');
  PERFORM public.toggle_taxi_atomic(roster,false,f.user_ids[1]);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_problems(f.league_id,f.season_id,f.member_ids[1])),'taxi activation clears illegality');
  target_claim:=public.create_waiver_claim_atomic(f.league_id,f.member_ids[1],target,NULL,f.user_ids[1]);
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id=target_claim;
  PERFORM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id AND player_id=target),'corrected roster permits additions');
  UPDATE players SET injury_status='Out' WHERE id=taxi;
  PERFORM public.toggle_ir_atomic(roster,true,f.user_ids[1]);
  UPDATE players SET injury_status=NULL WHERE id=taxi;
  PERFORM pg_temp.roster_error(format('SELECT public.edit_waiver_claim_atomic(%L,%L,%L)',claim,f.member_ids[1],f.user_ids[1]),'P0002','Pending waiver claim not found','settled claims stay immutable');
  PERFORM pg_temp.roster_error(format('SELECT public.create_waiver_claim_atomic(%L,%L,%L,NULL,%L)',f.league_id,f.member_ids[1],claimed,f.user_ids[1]),'PA005','Taxi Expired','IR retains its deployed error code and player name');
  PERFORM public.toggle_ir_atomic(roster,false,f.user_ids[1]);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(f.league_id,f.season_id,f.member_ids[1],claimed,'trade');
  PERFORM pg_temp.roster_error(format('SELECT public.create_waiver_claim_atomic(%L,%L,%L,NULL,%L)',f.league_id,f.member_ids[1],gen_random_uuid(),f.user_ids[1]),'PA003','','over-limit roster uses PA003');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
