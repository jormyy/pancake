BEGIN;
\ir rules-support.sql

DO $$
DECLARE
  f record;
  g record;
  p1 uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid();
  p4 uuid := gen_random_uuid();
  p5 uuid := gen_random_uuid();
  c1 uuid := gen_random_uuid();
  c2 uuid := gen_random_uuid();
  x1 uuid := gen_random_uuid();
  y1 uuid := gen_random_uuid();
  over_trade uuid;
  last_trade uuid;
  neutral_trade uuid;
  stale_trade uuid;
  self_trade uuid;
  two_team uuid;
  items jsonb;
  opening_balance int;
  team1_balance int;
  team2_balance int;
  team3_transactions bigint;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3, 9601);
  SELECT * INTO g FROM pg_temp.rules_fixture(2, 9602);
  UPDATE public.leagues
     SET roster_size = 2, ir_slots = 0, taxi_slots = 0,
         trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id IN (f.league_id, g.league_id);
  UPDATE public.leagues SET roster_size = 1 WHERE id = g.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Scoped', id::text, 'PG', ARRAY['PG']
      FROM unnest(ARRAY[p1, p2, p3, p4, p5, c1, c2, x1, y1]) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES (f.league_id, f.season_id, f.member_ids[1], p1, 'verification'),
           (f.league_id, f.season_id, f.member_ids[1], p2, 'verification'),
           (f.league_id, f.season_id, f.member_ids[3], c1, 'verification'),
           (f.league_id, f.season_id, f.member_ids[3], c2, 'verification'),
           (g.league_id, g.season_id, g.member_ids[1], x1, 'verification'),
           (g.league_id, g.season_id, g.member_ids[2], y1, 'verification');
  PERFORM pg_temp.check_rules(
    (SELECT count(*) = 2 FROM public.roster_players
      WHERE league_id = f.league_id AND member_id = f.member_ids[3]),
    'the third team starts at the roster limit');

  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[3], 'playerId', p1),
    jsonb_build_object('fromMemberId', f.member_ids[3], 'toMemberId', f.member_ids[2], 'faabAmount', 10),
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[1], 'faabAmount', 10));
  opening_balance := private.available_faab_balance(f.league_id, f.season_id, f.member_ids[3]);
  over_trade := public.propose_multi_team_trade_atomic(
    f.league_id, f.season_id, f.member_ids[1], ARRAY[f.member_ids[2], f.member_ids[3]], items);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'pending' FROM public.trades WHERE id = over_trade)
    AND (SELECT accepted_at IS NOT NULL FROM public.trade_participants
          WHERE trade_id = over_trade AND member_id = f.member_ids[1]),
    'the proposer accepts and the multi-team offer stays pending');

  PERFORM public.accept_trade_atomic(over_trade, f.member_ids[2]);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'pending' FROM public.trades WHERE id = over_trade)
    AND (SELECT accepted_at IS NOT NULL FROM public.trade_participants
          WHERE trade_id = over_trade AND member_id = f.member_ids[2]),
    'a legal partial acceptance succeeds while another team is full');
  PERFORM pg_temp.check_rules(
    (SELECT accepted_at IS NULL FROM public.trade_participants
      WHERE trade_id = over_trade AND member_id = f.member_ids[3]),
    'partial acceptance leaves the full team waiting');
  PERFORM pg_temp.check_rules(
    (SELECT count(*) = 2 FROM public.roster_players
      WHERE league_id = f.league_id AND member_id = f.member_ids[3]),
    'partial acceptance moves nothing');

  PERFORM pg_temp.reject_rules(
    format('SELECT public.accept_trade_atomic(%L,%L)', over_trade, f.member_ids[3]),
    '%Rules team 3: Regular roster is 1 over the limit%',
    'the last acceptance rejects a final roster over the limit and names the team');
  PERFORM pg_temp.check_rules(
    (SELECT status = 'pending' FROM public.trades WHERE id = over_trade)
    AND (SELECT accepted_at IS NULL FROM public.trade_participants
          WHERE trade_id = over_trade AND member_id = f.member_ids[3]),
    'a rejected final acceptance preserves state');

  PERFORM public.set_trade_roster_plan_atomic(
    over_trade, f.member_ids[3], f.user_ids[3], '{}', '{}', ARRAY[c1]);
  PERFORM public.accept_trade_atomic(over_trade, f.member_ids[3]);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'accepted' FROM public.trades WHERE id = over_trade),
    'a drop plan lets the full team complete its own acceptance');

  PERFORM public.complete_accepted_trade_atomic(over_trade);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'completed' FROM public.trades WHERE id = over_trade),
    'the trade completes after every team accepted');
  PERFORM pg_temp.check_rules(
    (SELECT member_id = f.member_ids[3] FROM public.roster_players
      WHERE league_id = f.league_id AND league_season_id = f.season_id AND player_id = p1)
    AND NOT EXISTS (SELECT 1 FROM public.roster_players
      WHERE league_id = f.league_id AND league_season_id = f.season_id AND player_id = c1),
    'completion transfers the player and applies the planned drop');
  PERFORM pg_temp.check_rules(
    private.available_faab_balance(f.league_id, f.season_id, f.member_ids[3]) = opening_balance - 10,
    'completion transfers the planned FAAB');

  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES (f.league_id, f.season_id, f.member_ids[1], p3, 'verification');
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[3], 'playerId', p2),
    jsonb_build_object('fromMemberId', f.member_ids[3], 'toMemberId', f.member_ids[2], 'faabAmount', 5),
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[1], 'faabAmount', 5));
  last_trade := public.propose_multi_team_trade_atomic(
    f.league_id, f.season_id, f.member_ids[1], ARRAY[f.member_ids[2], f.member_ids[3]], items);
  PERFORM public.accept_trade_with_plan_atomic(
    last_trade, f.member_ids[3], f.user_ids[3], '{}', '{}', ARRAY[c2]);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'pending' FROM public.trades WHERE id = last_trade)
    AND (SELECT accepted_at IS NOT NULL FROM public.trade_participants
          WHERE trade_id = last_trade AND member_id = f.member_ids[3])
    AND (SELECT accepted_at IS NULL FROM public.trade_participants
          WHERE trade_id = last_trade AND member_id = f.member_ids[2]),
    'the full team accepts first through the plan call');
  PERFORM public.accept_trade_atomic(last_trade, f.member_ids[2]);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'accepted' FROM public.trades WHERE id = last_trade),
    'the last accepting team completes the acceptance after the full team settled');
  PERFORM public.complete_accepted_trade_atomic(last_trade);
  PERFORM pg_temp.check_rules(
    (SELECT member_id = f.member_ids[3] FROM public.roster_players
      WHERE league_id = f.league_id AND league_season_id = f.season_id AND player_id = p2)
    AND NOT EXISTS (SELECT 1 FROM public.roster_players
      WHERE league_id = f.league_id AND league_season_id = f.season_id AND player_id = c2),
    'the reverse acceptance order settles the full roster at completion');

  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[3], 'playerId', p3),
    jsonb_build_object('fromMemberId', f.member_ids[3], 'toMemberId', f.member_ids[1], 'playerId', p1),
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[1], 'faabAmount', 1),
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[2], 'faabAmount', 1));
  neutral_trade := public.propose_multi_team_trade_atomic(
    f.league_id, f.season_id, f.member_ids[1], ARRAY[f.member_ids[2], f.member_ids[3]], items);
  PERFORM public.accept_trade_atomic(neutral_trade, f.member_ids[2]);
  PERFORM pg_temp.check_rules(
    (SELECT accepted_at IS NOT NULL FROM public.trade_participants
      WHERE trade_id = neutral_trade AND member_id = f.member_ids[2]),
    'a net-neutral full roster does not block another team');
  PERFORM public.accept_trade_atomic(neutral_trade, f.member_ids[3]);
  PERFORM public.complete_accepted_trade_atomic(neutral_trade);
  PERFORM pg_temp.check_rules(
    (SELECT member_id = f.member_ids[3] FROM public.roster_players
      WHERE league_id = f.league_id AND league_season_id = f.season_id AND player_id = p3)
    AND (SELECT member_id = f.member_ids[1] FROM public.roster_players
      WHERE league_id = f.league_id AND league_season_id = f.season_id AND player_id = p1)
    AND (SELECT count(*) = 2 FROM public.roster_players
      WHERE league_id = f.league_id AND member_id = f.member_ids[3]),
    'a net-neutral full roster swaps players and stays at the limit');

  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[3], 'playerId', p1),
    jsonb_build_object('fromMemberId', f.member_ids[3], 'toMemberId', f.member_ids[2], 'faabAmount', 1),
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[1], 'faabAmount', 1));
  self_trade := public.propose_multi_team_trade_atomic(
    f.league_id, f.season_id, f.member_ids[1], ARRAY[f.member_ids[2], f.member_ids[3]], items);
  PERFORM pg_temp.reject_rules(
    format('SELECT public.accept_trade_atomic(%L,%L)', self_trade, f.member_ids[3]),
    '%Rules team 3: Regular roster is 1 over the limit%',
    'partial acceptance still rejects the accepting team over the limit');
  PERFORM public.accept_trade_atomic(self_trade, f.member_ids[2]);
  PERFORM public.set_trade_roster_plan_atomic(
    self_trade, f.member_ids[3], f.user_ids[3], '{}', '{}', ARRAY[p2]);
  PERFORM public.accept_trade_atomic(self_trade, f.member_ids[3]);
  PERFORM pg_temp.check_rules(
    (SELECT status = 'accepted' FROM public.trades WHERE id = self_trade),
    'the accepting team can settle its own roster and accept');

  two_team := public.propose_trade_atomic(
    g.league_id, g.season_id, g.member_ids[1], g.member_ids[2],
    ARRAY[x1], '{}', '{}', '{}', NULL, NULL, 0, 1);
  PERFORM pg_temp.reject_rules(
    format('SELECT public.accept_trade_atomic(%L,%L)', two_team, g.member_ids[2]),
    '%Rules team 2: Regular roster is 1 over the limit%',
    'two-team acceptance still rejects an over-limit final roster');

  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES (f.league_id, f.season_id, f.member_ids[1], p4, 'verification');
  items := jsonb_build_array(
    jsonb_build_object('fromMemberId', f.member_ids[1], 'toMemberId', f.member_ids[3], 'playerId', p4),
    jsonb_build_object('fromMemberId', f.member_ids[3], 'toMemberId', f.member_ids[2], 'faabAmount', 3),
    jsonb_build_object('fromMemberId', f.member_ids[2], 'toMemberId', f.member_ids[1], 'faabAmount', 3));
  stale_trade := public.propose_multi_team_trade_atomic(
    f.league_id, f.season_id, f.member_ids[1], ARRAY[f.member_ids[2], f.member_ids[3]], items);
  PERFORM public.accept_trade_atomic(stale_trade, f.member_ids[2]);
  PERFORM public.set_trade_roster_plan_atomic(
    stale_trade, f.member_ids[3], f.user_ids[3], '{}', '{}', ARRAY[p3]);
  PERFORM public.accept_trade_atomic(stale_trade, f.member_ids[3]);
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES (f.league_id, f.season_id, f.member_ids[3], p5, 'verification');
  team1_balance := private.available_faab_balance(f.league_id, f.season_id, f.member_ids[1]);
  team2_balance := private.available_faab_balance(f.league_id, f.season_id, f.member_ids[2]);
  opening_balance := private.available_faab_balance(f.league_id, f.season_id, f.member_ids[3]);
  SELECT count(*) INTO team3_transactions
    FROM public.roster_transactions
   WHERE league_id = f.league_id AND member_id = f.member_ids[3]
     AND transaction_type::text LIKE '%trade%';
  PERFORM public.complete_accepted_trade_atomic(stale_trade);
  PERFORM pg_temp.check_rules(
    (SELECT completion_failure_reason LIKE '%Rules team 3: Regular roster is 1 over the limit%'
       FROM public.trades WHERE id = stale_trade),
    'completion reports the over-limit team by name and stops');
  PERFORM pg_temp.check_rules(
    (SELECT status = 'accepted' AND completed_at IS NULL FROM public.trades WHERE id = stale_trade)
    AND private.available_faab_balance(f.league_id, f.season_id, f.member_ids[1]) = team1_balance
    AND private.available_faab_balance(f.league_id, f.season_id, f.member_ids[2]) = team2_balance
    AND private.available_faab_balance(f.league_id, f.season_id, f.member_ids[3]) = opening_balance
    AND (SELECT count(*) FROM public.roster_transactions
          WHERE league_id = f.league_id AND member_id = f.member_ids[3]
            AND transaction_type::text LIKE '%trade%') = team3_transactions
    AND EXISTS (SELECT 1 FROM public.roster_players
      WHERE league_id = f.league_id AND league_season_id = f.season_id
        AND player_id = p3 AND member_id = f.member_ids[3])
    AND EXISTS (SELECT 1 FROM public.roster_players
      WHERE league_id = f.league_id AND league_season_id = f.season_id
        AND player_id = p4 AND member_id = f.member_ids[1]),
    'a failed completion applies no roster move, drop or FAAB transfer');
END;
$$;

SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
