BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE activity_privacy(league_id uuid,user_id uuid,activity_id uuid,transition text);
DO $$
DECLARE f record; v_players uuid[]; offer uuid; target uuid; transition text; activity jsonb; original_count int; activity_id uuid;
BEGIN
  FOREACH transition IN ARRAY ARRAY['offered','countered','edited','accepted','rejected','withdrawn','expired','vetoed','completed'] LOOP
    SELECT * INTO f FROM pg_temp.rules_fixture(3,9581);
    UPDATE league_members SET role='co_commissioner' WHERE id=f.member_ids[3];
    UPDATE leagues SET trade_veto_mode='commissioner',trade_veto_window_hours=24 WHERE id=f.league_id;
    v_players:=ARRAY[gen_random_uuid(),gen_random_uuid()];
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp)
      SELECT id,'Activity',id::text,'PG',ARRAY['PG'],2 FROM unnest(v_players) id;
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      SELECT f.league_id,f.season_id,f.member_ids[n],v_players[n],'draft' FROM generate_series(1,2) n;
    offer:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[v_players[1]],ARRAY[v_players[2]],'{}','{}');
    target:=offer;
    IF transition='countered' THEN
      target:=public.submit_trade_offer_atomic(f.user_ids[2],gen_random_uuid(),f.member_ids[2],'counter',
        jsonb_build_object('tradeId',offer,'offerPlayerIds',ARRAY[v_players[2]],'requestPlayerIds',ARRAY[v_players[1]]));
    ELSIF transition='edited' THEN
      target:=public.submit_trade_offer_atomic(f.user_ids[1],gen_random_uuid(),f.member_ids[1],'edit',
        jsonb_build_object('tradeId',offer,'offerPlayerIds',ARRAY[v_players[1]],'requestPlayerIds',ARRAY[v_players[2]],'notes','Updated offer'));
    ELSIF transition IN ('accepted','vetoed','completed') THEN
      PERFORM public.accept_trade_atomic(offer,f.member_ids[2]);
      IF transition='vetoed' THEN PERFORM public.veto_trade_atomic(offer,f.member_ids[3]); END IF;
      IF transition='completed' THEN
        UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=offer;
        PERFORM public.complete_accepted_trade_atomic(offer);
      END IF;
    ELSIF transition='rejected' THEN PERFORM public.reject_trade_atomic(offer,f.member_ids[2],f.user_ids[2]);
    ELSIF transition='withdrawn' THEN PERFORM public.withdraw_trade_atomic(offer,f.member_ids[1],f.user_ids[1]);
    ELSIF transition='expired' THEN
      UPDATE trades SET expires_at=now()-interval '1 minute' WHERE id=offer;
      PERFORM public.expire_pending_trades_atomic(500);
    END IF;
    PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM league_activity WHERE related_trade_id=target AND event_type='trade_'||transition),transition||' has exactly one activity row');
    SELECT metadata,id INTO activity,activity_id FROM league_activity WHERE related_trade_id=target AND event_type='trade_'||transition;
    PERFORM pg_temp.check_rules(jsonb_array_length(activity->'player_mentions')=2
      AND activity->'player_mentions' @> (SELECT jsonb_agg(jsonb_build_object('id',id,'name',display_name)) FROM public.players WHERE id=ANY(v_players)),
      transition||' carries both player identities');
    INSERT INTO activity_privacy VALUES(f.league_id,f.user_ids[3],activity_id,transition);
    SELECT count(*) INTO original_count FROM league_activity WHERE related_trade_id=target;
    UPDATE trades SET notes=notes WHERE id=target;
    PERFORM pg_temp.check_rules((SELECT count(*)=original_count FROM league_activity WHERE related_trade_id=target),transition||' unchanged write cannot duplicate activity');
  END LOOP;
END;
$$;
DO $$
DECLARE sample record; visible boolean;
BEGIN
  FOR sample IN SELECT * FROM activity_privacy LOOP
    PERFORM set_config('request.jwt.claim.sub',sample.user_id::text,true);
    SELECT EXISTS(SELECT 1 FROM public.get_league_activity_feed(sample.league_id,100,0) WHERE id=sample.activity_id) INTO visible;
    PERFORM pg_temp.check_rules(visible=(sample.transition='completed'),sample.transition||' preserves public feed privacy');
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
