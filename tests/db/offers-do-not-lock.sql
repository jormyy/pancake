BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; p uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  a uuid; b uuid; c uuid; pick uuid:=gen_random_uuid(); snapshot jsonb; i int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3,9601);
  UPDATE leagues SET allow_inactive_trades=true,ir_slots=2,taxi_slots=2,trade_veto_mode='commissioner',trade_veto_window_hours=24 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,injury_status)
    SELECT id,'No lock',n::text,'PG',ARRAY['PG'],0,'Out' FROM unnest(p) WITH ORDINALITY ids(id,n);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    SELECT f.league_id,f.season_id,f.member_ids[n],p[n],'draft' FROM generate_series(1,3) n;
  a:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[p[1]],ARRAY[p[2]],'{}','{}');
  b:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[3],ARRAY[p[1]],ARRAY[p[3]],'{}','{}');
  c:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[3],f.member_ids[1],ARRAY[p[3]],ARRAY[p[1]],'{}','{}');
  PERFORM pg_temp.check_rules((SELECT count(*)=3 FROM trades WHERE id IN(a,b,c) AND status='pending'),'one player appears in three sent and received pending offers');
  PERFORM pg_temp.check_rules(NOT private.is_reserved_trade_asset(f.league_id,f.season_id,f.member_ids[1],p[1]),'pending player has no trade reservation');
  PERFORM pg_temp.check_rules(NOT private.is_reserved_trade_asset(f.league_id,f.season_id,f.member_ids[2],p[2]),'received pending player has no trade reservation');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  snapshot:=public.view_roster(f.league_id,f.member_ids[1]);
  PERFORM pg_temp.check_rules(jsonb_array_length(snapshot->'lockedAssets')=3,'all pending offers keep roster locks');
  PERFORM pg_temp.check_rules(snapshot->'tradeLockedAssets'='[]'::jsonb,'pending offers do not disable builder assets');
  PERFORM set_config('request.jwt.claim.sub','',true);
  FOR i IN 1..2 LOOP
    PERFORM set_config('request.jwt.claim.sub',f.user_ids[i]::text,true);
    PERFORM pg_temp.reject_rules(format('SELECT public.drop_player_atomic(id) FROM roster_players WHERE player_id=%L',p[i]),'Locked by trade %','drop blocked for pending side '||i);
    PERFORM pg_temp.reject_rules(format('DELETE FROM roster_players WHERE player_id=%L',p[i]),'Locked by trade %','direct drop blocked for pending side '||i);
    PERFORM pg_temp.reject_rules(format('UPDATE roster_players SET is_on_ir=true WHERE player_id=%L',p[i]),'Locked by trade %','IR blocked for pending side '||i);
    PERFORM pg_temp.reject_rules(format('UPDATE roster_players SET is_on_taxi=true WHERE player_id=%L',p[i]),'Locked by trade %','Taxi blocked for pending side '||i);
    PERFORM pg_temp.reject_rules(format('SELECT public.create_waiver_claim_atomic(%L,%L,%L,%L,%L)',f.league_id,f.member_ids[i],p[4],p[i],f.user_ids[i]),'Locked by trade %','waiver drop blocked for pending side '||i);
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM public.accept_trade_atomic(a,f.member_ids[2]);
  PERFORM pg_temp.check_rules((SELECT status='accepted' FROM trades WHERE id=a),'first overlapping offer accepts during review');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM trades WHERE id IN(b,c) AND status='withdrawn' AND completion_failure_reason='A player in this offer was traded'),'all overlapping offers cancel with player reason');
  PERFORM pg_temp.check_rules((SELECT count(*)=4 FROM notification_outbox WHERE data->>'tradeId' IN(b::text,c::text) AND event_type='trade_withdrawn' AND title='Trade Cancelled' AND body='A player in this offer was traded'),'both sides receive each cancellation notification');
  PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)',b,f.member_ids[3]),'%no longer pending%','cancelled second accept fails cleanly');
  PERFORM pg_temp.check_rules(private.is_reserved_trade_asset(f.league_id,f.season_id,f.member_ids[1],p[1]),'accepted review player stays reserved');
  PERFORM pg_temp.reject_rules(format('SELECT private.assert_trade_assets_acceptance_ready(%L,%L,%L)',b,f.league_id,f.season_id),'Locked by trade %','acceptance readiness rejects assets in an accepted review trade');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM pg_temp.check_rules(jsonb_array_length(public.view_roster(f.league_id,f.member_ids[1])->'tradeLockedAssets')=1,'accepted review disables builder asset');
  PERFORM set_config('request.jwt.claim.sub','',true);
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=a;
  PERFORM public.complete_accepted_trade_atomic(a);
  PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[2] FROM roster_players WHERE player_id=p[1]),'execution transfers the expected player');
  PERFORM pg_temp.check_rules((SELECT status='completed' FROM trades WHERE id=a),'accepted player trade completes');
  PERFORM pg_temp.check_rules((SELECT count(*)=4 FROM notification_outbox WHERE data->>'tradeId' IN(b::text,c::text) AND event_type='trade_withdrawn'),'completion does not duplicate cancellation notifications');
  INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES(pick,f.league_id,9602,1,f.member_ids[1],f.member_ids[1]);
  a:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'{}',ARRAY[p[1]],ARRAY[pick],'{}');
  b:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[3],'{}',ARRAY[p[3]],ARRAY[pick],'{}');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM trades WHERE id IN(a,b) AND status='pending'),'a pick appears in two pending offers');
  PERFORM public.accept_trade_atomic(a,f.member_ids[2]);
  PERFORM pg_temp.check_rules((SELECT status='withdrawn' AND completion_failure_reason='An asset in this offer was traded' FROM trades WHERE id=b),'pick overlap cancels with asset wording');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM notification_outbox WHERE data->>'tradeId'=b::text AND title='Trade Cancelled' AND body='An asset in this offer was traded'),'pick cancellation notifies both sides');
  PERFORM pg_temp.reject_rules(format('UPDATE draft_picks SET current_owner_id=%L WHERE id=%L',f.member_ids[3],pick),'Locked by trade %','accepted review pick stays locked');
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=a;
  PERFORM public.complete_accepted_trade_atomic(a);
  PERFORM pg_temp.check_rules((SELECT current_owner_id=f.member_ids[2] FROM draft_picks WHERE id=pick),'execution transfers the expected pick');
END;
$$;
DO $$
DECLARE f record; a uuid; b uuid; c uuid; payload jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3,9603);
  UPDATE leagues SET trade_veto_mode='commissioner',trade_veto_window_hours=24 WHERE id=f.league_id;
  payload:=jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,'recipientMemberId',f.member_ids[2],
    'offerPlayerIds','[]'::jsonb,'requestPlayerIds','[]'::jsonb,'offerPickIds','[]'::jsonb,'requestPickIds','[]'::jsonb,'offerFaabAmount',150,'requestFaabAmount',1);
  a:=public.submit_trade_offer_atomic(f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',payload);
  PERFORM pg_temp.check_rules((SELECT status='pending' FROM trades WHERE id=a),'FAAB above current balance can be sent through the real submit path');
  PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)',a,f.member_ids[2]),'%enough FAAB%','oversized sent FAAB is rejected at accept');
  a:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'{}','{}','{}','{}',NULL,NULL,80,1);
  b:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[3],'{}','{}','{}','{}',NULL,NULL,80,1);
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM trades WHERE id IN(a,b) AND status='pending'),'two pending offers may together exceed FAAB');
  PERFORM public.accept_trade_atomic(a,f.member_ids[2]);
  PERFORM pg_temp.check_rules(private.available_faab_balance(f.league_id,f.season_id,f.member_ids[1])=20,'accepted review reserves outgoing FAAB');
  PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)',b,f.member_ids[3]),'%enough FAAB%','second acceptance cannot overspend accepted FAAB');
  PERFORM pg_temp.check_rules((SELECT status='pending' FROM trades WHERE id=b),'failed FAAB acceptance rolls back without cancelling the offer');
  PERFORM pg_temp.check_rules((SELECT accepted_at IS NULL FROM trade_participants WHERE trade_id=b AND member_id=f.member_ids[3]),'failed FAAB acceptance records no acceptance');
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=a;
  PERFORM public.complete_accepted_trade_atomic(a);
  PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)',b,f.member_ids[3]),'%enough FAAB%','processed FAAB stays unavailable to the second offer');
  PERFORM pg_temp.check_rules((SELECT balance=21 FROM faab_balances WHERE league_season_id=f.season_id AND member_id=f.member_ids[1]),'settlement debits FAAB once');
  c:=public.propose_multi_team_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids,
    jsonb_build_array(jsonb_build_object('fromMemberId',f.member_ids[1],'toMemberId',f.member_ids[2],'faabAmount',150),
      jsonb_build_object('fromMemberId',f.member_ids[2],'toMemberId',f.member_ids[3],'faabAmount',1),
      jsonb_build_object('fromMemberId',f.member_ids[3],'toMemberId',f.member_ids[1],'faabAmount',1)));
  PERFORM pg_temp.check_rules((SELECT status='pending' FROM trades WHERE id=c),'multi-team sends also defer FAAB sufficiency');
  PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)',c,f.member_ids[2]),'%enough FAAB%','multi-team accept checks every sender budget');
END;
$$;
DO $$
DECLARE f record; p uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()]; a uuid; b uuid; pick uuid:=gen_random_uuid(); stale_pick uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3,9607);
  INSERT INTO players(id,first_name,last_name,position,eligible_positions)
    SELECT id,'Ownership check',n::text,'PG',ARRAY['PG'] FROM unnest(p) WITH ORDINALITY ids(id,n);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    SELECT f.league_id,f.season_id,f.member_ids[n],p[n],'draft' FROM generate_series(1,3) n;
  a:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[p[1]],ARRAY[p[2]],'{}','{}');
  UPDATE trade_items SET player_id=p[3] WHERE trade_id=a AND player_id=p[1];
  PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)',a,f.member_ids[2]),'%no longer owns%','accept rechecks player ownership even with a stale pending offer');
  PERFORM pg_temp.check_rules((SELECT status='pending' FROM trades WHERE id=a),'failed player ownership check preserves pending status');
  PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[2] FROM roster_players WHERE league_season_id=f.season_id AND player_id=p[2]),'failed player ownership check transfers no counterparty asset');
  INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES(pick,f.league_id,9608,1,f.member_ids[1],f.member_ids[1]),
      (stale_pick,f.league_id,9608,2,f.member_ids[3],f.member_ids[3]);
  b:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'{}',ARRAY[p[2]],ARRAY[pick],'{}');
  UPDATE trade_items SET pick_id=stale_pick WHERE trade_id=b AND pick_id=pick;
  PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)',b,f.member_ids[2]),'%Draft-pick asset is no longer owned%','accept rechecks pick ownership even with a stale pending offer');
  PERFORM pg_temp.check_rules((SELECT status='pending' FROM trades WHERE id=b),'failed pick ownership check preserves pending status');
  PERFORM pg_temp.check_rules((SELECT current_owner_id=f.member_ids[3] FROM draft_picks WHERE id=stale_pick),'failed pick ownership check leaves the actual owner unchanged');
END;
$$;
DO $$
DECLARE f record; p uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()]; a uuid; b uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3,9609);
  UPDATE leagues SET trade_veto_mode='commissioner',trade_veto_window_hours=24 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions)
    SELECT id,'Plan overlap',n::text,'PG',ARRAY['PG'] FROM unnest(p) WITH ORDINALITY ids(id,n);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    SELECT f.league_id,f.season_id,f.member_ids[CASE WHEN n=4 THEN 1 ELSE n END],p[n],'draft' FROM generate_series(1,4) n;
  a:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[p[4]],ARRAY[p[2]],'{}','{}');
  PERFORM public.set_trade_roster_plan_atomic(a,f.member_ids[1],f.user_ids[1],'{}','{}',ARRAY[p[1]]);
  b:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[3],ARRAY[p[1]],ARRAY[p[3]],'{}','{}');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM trades WHERE id IN(a,b) AND status='pending'),'a pending roster plan does not reserve an asset for trading');
  PERFORM public.accept_trade_atomic(b,f.member_ids[3]);
  PERFORM pg_temp.check_rules((SELECT status='withdrawn' AND completion_failure_reason='A player in this offer was traded' FROM trades WHERE id=a),'acceptance cancels pending plans containing the traded asset');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM notification_outbox WHERE data->>'tradeId'=a::text AND title='Trade Cancelled'),'cancelled plan notifies both sides');
  PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[1] FROM roster_players WHERE league_season_id=f.season_id AND player_id=p[1]),'review cancellation applies no planned drop');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
