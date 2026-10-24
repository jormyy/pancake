BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  offer uuid;
  result uuid;
  request uuid;
  action text;
  index int;
  payload jsonb;
  items jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3, 9385);
  UPDATE public.leagues SET allow_inactive_trades = true WHERE id = f.league_id;
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[2], 'faabAmount', 1),
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[3], 'faabAmount', 1));
  FOREACH action IN ARRAY ARRAY['edit', 'counter', 'edit-multi', 'counter-multi'] LOOP
    IF action LIKE '%-multi' THEN
      offer := public.propose_multi_team_trade_atomic(f.league_id, f.season_id, f.member_ids[1],
        f.member_ids[2:3], items, NULL, now() + interval '1 hour');
    ELSE
      offer := public.propose_trade_atomic(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2],
        '{}', '{}', '{}', '{}', NULL, now() + interval '1 hour', 1, 1);
    END IF;
    UPDATE public.trades SET expires_at = now() - interval '1 minute' WHERE id = offer;
    index := CASE WHEN action LIKE 'edit%' THEN 1 ELSE 2 END;
    request := gen_random_uuid();
    payload := jsonb_build_object('tradeId', offer, 'offerPlayerIds', '[]'::jsonb, 'requestPlayerIds', '[]'::jsonb,
      'offerPickIds', '[]'::jsonb, 'requestPickIds', '[]'::jsonb, 'offerFaabAmount', 1, 'requestFaabAmount', 1,
      'notes', NULL, 'expiresAt', NULL, 'recipientMemberId', f.member_ids[3 - index],
      'rosterPlan', jsonb_build_object('taxiPlayerIds', '[]'::jsonb, 'irPlayerIds', '[]'::jsonb, 'dropPlayerIds', '[]'::jsonb));
    IF action LIKE '%-multi' THEN
      payload := payload || jsonb_build_object('items', items,
        'participantMemberIds', ARRAY[f.member_ids[3 - index], f.member_ids[3]]);
    END IF;
    result := public.submit_trade_offer_atomic(f.user_ids[index], request, f.member_ids[index], action, payload);
    PERFORM pg_temp.check_rules(result IS NULL AND (SELECT status = 'expired' FROM public.trades WHERE id = offer),
      action || ' with the exact API plan payload preserves expiry');
    PERFORM pg_temp.check_rules(public.submit_trade_offer_atomic(f.user_ids[index], request,
      f.member_ids[index], action, payload) IS NULL, action || ' retry preserves the expired receipt');
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
