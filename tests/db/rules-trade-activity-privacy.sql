BEGIN;
\ir rules-support.sql

CREATE TEMP TABLE rules_activity_fixture AS SELECT * FROM pg_temp.rules_fixture(3, 9372);
CREATE TEMP TABLE rules_activity_trades(label text PRIMARY KEY, trade_id uuid NOT NULL);
GRANT SELECT ON rules_activity_fixture, rules_activity_trades TO authenticated;

DO $$
DECLARE
  v_fixture record;
  v_player uuid := gen_random_uuid();
  v_trade uuid;
  v_event text;
BEGIN
  SELECT * INTO v_fixture FROM rules_activity_fixture;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, nba_id, nba_team)
  VALUES(v_player, 'Private', 'Asset', 'PG', ARRAY['PG'], 'private-' || v_player::text, 'BOS');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
  VALUES(v_fixture.league_id, v_fixture.season_id, v_fixture.member_ids[1], v_player, 'draft');

  v_trade := public.propose_trade_atomic(v_fixture.league_id, v_fixture.season_id,
    v_fixture.member_ids[1], v_fixture.member_ids[2], '{}', '{}', '{}', '{}', NULL, NULL, 1, 1);
  INSERT INTO rules_activity_trades VALUES('scheduled expiry', v_trade);
  FOREACH v_event IN ARRAY ARRAY['trade_countered', 'trade_edited'] LOOP
    PERFORM private.log_league_activity(v_fixture.league_id, v_fixture.season_id, v_event, 'parties',
      'Private offer', NULL, v_fixture.member_ids[1], v_fixture.member_ids[2], NULL, v_trade);
  END LOOP;
  UPDATE public.trades SET expires_at = now() - interval '1 minute' WHERE id = v_trade;
  PERFORM public.expire_pending_trades_atomic(500);

  v_trade := public.propose_trade_atomic(v_fixture.league_id, v_fixture.season_id,
    v_fixture.member_ids[1], v_fixture.member_ids[2], ARRAY[v_player], '{}', '{}', '{}', NULL, NULL, 2, 2);
  INSERT INTO rules_activity_trades VALUES('lost asset', v_trade);
  PERFORM private.expire_pending_trades_for_lost_asset(v_fixture.league_id, v_fixture.member_ids[1], v_player);

  v_trade := public.propose_trade_atomic(v_fixture.league_id, v_fixture.season_id,
    v_fixture.member_ids[1], v_fixture.member_ids[2], '{}', '{}', '{}', '{}', NULL, NULL, 3, 3);
  INSERT INTO rules_activity_trades VALUES('rejected', v_trade);
  PERFORM public.reject_trade_atomic(v_trade, v_fixture.member_ids[2], v_fixture.user_ids[2]);

  v_trade := public.propose_trade_atomic(v_fixture.league_id, v_fixture.season_id,
    v_fixture.member_ids[1], v_fixture.member_ids[2], '{}', '{}', '{}', '{}', NULL, NULL, 4, 4);
  INSERT INTO rules_activity_trades VALUES('withdrawn', v_trade);
  PERFORM public.withdraw_trade_atomic(v_trade, v_fixture.member_ids[1], v_fixture.user_ids[1]);

  v_trade := public.propose_trade_atomic(v_fixture.league_id, v_fixture.season_id,
    v_fixture.member_ids[1], v_fixture.member_ids[2], '{}', '{}', '{}', '{}', NULL, NULL, 5, 5);
  INSERT INTO rules_activity_trades VALUES('completed', v_trade);
  PERFORM public.accept_trade_atomic(v_trade, v_fixture.member_ids[2]);
  UPDATE public.trades SET veto_window_expires_at = now() - interval '1 minute' WHERE id = v_trade;
  PERFORM public.complete_accepted_trade_atomic(v_trade);

  PERFORM pg_temp.check_rules((SELECT array_agg(DISTINCT trade.status::text ORDER BY trade.status::text)
      FROM rules_activity_trades fixture JOIN public.trades trade ON trade.id = fixture.trade_id)
      = ARRAY['completed', 'expired', 'rejected', 'withdrawn'],
    'fixture trades reach every terminal state');
  PERFORM pg_temp.check_rules((SELECT count(*) = 2 FROM public.league_activity activity
      JOIN rules_activity_trades fixture ON fixture.trade_id = activity.related_trade_id
      WHERE activity.event_type = 'trade_expired' AND fixture.label IN ('scheduled expiry', 'lost asset')),
    'scheduled and lost-asset expiry both record activity');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.league_activity
      WHERE league_id = v_fixture.league_id
        AND event_type IN ('trade_offered', 'trade_countered', 'trade_edited', 'trade_expired', 'trade_rejected', 'trade_withdrawn')
        AND visibility <> 'parties'),
    'every producer marks negotiation activity for the parties');

  PERFORM pg_temp.reject_rules(format($sql$INSERT INTO public.league_activity(league_id, event_type, visibility, title)
      VALUES(%L, 'trade_offered', 'league', 'Leaked offer')$sql$, v_fixture.league_id),
    '%league_activity_unsettled_trade_events_need_parties_visibility%',
    'a league-wide negotiation row fails its constraint');
  PERFORM pg_temp.reject_rules(format($sql$INSERT INTO public.league_activity(league_id, event_type, title)
      VALUES(%L, 'trade_new_kind', 'Unlabelled row')$sql$, v_fixture.league_id),
    '%"visibility"%',
    'a row without a visibility fails');
END;
$$;

SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_fixture record;
  v_index int;
  v_party boolean;
BEGIN
  SELECT * INTO v_fixture FROM rules_activity_fixture;
  FOR v_index IN 1..3 LOOP
    PERFORM set_config('request.jwt.claim.sub', v_fixture.user_ids[v_index]::text, true);
    v_party := v_index < 3;
    PERFORM pg_temp.check_rules((SELECT count(*) = CASE WHEN v_party THEN 11 ELSE 0 END FROM public.league_activity
      WHERE league_id = v_fixture.league_id
        AND event_type IN ('trade_offered', 'trade_countered', 'trade_edited', 'trade_expired', 'trade_rejected', 'trade_withdrawn')),
      'table negotiation privacy for member ' || v_index);
    PERFORM pg_temp.check_rules((SELECT count(*) = 0 FROM public.get_league_activity_feed(v_fixture.league_id, 100)
      WHERE transaction_type IN ('trade_offered', 'trade_countered', 'trade_edited', 'trade_expired', 'trade_rejected', 'trade_withdrawn')),
      'feed negotiation privacy for member ' || v_index);
    PERFORM pg_temp.check_rules((SELECT count(*) = 1 FROM public.league_activity
      WHERE league_id = v_fixture.league_id AND event_type = 'trade_completed'),
      'completed trade table activity remains public for member ' || v_index);
    PERFORM pg_temp.check_rules((SELECT count(*) = 1 FROM public.get_league_activity_feed(v_fixture.league_id, 100)
      WHERE transaction_type = 'trade_completed'),
      'completed trade feed activity remains public for member ' || v_index);
  END LOOP;
END;
$$;
RESET ROLE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
