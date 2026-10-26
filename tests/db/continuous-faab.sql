BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); c uuid; d uuid; result_count int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9581);
  UPDATE leagues SET waiver_mode='faab',faab_starting_budget=100 WHERE id=f.league_id;
  INSERT INTO faab_balances(league_id,league_season_id,member_id,balance)
    VALUES(f.league_id,f.season_id,f.member_ids[1],100),(f.league_id,f.season_id,f.member_ids[2],100)
    ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions)
    VALUES(a,'Available','One','PG',ARRAY['PG']),(b,'Available','Two','SG',ARRAY['SG']);
  c:=public.create_waiver_claim_atomic(f.league_id,f.member_ids[1],a,NULL,f.user_ids[1],12);
  d:=public.create_waiver_claim_atomic(f.league_id,f.member_ids[2],a,NULL,f.user_ids[2],12);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id),'claim leaves roster unchanged');
  PERFORM pg_temp.check_rules((SELECT sum(balance)=200 FROM faab_balances WHERE league_id=f.league_id),'claim leaves funds unchanged');
  PERFORM pg_temp.check_rules((SELECT (process_date+time '03:00') AT TIME ZONE 'America/New_York'>now() FROM waiver_claims WHERE id=c),'claim targets a future run');
  SELECT count(*) INTO result_count FROM public.process_due_waiver_claims_atomic(current_date+7);
  PERFORM pg_temp.check_rules((SELECT status='pending' FROM waiver_claims WHERE id=c),'future process parameter cannot award early');
  PERFORM public.edit_waiver_claim_atomic(c,f.member_ids[1],f.user_ids[1],NULL,12);
  PERFORM pg_temp.check_rules((SELECT bid_amount=12 FROM waiver_claims WHERE id=c),'free agent claim is editable');
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id IN(c,d);
  PERFORM pg_temp.reject_rules(format('SELECT public.edit_waiver_claim_atomic(%L,%L,%L,NULL,20)',c,f.member_ids[1],f.user_ids[1]),'%cutoff%','missed cutoff freezes bid');
  SELECT count(*) INTO result_count FROM public.process_due_waiver_claims_atomic(current_date+7);
  PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[1] FROM roster_players WHERE league_id=f.league_id AND player_id=a),'equal bids use rolling priority');
  PERFORM pg_temp.check_rules((SELECT balance=88 FROM faab_balances WHERE league_id=f.league_id AND member_id=f.member_ids[1]),'winner pays exactly once');
  PERFORM public.process_due_waiver_claims_atomic(current_date+7);
  PERFORM pg_temp.check_rules((SELECT balance=88 FROM faab_balances WHERE league_id=f.league_id AND member_id=f.member_ids[1]),'retry does not charge again');
  PERFORM pg_temp.check_rules((SELECT priority FROM waiver_priorities WHERE member_id=f.member_ids[1])>(SELECT priority FROM waiver_priorities WHERE member_id=f.member_ids[2]),'winner moves behind other team');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',f.user_ids[1],'role','authenticated')::text,true);
  PERFORM pg_temp.reject_rules(format('SELECT public.add_free_agent_atomic(%L,%L,%L)',f.member_ids[1],f.league_id,b),'%claim%','old client cannot add instantly');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id AND player_id=b),'rejected instant add leaves ownership unchanged');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
