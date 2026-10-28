BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); c uuid; d uuid; result_count int; roster uuid; hold_state text; saved_history jsonb;
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
  PERFORM pg_temp.check_rules((SELECT (process_date+time '00:00') AT TIME ZONE 'America/Los_Angeles'>now() FROM waiver_claims WHERE id=c),'claim targets a future run');
  SELECT count(*) INTO result_count FROM public.process_due_waiver_claims_atomic(current_date+7);
  PERFORM pg_temp.check_rules((SELECT status='pending' FROM waiver_claims WHERE id=c),'future process parameter cannot award early');
  PERFORM public.edit_waiver_claim_atomic(c,f.member_ids[1],f.user_ids[1],NULL,12);
  PERFORM pg_temp.check_rules((SELECT bid_amount=12 FROM waiver_claims WHERE id=c),'free agent claim is editable');
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/Los_Angeles')::date-1 WHERE id IN(c,d);
  PERFORM pg_temp.reject_rules(format('SELECT public.edit_waiver_claim_atomic(%L,%L,%L,NULL,20)',c,f.member_ids[1],f.user_ids[1]),'%cutoff%','missed cutoff freezes bid');
  SELECT count(*) INTO result_count FROM public.process_due_waiver_claims_atomic(current_date+7);
  PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[1] FROM roster_players WHERE league_id=f.league_id AND player_id=a),'equal bids use rolling priority');
  PERFORM pg_temp.check_rules((SELECT balance=88 FROM faab_balances WHERE league_id=f.league_id AND member_id=f.member_ids[1]),'winner pays exactly once');
  PERFORM public.process_due_waiver_claims_atomic(current_date+7);
  PERFORM pg_temp.check_rules((SELECT balance=88 FROM faab_balances WHERE league_id=f.league_id AND member_id=f.member_ids[1]),'retry does not charge again');
  PERFORM pg_temp.check_rules((SELECT priority FROM waiver_priorities WHERE member_id=f.member_ids[1])>(SELECT priority FROM waiver_priorities WHERE member_id=f.member_ids[2]),'winner moves behind other team');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',f.user_ids[1],'role','authenticated')::text,true);
  SELECT id INTO roster FROM roster_players WHERE league_id=f.league_id AND player_id=a;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) INTO saved_history FROM roster_transactions t WHERE league_id=f.league_id;
  UPDATE leagues SET roster_size=1 WHERE id=f.league_id;
  FOREACH hold_state IN ARRAY ARRAY['none','uncleared','cleared'] LOOP
    IF hold_state='uncleared' THEN
      INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at)
        VALUES(f.league_id,f.season_id,b,now()-interval '4 days');
    ELSIF hold_state='cleared' THEN
      UPDATE waiver_wire_log SET cleared_at=now() WHERE league_id=f.league_id AND player_id=b;
    END IF;
    PERFORM pg_temp.reject_rules(format('SELECT public.add_free_agent_atomic(%L,%L,%L)',f.member_ids[1],f.league_id,b),
      '%scheduled waiver claim%',hold_state||' instant add requires a claim');
    PERFORM pg_temp.reject_rules(format('SELECT public.drop_and_add_free_agent_atomic(%L,%L,%L,%L)',roster,f.member_ids[1],f.league_id,b),
      '%scheduled waiver claim%',hold_state||' compound add requires a claim');
    PERFORM pg_temp.reject_rules(format('INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(%L,%L,%L,%L,''free_agent'')',
      f.league_id,f.season_id,f.member_ids[1],b), '%scheduled waiver claim%',hold_state||' direct free-agent insert requires a claim');
    PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM roster_players WHERE id=roster)
      AND NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id AND player_id=b)
      AND saved_history=(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM roster_transactions t WHERE league_id=f.league_id),
      hold_state||' rejected pickups preserve ownership and exact transaction history');
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
