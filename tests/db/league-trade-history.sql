BEGIN;
\ir rules-support.sql

CREATE TEMP TABLE history_fixture AS SELECT * FROM pg_temp.rules_fixture(3, 9381);
CREATE TEMP TABLE history_trades(label text PRIMARY KEY, trade_id uuid);
GRANT SELECT ON history_fixture, history_trades TO authenticated;

DO $$
DECLARE
  f record;
  v_trade uuid;
  label text;
  amount int := 1;
BEGIN
  SELECT * INTO f FROM history_fixture;
  FOREACH label IN ARRAY ARRAY['pending', 'accepted', 'completed', 'rejected', 'vetoed'] LOOP
    v_trade := public.propose_trade_atomic(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2],
      '{}', '{}', '{}', '{}', NULL, NULL, amount, amount);
    amount := amount + 1;
    INSERT INTO history_trades VALUES (label, v_trade);
    IF label IN ('accepted', 'completed') THEN PERFORM public.accept_trade_atomic(v_trade, f.member_ids[2]); END IF;
    IF label = 'completed' THEN
      UPDATE public.trades SET veto_window_expires_at = now() - interval '1 minute' WHERE trades.id = v_trade;
      PERFORM public.complete_accepted_trade_atomic(v_trade);
    END IF;
    IF label IN ('rejected', 'vetoed') THEN UPDATE public.trades SET status = label::public.trade_status WHERE trades.id = v_trade; END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION pg_temp.history_labels(p_member int) RETURNS text[] LANGUAGE sql AS $$
  SELECT COALESCE(array_agg(t.label ORDER BY t.label), '{}')
  FROM history_fixture f
  CROSS JOIN LATERAL jsonb_array_elements(public.view_trades(f.league_id, f.member_ids[p_member], '{"tab":"history"}')->'trades') card
  JOIN history_trades t ON t.trade_id = (card->>'id')::uuid
$$;

SET LOCAL ROLE authenticated;
DO $$
DECLARE
  f record;
BEGIN
  SELECT * INTO f FROM history_fixture;
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[3]::text, true);
  PERFORM pg_temp.check_rules(pg_temp.history_labels(3) = ARRAY['accepted', 'completed'], 'an uninvolved member sees accepted and completed trades');
  PERFORM pg_temp.check_rules((SELECT count(*) = 2 FROM public.trades WHERE league_id = f.league_id), 'an uninvolved member reads only accepted and completed rows');
  PERFORM pg_temp.check_rules((SELECT public.view_trade_details(f.league_id, f.member_ids[3],
    jsonb_build_object('tradeId', (SELECT trade_id FROM history_trades WHERE label = 'completed')))->'trade' <> 'null'::jsonb),
    'an uninvolved member opens a completed trade');
  PERFORM pg_temp.check_rules((SELECT count(*) = 0 FROM public.league_activity WHERE league_id = f.league_id AND event_type = 'trade_offered'),
    'an uninvolved member cannot read offer events');
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  PERFORM pg_temp.check_rules(pg_temp.history_labels(1) = ARRAY['accepted', 'completed', 'rejected', 'vetoed'], 'a party still sees its own closed trades');
END;
$$;
RESET ROLE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
