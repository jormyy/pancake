BEGIN;
\ir rules-support.sql

CREATE TEMP TABLE replay_steps (seq serial PRIMARY KEY, path text, step text, outcome text);

CREATE FUNCTION pg_temp.replay_step(p_path text, p_step text, p_command text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_outcome text := 'done';
BEGIN
  BEGIN
    EXECUTE 'SET CONSTRAINTS check_accepted_trade_capacity IMMEDIATE';
    EXECUTE p_command;
    EXECUTE 'SET CONSTRAINTS check_accepted_trade_capacity DEFERRED';
  EXCEPTION WHEN OTHERS THEN
    v_outcome := 'refused: ' || SQLERRM;
  END;
  INSERT INTO replay_steps(path, step, outcome) VALUES (p_path, p_step, v_outcome);
END;
$$;

CREATE FUNCTION pg_temp.replay_league(p_teams int, p_year int)
RETURNS TABLE(league_id uuid, season_id uuid, member_ids uuid[], holder_user uuid, players uuid[])
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  f record;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(p_teams, p_year);
  UPDATE public.leagues
     SET roster_size = 2, ir_slots = 0, taxi_slots = 0, waiver_mode = 'faab',
         faab_starting_budget = 100, trade_veto_mode = 'disabled', trade_veto_window_hours = 0,
         allow_inactive_trades = true
   WHERE id = f.league_id;
  INSERT INTO public.faab_balances(league_id, league_season_id, member_id, balance)
    SELECT f.league_id, f.season_id, member_id, 100 FROM unnest(f.member_ids) member_id
    ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET balance = 100;
  SELECT array_agg(gen_random_uuid()) INTO players FROM generate_series(1, p_teams + 1);
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Replay', id::text, 'PG', ARRAY['PG'] FROM unnest(players) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    SELECT f.league_id, f.season_id, f.member_ids[i], players[i], 'verification' FROM generate_series(1, p_teams) i;
  league_id := f.league_id;
  season_id := f.season_id;
  member_ids := f.member_ids;
  holder_user := f.user_ids[1];
  RETURN NEXT;
END;
$$;

DO $$
DECLARE
  r record;
  v_trade uuid;
  v_claim uuid;
BEGIN
  SELECT * INTO r FROM pg_temp.replay_league(2, 9741);
  INSERT INTO public.waiver_wire_log(league_id, league_season_id, player_id, placed_on_waivers_at)
    VALUES (r.league_id, r.season_id, r.players[3], now() - interval '5 days');
  v_claim := public.create_waiver_claim_atomic(r.league_id, r.member_ids[1], r.players[3], NULL, r.holder_user, 10, 1);
  UPDATE public.waiver_claims SET process_date = (now() AT TIME ZONE 'America/Los_Angeles')::date - 1 WHERE id = v_claim;
  INSERT INTO replay_steps(path, step, outcome) VALUES ('claim then offer', 'the team enters a waiver claim with no drop, roster 1 of 2', 'done');
  v_trade := public.propose_trade_atomic(r.league_id, r.season_id, r.member_ids[1], r.member_ids[2],
    '{}'::uuid[], ARRAY[r.players[2]], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 5, 0);
  INSERT INTO replay_steps(path, step, outcome) VALUES ('claim then offer', 'the team offers a trade that brings in one player', 'done');
  PERFORM pg_temp.replay_step('claim then offer', 'waivers run',
    format('SELECT public.process_next_waiver_claim_atomic(%L::date)', (now() AT TIME ZONE 'America/Los_Angeles')::date));
  PERFORM pg_temp.replay_step('claim then offer', 'the partner says yes',
    format('SELECT public.accept_trade_atomic(%L,%L)', v_trade, r.member_ids[2]));
  INSERT INTO replay_steps(path, step, outcome)
    SELECT 'claim then offer', 'result',
      format('roster %s of 2, claim %s, offer %s',
        (SELECT count(*) FROM public.roster_players WHERE league_id = r.league_id AND member_id = r.member_ids[1]),
        (SELECT status FROM public.waiver_claims WHERE id = v_claim),
        (SELECT status FROM public.trades WHERE id = v_trade));
END $$;

DO $$
DECLARE
  r record;
  v_first uuid;
  v_second uuid;
BEGIN
  SELECT * INTO r FROM pg_temp.replay_league(3, 9742);
  v_first := public.propose_trade_atomic(r.league_id, r.season_id, r.member_ids[1], r.member_ids[2],
    '{}'::uuid[], ARRAY[r.players[2]], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 5, 0);
  v_second := public.propose_trade_atomic(r.league_id, r.season_id, r.member_ids[1], r.member_ids[3],
    '{}'::uuid[], ARRAY[r.players[3]], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 5, 0);
  INSERT INTO replay_steps(path, step, outcome) VALUES ('two offers', 'the team sends two offers that each bring in one player, roster 1 of 2', 'done');
  PERFORM pg_temp.replay_step('two offers', 'the first partner says yes',
    format('SELECT public.accept_trade_atomic(%L,%L)', v_first, r.member_ids[2]));
  PERFORM pg_temp.replay_step('two offers', 'the second partner says yes',
    format('SELECT public.accept_trade_atomic(%L,%L)', v_second, r.member_ids[3]));
  INSERT INTO replay_steps(path, step, outcome)
    SELECT 'two offers', 'result',
      format('first offer %s, second offer %s',
        (SELECT status FROM public.trades WHERE id = v_first),
        (SELECT status FROM public.trades WHERE id = v_second));
END $$;

\pset footer off
SELECT path, step, outcome FROM replay_steps ORDER BY seq;

DO $$
BEGIN
  PERFORM pg_temp.check_rules(
    (SELECT outcome = 'roster 1 of 2, claim failed_roster, offer accepted' FROM replay_steps WHERE path = 'claim then offer' AND step = 'result'),
    'a claim entered before the offer fails when waivers run, and the partner''s yes completes the offer');
  PERFORM pg_temp.check_rules(
    (SELECT bool_and(outcome LIKE 'refused: %needs the roster spot this trade would use%') FROM replay_steps WHERE path = 'two offers' AND step LIKE '% partner says yes'),
    'neither offer becomes unanimous while it would leave no room for the other offer the team made');
  PERFORM pg_temp.check_rules(
    (SELECT outcome = 'first offer pending, second offer pending' FROM replay_steps WHERE path = 'two offers' AND step = 'result'),
    'both offers stay pending');
END $$;

SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
