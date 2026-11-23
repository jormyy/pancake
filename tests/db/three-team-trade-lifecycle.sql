BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  a uuid; b uuid; c uuid;
  offer uuid;
  replacement uuid;
  result jsonb;
  route jsonb;
  party_rows int;
  outsider_rows int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(5, 9417);
  a := f.member_ids[1]; b := f.member_ids[2]; c := f.member_ids[3];
  UPDATE public.leagues SET trade_veto_mode = 'member_vote', trade_veto_window_hours = 24,
    trade_veto_threshold_percent = 50 WHERE id = f.league_id;
  route := jsonb_build_array(
    jsonb_build_object('fromMemberId', a, 'toMemberId', b, 'faabAmount', 1),
    jsonb_build_object('fromMemberId', b, 'toMemberId', c, 'faabAmount', 1),
    jsonb_build_object('fromMemberId', c, 'toMemberId', a, 'faabAmount', 1));

  offer := public.propose_multi_team_trade_atomic(f.league_id, f.season_id, a, ARRAY[b, c], route);
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[3]::text, true);
  SET LOCAL ROLE authenticated;
  SELECT (SELECT count(*) FROM public.trades WHERE id = offer) + (SELECT count(*) FROM public.trade_items WHERE trade_id = offer)
    INTO party_rows;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[4]::text, true);
  SET LOCAL ROLE authenticated;
  SELECT (SELECT count(*) FROM public.trades WHERE id = offer) + (SELECT count(*) FROM public.trade_items WHERE trade_id = offer)
    INTO outsider_rows;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_temp.check_rules(party_rows = 4 AND outsider_rows = 0,
    'the third team reads the pending offer and its items, and a team outside it reads neither');
  PERFORM public.accept_trade_atomic(offer, b);
  PERFORM pg_temp.check_rules((SELECT status = 'pending' FROM public.trades WHERE id = offer)
      AND (SELECT count(*) = 2 FROM public.trade_participants WHERE trade_id = offer AND accepted_at IS NOT NULL),
    'a partial accept keeps the trade pending for the third team');
  PERFORM public.reject_trade_atomic(offer, c, f.user_ids[3]);
  PERFORM pg_temp.check_rules((SELECT array_agg(member_id ORDER BY member_id) = (SELECT array_agg(id ORDER BY id) FROM unnest(ARRAY[a, b]) id)
      FROM public.notification_outbox WHERE event_type = 'trade_rejected' AND data->>'tradeId' = offer::text),
    'a third-team rejection tells the proposer and the team that accepted');

  offer := public.propose_multi_team_trade_atomic(f.league_id, f.season_id, a, ARRAY[b, c], route);
  PERFORM public.withdraw_trade_atomic(offer, a, f.user_ids[1]);
  PERFORM pg_temp.check_rules((SELECT array_agg(member_id ORDER BY member_id) = (SELECT array_agg(id ORDER BY id) FROM unnest(ARRAY[b, c]) id)
      FROM public.notification_outbox WHERE event_type = 'trade_withdrawn' AND data->>'tradeId' = offer::text),
    'a withdrawal tells both other teams');

  offer := public.propose_multi_team_trade_atomic(f.league_id, f.season_id, a, ARRAY[b, c], route);
  PERFORM pg_temp.reject_rules(format('SELECT private.replace_trade_offer(%L, %L, %L, %L, %L, %L, %L, %L)',
      offer, c, f.user_ids[3], 'counter', '{}', '{}', '{}', '{}'),
    'Use the multi-team action for this trade.', 'a two-team counter cannot replace a three-team offer');
  replacement := private.replace_multi_team_trade_offer(offer, c, f.user_ids[3], 'counter', ARRAY[a, b], route);
  PERFORM pg_temp.check_rules((SELECT status = 'countered' FROM public.trades WHERE id = offer)
      AND (SELECT proposer_member_id = c AND countered_from_trade_id = offer FROM public.trades WHERE id = replacement)
      AND (SELECT array_agg(member_id ORDER BY member_id) = (SELECT array_agg(id ORDER BY id) FROM unnest(ARRAY[a, b, c]) id)
        FROM public.trade_participants WHERE trade_id = replacement),
    'the third team counters through the participant path and keeps all three teams');

  PERFORM pg_temp.reject_rules(format('SELECT private.replace_trade_offer(%L, %L, %L, %L, %L, %L, %L, %L)',
      replacement, c, f.user_ids[3], 'edit', '{}', '{}', '{}', '{}'),
    'Use the multi-team action for this trade.', 'a two-team edit cannot replace a three-team offer');
  offer := private.replace_multi_team_trade_offer(replacement, c, f.user_ids[3], 'edit', ARRAY[a, b], route);
  PERFORM pg_temp.check_rules((SELECT status = 'edited' FROM public.trades WHERE id = replacement)
      AND (SELECT count(*) = 3 FROM public.trade_participants WHERE trade_id = offer),
    'an edit keeps all three teams');

  PERFORM public.accept_trade_atomic(offer, a);
  PERFORM public.accept_trade_atomic(offer, b);
  PERFORM pg_temp.check_rules((SELECT status = 'accepted' FROM public.trades WHERE id = offer),
    'the last accept opens the veto window');
  PERFORM pg_temp.reject_rules(format('SELECT public.veto_trade_atomic(%L, %L)', offer, b),
    'Trade parties cannot veto their own trade.', 'a party other than the first recipient cannot veto');
  result := public.veto_trade_atomic(offer, f.member_ids[4]);
  PERFORM pg_temp.check_rules((result->>'threshold')::int = 1 AND (result->>'vetoed')::boolean
      AND jsonb_array_length(result->'participantMemberIds') = 3,
    'only the two teams outside the trade count toward the veto threshold');
  PERFORM pg_temp.check_rules((SELECT array_agg(member_id ORDER BY member_id) = (SELECT array_agg(id ORDER BY id) FROM unnest(ARRAY[a, b, c]) id)
      FROM public.notification_outbox WHERE event_type = 'trade_vetoed' AND data->>'tradeId' = offer::text),
    'a veto tells all three teams');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
