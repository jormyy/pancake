BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; draft uuid; dead uuid; requested uuid; player uuid; chosen uuid; i int; new_year int; offer uuid; stop_offer uuid; old_pick uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9545,'offseason');
  INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
    SELECT f.league_id,9545,r,m,m FROM unnest(f.member_ids) m CROSS JOIN generate_series(1,3) r;
  SELECT id INTO dead FROM draft_picks WHERE league_id=f.league_id AND round=3 AND original_owner_id=f.member_ids[1];
  SELECT id INTO requested FROM draft_picks WHERE league_id=f.league_id AND round=3 AND original_owner_id=f.member_ids[2];
  offer:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'{}','{}',ARRAY[dead],ARRAY[requested]);
  PERFORM set_config('request.jwt.claim.sub',(SELECT commissioner_id::text FROM public.leagues WHERE id=f.league_id),true);
  PERFORM pg_temp.reject_rules(format('SELECT public.start_rookie_draft_atomic(%L,2,false)',f.league_id),'%reserved%','a pending pick blocks the draft until withdrawal');
  PERFORM public.withdraw_trade_atomic(offer,f.member_ids[1],f.user_ids[1]);
  draft:=(public.start_rookie_draft_atomic(p_league_id=>f.league_id,p_rounds=>2,p_is_mock=>false)->>'id')::uuid;
  PERFORM pg_temp.check_rules((SELECT status='withdrawn' FROM trades WHERE id=offer),'withdrawing the locked offer permits pick retirement');
  FOR i IN 1..4 LOOP
    player:=gen_random_uuid();
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
      VALUES(player,'Retired',i::text,'PG',ARRAY['PG'],0,i);
    SELECT member_id INTO chosen FROM snake_draft_picks WHERE draft_id=draft AND player_id IS NULL ORDER BY overall_pick LIMIT 1;
    PERFORM public.make_snake_pick_atomic(draft,chosen,player);
  END LOOP;
  PERFORM pg_temp.check_rules((SELECT status='completed' FROM drafts WHERE id=draft),'two-round draft completes');
  PERFORM pg_temp.reject_rules(format('SELECT public.propose_trade_atomic(%L,%L,%L,%L,''{}'',''{}'',ARRAY[%L]::uuid[],ARRAY[%L]::uuid[])',f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],dead,requested),'Your offer includes a draft pick that is no longer owned by the expected team.','completed draft cannot sell an unused third round');
  PERFORM pg_temp.check_rules((SELECT bool_and(is_used) FROM draft_picks WHERE league_id=f.league_id AND season_year=9545),'all completed class picks retire');
  UPDATE leagues SET status='playoffs' WHERE id=f.league_id;
  INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES(f.league_id,9544,1,f.member_ids[1],f.member_ids[1]);
  SELECT a.new_year INTO new_year FROM public.advance_season_atomic(f.league_id) a;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM draft_picks WHERE league_id=f.league_id AND season_year<new_year AND NOT is_used),'rollover retires every past unused pick');
  SELECT id INTO dead FROM draft_picks WHERE league_id=f.league_id AND season_year=new_year AND round=1 AND original_owner_id=f.member_ids[1];
  SELECT id INTO requested FROM draft_picks WHERE league_id=f.league_id AND season_year=new_year AND round=1 AND original_owner_id=f.member_ids[2];
  stop_offer:=public.propose_trade_atomic(f.league_id,(SELECT id FROM league_seasons WHERE league_id=f.league_id AND is_current),f.member_ids[1],f.member_ids[2],'{}','{}',ARRAY[dead],ARRAY[requested]);
  PERFORM set_config('request.jwt.claim.sub',(SELECT commissioner_id::text FROM public.leagues WHERE id=f.league_id),true);
  PERFORM public.withdraw_trade_atomic(stop_offer,f.member_ids[1],f.user_ids[1]);
  draft:=(public.start_rookie_draft_atomic(f.league_id,2,false)->>'id')::uuid;
  PERFORM public.stop_draft_atomic(draft,f.user_ids[1]);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM snake_draft_picks slot JOIN draft_picks pick ON pick.id=slot.draft_pick_id WHERE slot.draft_id=draft AND NOT pick.is_used),'stop retires every unpicked slot');
  PERFORM pg_temp.check_rules((SELECT status='withdrawn' FROM trades WHERE id=stop_offer),'the withdrawn offer stays terminal after draft stop');
  old_pick:=gen_random_uuid();
  INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id) VALUES(old_pick,f.league_id,new_year-3,1,f.member_ids[1],f.member_ids[1]);
  PERFORM pg_temp.reject_rules(format('SELECT public.propose_trade_atomic(%L,%L,%L,%L,''{}'',''{}'',ARRAY[%L]::uuid[],ARRAY[%L]::uuid[])',f.league_id,(SELECT id FROM league_seasons WHERE league_id=f.league_id AND is_current),f.member_ids[1],f.member_ids[2],old_pick,requested),'Picks from past seasons cannot be traded.','past-season picks are refused even when not marked used');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
