BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; player uuid:=gen_random_uuid(); claim uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9546);
  INSERT INTO players(id,first_name,last_name,position,eligible_positions) VALUES(player,'Due','Claim','PG',ARRAY['PG']);
  INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at,clears_at) VALUES(f.league_id,f.season_id,player,now()-interval '4 days',now()-interval '1 hour');
  claim:=public.create_waiver_claim_atomic(f.league_id,f.member_ids[1],player,NULL,f.user_ids[1]);
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id=claim;
  UPDATE waiver_wire_log SET clears_at=now()-interval '2 days' WHERE league_id=f.league_id;
  PERFORM pg_temp.check_rules(public.count_due_waiver_claims(p_process_date=>(now() AT TIME ZONE 'America/New_York')::date)=1,'due count sees processable pending claims');
  UPDATE waiver_wire_log SET clears_at=now()+interval '1 hour' WHERE league_id=f.league_id;
  PERFORM pg_temp.check_rules(public.count_due_waiver_claims(p_process_date=>(now() AT TIME ZONE 'America/New_York')::date)=0,'future waiver windows do not count');
  UPDATE waiver_wire_log SET clears_at=now()-interval '2 days' WHERE league_id=f.league_id;
  UPDATE leagues SET status='drafting' WHERE id=f.league_id;
  PERFORM pg_temp.check_rules(public.count_due_waiver_claims(p_process_date=>(now() AT TIME ZONE 'America/New_York')::date)=0,'inactive candidate league does not count');
  UPDATE leagues SET status='active' WHERE id=f.league_id;
  PERFORM pg_temp.check_rules(public.count_due_waiver_claims(p_process_date=>date '2000-01-01')=0,'future process dates do not count');
  UPDATE waiver_claims SET status='cancelled' WHERE id=claim;
  PERFORM pg_temp.check_rules(public.count_due_waiver_claims(p_process_date=>(now() AT TIME ZONE 'America/New_York')::date)=0,'settled claims do not count');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
