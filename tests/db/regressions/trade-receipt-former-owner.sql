\set ON_ERROR_STOP on
BEGIN;
\ir ../rules-support.sql

CREATE FUNCTION pg_temp.reject_trade_receipt(
  p_user_id uuid, p_request_id uuid, p_member_id uuid, p_payload jsonb, p_message text, p_label text
)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_denied boolean := false;
BEGIN
  BEGIN
    PERFORM public.submit_trade_offer_atomic(p_user_id,p_request_id,p_member_id,'propose',p_payload);
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM IS DISTINCT FROM p_message THEN RAISE; END IF;
    v_denied := true;
  END;
  PERFORM pg_temp.check_rules(v_denied,p_label);
END;
$$;

DO $$
DECLARE
  f record;
  other_league record;
  v_request_id uuid := gen_random_uuid();
  payload jsonb;
  trade uuid;
  replacement uuid := gen_random_uuid();
  denied boolean := false;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9587);
  SELECT * INTO other_league FROM pg_temp.rules_fixture(2,9588);
  payload := jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,
    'recipientMemberId',f.member_ids[2],'offerFaabAmount',1,'requestFaabAmount',1);
  trade := public.submit_trade_offer_atomic(f.user_ids[1],v_request_id,f.member_ids[1],'propose',payload);
  PERFORM pg_temp.check_rules(trade IS NOT NULL,'the original request commits a trade');
  PERFORM pg_temp.check_rules(
    public.submit_trade_offer_atomic(f.user_ids[1],v_request_id,f.member_ids[1],'propose',payload) IS NOT DISTINCT FROM trade,
    'the owner replays the committed trade');

  INSERT INTO auth.users(id,email) VALUES(replacement,replacement::text||'@example.test');
  UPDATE public.league_members SET user_id=replacement WHERE id=f.member_ids[1];
  BEGIN
    PERFORM public.submit_trade_offer_atomic(f.user_ids[1],v_request_id,f.member_ids[1],'propose',payload);
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM IS DISTINCT FROM 'Not authorized to act for this member.' THEN RAISE; END IF;
    denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'BUG: a former owner replays a trade receipt without membership'; END IF;
  PERFORM pg_temp.check_rules(denied,'the former owner cannot replay without membership');
  PERFORM pg_temp.reject_trade_receipt(replacement,v_request_id,f.member_ids[1],payload,
    'Not authorized to replay this trade request.','the replacement owner cannot claim the original request');
  UPDATE public.league_members SET user_id=f.user_ids[1] WHERE id=f.member_ids[1];

  PERFORM pg_temp.reject_trade_receipt(f.user_ids[2],v_request_id,f.member_ids[1],payload,
    'Not authorized to act for this member.','another member cannot act as the original member');
  PERFORM pg_temp.reject_trade_receipt(f.user_ids[2],v_request_id,f.member_ids[2],
    payload||jsonb_build_object('recipientMemberId',f.member_ids[1]),
    'Not authorized to replay this trade request.','another member cannot reuse the original request');
  UPDATE public.league_members SET user_id=f.user_ids[1] WHERE id=other_league.member_ids[1];
  PERFORM pg_temp.reject_trade_receipt(f.user_ids[1],v_request_id,other_league.member_ids[1],payload,
    'Not authorized to replay this trade request.','the owner cannot replay through another membership');

  denied := false;
  BEGIN
    DELETE FROM public.trades WHERE id=trade;
    DELETE FROM public.waiver_priorities WHERE member_id=f.member_ids[1];
    DELETE FROM public.league_members WHERE id=f.member_ids[1];
    PERFORM public.submit_trade_offer_atomic(f.user_ids[1],v_request_id,f.member_ids[1],'propose',payload);
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM IS DISTINCT FROM 'Not authorized to act for this member.' THEN RAISE; END IF;
    denied := true;
  END;
  PERFORM pg_temp.check_rules(denied,'a removed member cannot replay the request');
  PERFORM pg_temp.check_rules(
    public.submit_trade_offer_atomic(f.user_ids[1],v_request_id,f.member_ids[1],'propose',payload) IS NOT DISTINCT FROM trade,
    'rejected attempts preserve the owner result');

  DELETE FROM private.request_receipts WHERE request_id=v_request_id;
  PERFORM pg_temp.reject_trade_receipt(f.user_ids[1],v_request_id,other_league.member_ids[1],payload,
    'Not authorized to replay this trade request.','the trade receipt preserves original membership ownership');
  UPDATE public.league_members SET user_id=replacement WHERE id=f.member_ids[1];
  PERFORM pg_temp.reject_trade_receipt(f.user_ids[1],v_request_id,f.member_ids[1],payload,
    'Not authorized to act for this member.','the trade receipt also rejects the former owner');
  UPDATE public.league_members SET user_id=f.user_ids[1] WHERE id=f.member_ids[1];
  PERFORM pg_temp.check_rules(
    public.submit_trade_offer_atomic(f.user_ids[1],v_request_id,f.member_ids[1],'propose',payload) IS NOT DISTINCT FROM trade,
    'the owner also replays the trade receipt');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.trades WHERE league_id=f.league_id),
    'replays create no additional trades');
END;
$$;
SELECT count(*) AS trade_receipt_checks FROM rules_checks;
ROLLBACK;
