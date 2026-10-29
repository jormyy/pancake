BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; other record; player uuid:=gen_random_uuid(); pick uuid:=gen_random_uuid();
  terms jsonb; original_inputs jsonb; quote jsonb; valuation jsonb; offer uuid; original_analysis jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3,9590);
  SELECT * INTO other FROM pg_temp.rules_fixture(2,9591);
  UPDATE leagues SET trade_veto_mode='commissioner',trade_veto_window_hours=24 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp)
    VALUES(player,'Historical','Value','PG',ARRAY['PG'],3);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],player,'draft');
  INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES(pick,f.league_id,9591,1,f.member_ids[2],f.member_ids[2]);
  terms:=jsonb_build_array(jsonb_build_object('fromMemberId',f.member_ids[1],'toMemberId',f.member_ids[2],'playerId',player),
    jsonb_build_object('fromMemberId',f.member_ids[2],'toMemberId',f.member_ids[1],'pickId',pick));
  original_inputs:=public.get_trade_estimate_inputs(f.user_ids[1],f.member_ids[1],terms);
  original_analysis:='{"teams":[],"assets":[]}'::jsonb;
  quote:=public.save_trade_estimate_quote(f.user_ids[1],f.member_ids[1],original_inputs,original_analysis,'historical-fixture');
  offer:=public.submit_trade_offer_atomic(f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',
    jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,'recipientMemberId',f.member_ids[2],
      'offerPlayerIds',jsonb_build_array(player),'requestPickIds',jsonb_build_array(pick),'estimateId',quote->>'id'));
  PERFORM pg_temp.reject_rules(format('SELECT public.get_trade_revaluation_inputs(%L,%L,%L)',f.user_ids[3],f.member_ids[3],offer),
    'This trade is not available for revaluation.','uninvolved manager cannot revalue a private offer');
  PERFORM public.accept_trade_atomic(offer,f.member_ids[2]);
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=offer;
  PERFORM public.complete_accepted_trade_atomic(offer);
  PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[2] FROM roster_players WHERE player_id=player),'settlement actually transfers the player');
  PERFORM pg_temp.reject_rules(format('SELECT public.get_trade_estimate_inputs(%L,%L,%L)',f.user_ids[1],f.member_ids[1],jsonb_build_array(terms->0)),
    'A selected player is no longer owned by the sending team.','new offer quote still requires current player ownership');
  PERFORM pg_temp.reject_rules(format('SELECT public.get_trade_estimate_inputs(%L,%L,%L)',f.user_ids[1],f.member_ids[1],jsonb_build_array(terms->1)),
    'A selected pick is no longer available to the sending team.','new offer quote still requires current pick ownership');
  UPDATE leagues SET scoring_settings=jsonb_build_object('points',17) WHERE id=f.league_id;
  UPDATE draft_picks SET is_used=true WHERE id=pick;
  valuation:=public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],offer);
  PERFORM pg_temp.check_rules(valuation->>'closed'='true','completed trades never load live valuation inputs');
  PERFORM pg_temp.check_rules(valuation->'cachedRevaluation'='null','missing historical publication does not trigger a revaluation');
  PERFORM pg_temp.check_rules(public.get_trade_revaluation_inputs(f.user_ids[2],f.member_ids[2],offer)=valuation,
    'both original participants read the same frozen publication');
  PERFORM pg_temp.reject_rules(format('SELECT public.get_trade_revaluation_inputs(%L,%L,%L)',other.user_ids[1],other.member_ids[1],offer),
    'This trade is not available for revaluation.','other league cannot read historical terms');
  PERFORM pg_temp.reject_rules(format('SELECT public.get_trade_revaluation_inputs(%L,%L,%L)',f.user_ids[2],f.member_ids[1],offer),
    'This trade is not available for revaluation.','revaluation cannot impersonate another manager');
  PERFORM pg_temp.reject_rules(format('SELECT public.save_trade_estimate_quote(%L,%L,%L,%L,%L)',f.user_ids[1],f.member_ids[1],valuation,original_analysis,'historical-fixture'),
    'A historical revaluation cannot become an offer quote.','historical context cannot produce a submittable quote');
  PERFORM pg_temp.check_rules((SELECT q.inputs=original_inputs AND q.analysis=original_analysis FROM trade_estimate_quotes q WHERE q.id=(quote->>'id')::uuid),'revaluation preserves the original inputs and judgment');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM trade_estimate_quotes WHERE league_id=f.league_id),'revaluation writes no replacement quote');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.get_trade_revaluation_inputs(uuid,uuid,uuid)','EXECUTE'),'only the authenticated API service can request revaluation context');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('service_role','private.build_trade_estimate_inputs(uuid,uuid,jsonb,boolean)','EXECUTE'),'the ownership bypass stays private');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
