BEGIN;
DO $$
DECLARE
  v_mode text;
  v_user uuid := gen_random_uuid();
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
  v_lower uuid := '00000000-0000-0000-0000-0000f6d47001';
  v_preferred uuid := '00000000-0000-0000-0000-0000f6d47002';
  v_preferred_claim uuid;
  v_result record;
BEGIN
  FOREACH v_mode IN ARRAY ARRAY['faab','rolling','faab_to_rolling']::text[] LOOP
  v_user := gen_random_uuid(); v_league := gen_random_uuid();
  v_season := gen_random_uuid(); v_member := gen_random_uuid();
  INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(v_user,'authenticated','authenticated',v_user||'@example.test','x',now(),'{}','{}',now(),now());
  INSERT INTO leagues(id,name,slug,commissioner_id,status,waiver_mode,weekly_add_limit,roster_size)
  VALUES(v_league,'Waiver Preference',v_league::text,v_user,'active',CASE WHEN v_mode='faab_to_rolling' THEN 'faab' ELSE v_mode END,NULL,CASE WHEN v_mode='faab' THEN 2 ELSE 1 END);
  INSERT INTO league_members(id,league_id,user_id,role,team_name)
  VALUES(v_member,v_league,v_user,'commissioner','Preference Team');
  INSERT INTO league_seasons(id,league_id,season_year,is_current)
  VALUES(v_season,v_league,2107,true);
  INSERT INTO waiver_priorities(league_id,league_season_id,member_id,priority)
  VALUES(v_league,v_season,v_member,1);
  INSERT INTO faab_balances(league_id,league_season_id,member_id,balance)
  VALUES(v_league,v_season,v_member,5)
  ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=5;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team) VALUES
  (v_lower,'Lower','UUID','PG',ARRAY['PG'],'Active','SIM'),
  (v_preferred,'Preferred','Player','SG',ARRAY['SG'],'Active','SIM') ON CONFLICT(id) DO NOTHING;
  INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at,clears_at)
  VALUES(v_league,v_season,v_lower,now()-interval '1 hour',now()+interval '47 hours'),
        (v_league,v_season,v_preferred,now()-interval '1 hour',now()+interval '47 hours');
  PERFORM create_waiver_claim_atomic(v_league,v_member,v_lower,NULL,v_user,CASE WHEN v_mode IN ('faab','faab_to_rolling') THEN 5 ELSE 0 END,1);
  PERFORM create_waiver_claim_atomic(v_league,v_member,v_preferred,NULL,v_user,CASE WHEN v_mode='faab' THEN 5 WHEN v_mode='faab_to_rolling' THEN 3 ELSE 0 END,2);
  SELECT id INTO v_preferred_claim FROM waiver_claims WHERE member_id=v_member AND player_id=v_preferred;
  IF v_mode='faab_to_rolling' THEN
    PERFORM set_config('request.jwt.claim.sub',v_user::text,true);
    PERFORM update_league_settings_atomic(v_league,'{"waiver_mode":"rolling"}');
    IF (SELECT bid_amount FROM waiver_claims WHERE id=v_preferred_claim) <> 3 THEN
      RAISE EXCEPTION 'Mode conversion test lost the original unequal bid';
    END IF;
  END IF;
  -- Legacy clients can submit tied orders. Both directions must recover them.
  UPDATE waiver_claims SET claim_order=2,
    submitted_at=CASE WHEN player_id=v_lower THEN now()-interval '1 minute' ELSE now() END
   WHERE member_id=v_member;
  PERFORM reorder_waiver_claim_atomic(v_preferred_claim,v_member,v_user,'up');
  IF (SELECT claim_order FROM waiver_claims WHERE id=v_preferred_claim) <> 1 THEN
    RAISE EXCEPTION 'Up arrow cannot recover a tied preference';
  END IF;
  PERFORM reorder_waiver_claim_atomic(v_preferred_claim,v_member,v_user,'down');
  IF (SELECT claim_order FROM waiver_claims WHERE id=v_preferred_claim) <> 2 THEN
    RAISE EXCEPTION 'Down arrow did not move the claim';
  END IF;
  PERFORM reorder_waiver_claim_atomic(v_preferred_claim,v_member,v_user,'up');
  IF (SELECT claim_order FROM waiver_claims WHERE id=v_preferred_claim) <> 1 THEN
    RAISE EXCEPTION 'Reorder did not store the preferred claim first';
  END IF;
  IF v_mode <> 'faab_to_rolling' THEN
  PERFORM edit_waiver_claim_atomic(v_preferred_claim,v_member,v_user,NULL,CASE WHEN v_mode='faab' THEN 5 ELSE 0 END);
  IF (SELECT claim_order FROM waiver_claims WHERE id=v_preferred_claim) <> 1 THEN
    RAISE EXCEPTION 'Bid-only save overwrote committed preference';
  END IF;
  END IF;
  UPDATE waiver_wire_log SET clears_at=now()-interval '2 days' WHERE league_id=v_league;
  UPDATE waiver_claims SET process_date=current_date-1 WHERE league_id=v_league;
  FOR v_result IN SELECT * FROM process_due_waiver_claims_atomic(current_date,100) LOOP
    IF v_result.member_id=v_member THEN
      RAISE NOTICE 'waiver preference result: player %, status %',v_result.player_id,v_result.status;
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM roster_players WHERE member_id=v_member AND player_id=v_preferred)
     OR EXISTS(SELECT 1 FROM roster_players WHERE member_id=v_member AND player_id=v_lower) THEN
    RAISE EXCEPTION 'Equal-bid processing ignores the stored claim preference';
  END IF;
  IF v_mode='faab' AND (SELECT balance FROM faab_balances WHERE member_id=v_member AND league_season_id=v_season) <> 0 THEN
    RAISE EXCEPTION 'Winning preferred claim did not debit the exact bid';
  END IF;
  END LOOP;
END;
$$;
ROLLBACK;
