BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  offer uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(4, 9390);
  offer := public.propose_multi_team_trade_atomic(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2:4],
    jsonb_build_array(
      jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[2], 'faabAmount', 1),
      jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[3], 'faabAmount', 1),
      jsonb_build_object('fromMemberId', f.member_ids[3], 'toMemberId', f.member_ids[4], 'faabAmount', 1)));
  PERFORM public.accept_trade_atomic(offer, f.member_ids[2]);
  PERFORM public.reject_trade_atomic(offer, f.member_ids[3], f.user_ids[3]);
  PERFORM pg_temp.check_rules((SELECT array_agg(member_id ORDER BY member_id) =
    (SELECT array_agg(id ORDER BY id) FROM unnest(f.member_ids[1:2]) id)
    FROM public.notification_outbox WHERE event_type = 'trade_rejected' AND data->>'tradeId' = offer::text),
    'rejection notifies the proposer and accepted participants only');
  PERFORM pg_temp.check_rules((SELECT count(*) = count(DISTINCT dedupe_key)
    FROM public.notification_outbox WHERE event_type = 'trade_rejected' AND data->>'tradeId' = offer::text),
    'rejection recipients each have one notification');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
