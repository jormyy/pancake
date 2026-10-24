BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  offer uuid;
  stale uuid;
  current_offer uuid;
  next_season uuid;
  index int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3, 9383, 'playoffs');
  offer := public.propose_trade_atomic(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2],
    '{}', '{}', '{}', '{}', NULL, NULL, 1, 1);
  SELECT new_season_id INTO next_season FROM public.advance_season_atomic(f.league_id);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.trades WHERE id = offer AND status = 'expired'
    AND completion_failure_reason = 'The season rolled over before this offer was accepted.'),
    'rollover expires old pending offers with a clear reason');
  PERFORM pg_temp.check_rules((SELECT count(*) = 2 FROM public.notification_outbox
    WHERE event_type = 'trade_expired' AND data->>'tradeId' = offer::text),
    'rollover expiry notifies both parties');
  INSERT INTO public.trades(league_id, league_season_id, proposer_member_id, recipient_member_id)
  VALUES(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2]) RETURNING id INTO stale;
  INSERT INTO public.trade_participants(trade_id, member_id, sort_order, is_initiator, accepted_at)
  VALUES(stale, f.member_ids[1], 0, true, now()), (stale, f.member_ids[2], 1, false, NULL);
  current_offer := public.propose_trade_atomic(f.league_id, next_season, f.member_ids[1], f.member_ids[2],
    '{}', '{}', '{}', '{}', NULL, NULL, 1, 1);
  FOR index IN 1..2 LOOP
    PERFORM set_config('request.jwt.claim.sub', f.user_ids[index]::text, true);
    PERFORM pg_temp.check_rules((SELECT array_agg(trade_id) = ARRAY[current_offer]
      FROM public.get_trade_page_refs(f.member_ids[index], f.league_id)),
      'offer pages exclude historical pending trades for party ' || index);
  END LOOP;
  PERFORM pg_temp.check_rules(public.get_pending_trade_count(f.member_ids[2], f.league_id) = 1,
    'the pending badge excludes historical pending trades');
  PERFORM private.begin_trade_lifecycle_write();
  UPDATE public.trades SET status = 'accepted', accepted_at = now(), veto_window_expires_at = now() + interval '1 day'
  WHERE id = stale;
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[3]::text, true);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.get_trade_page_refs(f.member_ids[3], f.league_id)),
    'observer actions exclude historical accepted trades');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
