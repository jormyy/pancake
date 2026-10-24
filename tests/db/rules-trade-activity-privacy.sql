BEGIN;
\ir rules-support.sql

CREATE TEMP TABLE rules_activity_fixture AS SELECT * FROM pg_temp.rules_fixture(3, 9372);
GRANT SELECT ON rules_activity_fixture TO authenticated;

DO $$
DECLARE
  v_fixture record;
  v_pending uuid;
  v_completed uuid;
  v_event text;
BEGIN
  SELECT * INTO v_fixture FROM rules_activity_fixture;
  v_pending := public.propose_trade_atomic(v_fixture.league_id, v_fixture.season_id,
    v_fixture.member_ids[1], v_fixture.member_ids[2], '{}', '{}', '{}', '{}', NULL, NULL, 1, 1);
  FOREACH v_event IN ARRAY ARRAY['trade_countered', 'trade_edited'] LOOP
    PERFORM private.log_league_activity(v_fixture.league_id, v_fixture.season_id, v_event,
      'Private offer', NULL, v_fixture.member_ids[1], v_fixture.member_ids[2], NULL, v_pending);
  END LOOP;
  v_completed := public.propose_trade_atomic(v_fixture.league_id, v_fixture.season_id,
    v_fixture.member_ids[1], v_fixture.member_ids[2], '{}', '{}', '{}', '{}', NULL, NULL, 2, 2);
  PERFORM public.accept_trade_atomic(v_completed, v_fixture.member_ids[2]);
  UPDATE public.trades SET veto_window_expires_at = now() - interval '1 minute' WHERE id = v_completed;
  PERFORM public.complete_accepted_trade_atomic(v_completed);
END;
$$;

SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_fixture record;
  v_index int;
  v_pending_count int;
BEGIN
  SELECT * INTO v_fixture FROM rules_activity_fixture;
  FOR v_index IN 1..3 LOOP
    PERFORM set_config('request.jwt.claim.sub', v_fixture.user_ids[v_index]::text, true);
    v_pending_count := CASE WHEN v_index < 3 THEN 4 ELSE 0 END;
    PERFORM pg_temp.check_rules((SELECT count(*) = v_pending_count FROM public.league_activity
      WHERE league_id = v_fixture.league_id AND event_type IN ('trade_offered', 'trade_countered', 'trade_edited')),
      'table offer privacy for member ' || v_index);
    PERFORM pg_temp.check_rules((SELECT count(*) = v_pending_count FROM public.get_league_activity_feed(v_fixture.league_id, 100)
      WHERE transaction_type IN ('trade_offered', 'trade_countered', 'trade_edited')),
      'feed offer privacy for member ' || v_index);
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
