-- Roster lifecycle state-machine oracle.
--
-- Seeds two leagues (one user belongs to both), then runs a seeded random walk
-- of roster operations as managers, the commissioner, and the service role:
-- listings, drops (including stale retries and other people's rows), adds,
-- drop-and-add, IR and taxi moves, trade proposals, acceptance, completion,
-- rejection, waiver claims and processing, commissioner overrides, direct
-- service deletes, pick consumption and ownership changes, player merges,
-- cross-league attempts, lineup edits, and replays of the previous operation.
-- After every step it checks the invariants documented in docs/roster-lifecycle.md.
--
-- Seed selection: SET oracle.seed = '<integer>' before running (psql: -c, or
-- PGOPTIONS="-c oracle.seed=7"). Steps: SET oracle.steps = '<integer>' (default 320).
-- Runs inside one transaction and rolls back.
BEGIN;

CREATE FUNCTION pg_temp.oid(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT md5('roster-oracle:' || p)::uuid
$$;

DO $$
DECLARE v_seed bigint := COALESCE(NULLIF(current_setting('oracle.seed', true), ''), '1')::bigint;
BEGIN
  PERFORM setseed(((v_seed % 997)::float / 1000.0));
END $$;

-- Users -----------------------------------------------------------------
INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT pg_temp.oid('user-' || n), 'authenticated', 'authenticated', 'oracle-' || n || '@example.test', 'x', now(), '{}', '{}', now(), now()
  FROM generate_series(1, 3) AS n;
INSERT INTO public.profiles (id, username, display_name)
SELECT pg_temp.oid('user-' || n), 'oracle_user_' || n, 'Oracle User ' || n FROM generate_series(1, 3) AS n
ON CONFLICT (id) DO NOTHING;

-- Leagues, members, seasons -------------------------------------------------
INSERT INTO public.leagues (id, name, slug, commissioner_id, status, waiver_mode, weekly_add_limit, roster_size, ir_slots, taxi_slots)
VALUES
  (pg_temp.oid('league-1'), 'Oracle League One', 'oracle-league-one', pg_temp.oid('user-1'), 'active', 'faab', 3, 8, 1, 1),
  (pg_temp.oid('league-2'), 'Oracle League Two', 'oracle-league-two', pg_temp.oid('user-2'), 'active', 'rolling', 2, 6, 1, 1);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES
  (pg_temp.oid('member-A'), pg_temp.oid('league-1'), pg_temp.oid('user-1'), 'commissioner', 'Alpha'),
  (pg_temp.oid('member-B'), pg_temp.oid('league-1'), pg_temp.oid('user-2'), 'manager', 'Bravo'),
  (pg_temp.oid('member-C'), pg_temp.oid('league-1'), pg_temp.oid('user-3'), 'manager', 'Charlie'),
  (pg_temp.oid('member-A2'), pg_temp.oid('league-2'), pg_temp.oid('user-2'), 'commissioner', 'Second Alpha'),
  (pg_temp.oid('member-B2'), pg_temp.oid('league-2'), pg_temp.oid('user-1'), 'manager', 'Second Bravo');

INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES
  (pg_temp.oid('season-0'), pg_temp.oid('league-1'), 2097, false),
  (pg_temp.oid('season-1'), pg_temp.oid('league-1'), 2098, true),
  (pg_temp.oid('season-2'), pg_temp.oid('league-2'), 2098, true);

INSERT INTO public.season_weeks (season_year, week_number, week_start, week_end)
VALUES
  (2097, 1, (now() AT TIME ZONE 'America/New_York')::date - 40, (now() AT TIME ZONE 'America/New_York')::date - 34),
  (2098, 1, (now() AT TIME ZONE 'America/New_York')::date - 3, (now() AT TIME ZONE 'America/New_York')::date + 3),
  (2098, 2, (now() AT TIME ZONE 'America/New_York')::date + 4, (now() AT TIME ZONE 'America/New_York')::date + 10);

INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
VALUES
  (pg_temp.oid('league-1'), pg_temp.oid('season-1'), pg_temp.oid('member-A'), 1),
  (pg_temp.oid('league-1'), pg_temp.oid('season-1'), pg_temp.oid('member-B'), 2),
  (pg_temp.oid('league-1'), pg_temp.oid('season-1'), pg_temp.oid('member-C'), 3),
  (pg_temp.oid('league-2'), pg_temp.oid('season-2'), pg_temp.oid('member-A2'), 1),
  (pg_temp.oid('league-2'), pg_temp.oid('season-2'), pg_temp.oid('member-B2'), 2);

-- Players -----------------------------------------------------------------
INSERT INTO public.players (id, first_name, last_name, nba_team, position, years_exp, eligible_positions, injury_status, nba_draft_number)
SELECT
  pg_temp.oid('player-' || n),
  'Oracle',
  'Player ' || n,
  (ARRAY['ATL', 'BOS', 'DAL', 'DEN', 'LAL', 'MIA'])[1 + n % 6],
  (ARRAY['PG', 'SG', 'SF', 'PF', 'C'])[1 + n % 5]::nba_position,
  CASE WHEN n % 6 = 1 THEN 0 ELSE 2 + n % 5 END,
  ARRAY[(ARRAY['PG', 'SG', 'SF', 'PF', 'C'])[1 + n % 5]],
  CASE WHEN n % 6 = 2 THEN 'Out' ELSE NULL END,
  CASE WHEN n % 6 = 1 THEN n ELSE NULL END
  FROM generate_series(1, 40) AS n;

-- Rosters -----------------------------------------------------------------
INSERT INTO public.roster_players (id, league_id, league_season_id, member_id, player_id, acquired_via)
SELECT pg_temp.oid('roster-1-' || n), pg_temp.oid('league-1'), pg_temp.oid('season-1'),
       CASE WHEN n <= 6 THEN pg_temp.oid('member-A') WHEN n <= 12 THEN pg_temp.oid('member-B') ELSE pg_temp.oid('member-C') END,
       pg_temp.oid('player-' || n), 'draft'
  FROM generate_series(1, 18) AS n;
INSERT INTO public.roster_players (id, league_id, league_season_id, member_id, player_id, acquired_via)
SELECT pg_temp.oid('roster-0-' || n), pg_temp.oid('league-1'), pg_temp.oid('season-0'), pg_temp.oid('member-A'), pg_temp.oid('player-' || n), 'draft'
  FROM generate_series(1, 2) AS n;
INSERT INTO public.roster_players (id, league_id, league_season_id, member_id, player_id, acquired_via)
SELECT pg_temp.oid('roster-2-' || n), pg_temp.oid('league-2'), pg_temp.oid('season-2'),
       CASE WHEN n <= 24 THEN pg_temp.oid('member-A2') ELSE pg_temp.oid('member-B2') END,
       pg_temp.oid('player-' || n), 'draft'
  FROM generate_series(21, 28) AS n;

-- Waiver wire: one due player and one still clearing per league --------------
INSERT INTO public.waiver_wire_log (league_id, league_season_id, player_id, dropped_by_member_id, placed_on_waivers_at, clears_at)
VALUES
  (pg_temp.oid('league-1'), pg_temp.oid('season-1'), pg_temp.oid('player-19'), pg_temp.oid('member-C'), now() - interval '3 days', now() - interval '1 minute'),
  (pg_temp.oid('league-1'), pg_temp.oid('season-1'), pg_temp.oid('player-20'), pg_temp.oid('member-C'), now() - interval '1 hour', now() + interval '47 hours'),
  (pg_temp.oid('league-2'), pg_temp.oid('season-2'), pg_temp.oid('player-29'), pg_temp.oid('member-B2'), now() - interval '3 days', now() - interval '1 minute'),
  (pg_temp.oid('league-2'), pg_temp.oid('season-2'), pg_temp.oid('player-30'), pg_temp.oid('member-B2'), now() - interval '1 hour', now() + interval '47 hours');

-- One game already in progress today, so some lineup slots are locked ------------
INSERT INTO public.nba_games (sportsdata_game_id, season_year, game_date, week_number, home_team, away_team, status, started_at)
VALUES ('oracle-started-game', 2098, (now() AT TIME ZONE 'America/New_York')::date, 1, 'LAL', 'BOS', 'InProgress', now() - interval '1 hour');

-- Picks -------------------------------------------------------------------
INSERT INTO public.draft_picks (id, league_id, season_year, round, original_owner_id, current_owner_id)
SELECT pg_temp.oid('pick-' || member.key || '-' || round.n), member.league, 2100, round.n, member.id, member.id
  FROM (VALUES
    ('A', pg_temp.oid('member-A'), pg_temp.oid('league-1')),
    ('B', pg_temp.oid('member-B'), pg_temp.oid('league-1')),
    ('C', pg_temp.oid('member-C'), pg_temp.oid('league-1')),
    ('A2', pg_temp.oid('member-A2'), pg_temp.oid('league-2')),
    ('B2', pg_temp.oid('member-B2'), pg_temp.oid('league-2'))
  ) AS member(key, id, league)
  CROSS JOIN generate_series(1, 2) AS round(n);

-- Oracle state ---------------------------------------------------------------
CREATE TEMP TABLE oracle_log (
  step int,
  op text,
  actor text,
  detail text,
  outcome text,
  error text
);
CREATE TEMP TABLE oracle_dropped (roster_player_id uuid);
CREATE TEMP TABLE oracle_overrides (league_id uuid, member_id uuid);
CREATE TEMP TABLE oracle_history AS
SELECT
  (SELECT count(*) FROM public.roster_transactions) AS transactions,
  (SELECT count(*) FROM public.waiver_wire_log) AS waiver_logs,
  (SELECT count(*) FROM public.league_activity) AS activity;
CREATE TEMP TABLE oracle_terminal_claims (id uuid PRIMARY KEY, status text, drop_player_id uuid);
CREATE TEMP TABLE oracle_terminal_trades (id uuid PRIMARY KEY, status text);
CREATE TEMP TABLE oracle_last (sql text);

CREATE FUNCTION pg_temp.member_user(p_member uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT user_id FROM public.league_members WHERE id = p_member
$$;

CREATE FUNCTION pg_temp.act_as(p_user uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true)
$$;

CREATE FUNCTION pg_temp.random_member() RETURNS uuid LANGUAGE sql VOLATILE AS $$
  SELECT id FROM public.league_members WHERE id IN (
    pg_temp.oid('member-A'), pg_temp.oid('member-B'), pg_temp.oid('member-C'), pg_temp.oid('member-A2'), pg_temp.oid('member-B2')
  ) ORDER BY random() LIMIT 1
$$;

CREATE FUNCTION pg_temp.current_season(p_league uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM public.league_seasons WHERE league_id = p_league AND is_current LIMIT 1
$$;

-- Mirrors private.prevent_uncleared_waiver_free_agent_add: a player whose waiver
-- entry is not cleared yet must be claimed, not added.
CREATE FUNCTION pg_temp.on_waivers(p_league uuid, p_season uuid, p_player uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.waiver_wire_log log
                  WHERE log.league_id = p_league AND log.league_season_id = p_season AND log.player_id = p_player
                    AND log.cleared_at IS NULL)
$$;

-- Mirrors the reservation rule without calling private.is_reserved_trade_asset:
-- the guards (I6) only catch a reservation that is too narrow, so a too-broad
-- production predicate would go unnoticed if the expectation reused it. The
-- add-week helper below does call private.current_add_week because calendar
-- placement is not the rule under test, only the count against the limit is.
CREATE FUNCTION pg_temp.reserved_player(p_league uuid, p_season uuid, p_member uuid, p_player uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.trade_items ti JOIN public.trades t ON t.id = ti.trade_id
                  WHERE t.status = 'accepted' AND t.league_id = p_league AND t.league_season_id = p_season
                    AND ti.from_member_id = p_member AND ti.player_id = p_player)
$$;
CREATE FUNCTION pg_temp.reserved_row(p_roster uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT pg_temp.reserved_player(r.league_id, r.league_season_id, r.member_id, r.player_id)
                     FROM public.roster_players r WHERE r.id = p_roster), false)
$$;
CREATE FUNCTION pg_temp.reserved_pick(p_pick uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.draft_picks pick JOIN public.trade_items ti ON ti.pick_id = pick.id AND ti.from_member_id = pick.current_owner_id
                  JOIN public.trades t ON t.id = ti.trade_id AND t.status = 'accepted' AND t.league_id = pick.league_id
                 WHERE pick.id = p_pick)
$$;

-- Mirrors private.prevent_accepted_or_inactive_roster_move: a player named as a
-- pending claim's drop cannot leave the active roster.
CREATE FUNCTION pg_temp.pending_drop_row(p_roster uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.roster_players r JOIN public.waiver_claims c
                   ON c.member_id = r.member_id AND c.drop_player_id = r.player_id AND c.league_season_id = r.league_season_id
                WHERE r.id = p_roster AND c.status = 'pending')
$$;

-- Mirrors private.assert_weekly_add_available: an add past the limit must be rejected.
CREATE FUNCTION pg_temp.add_limit_reached(p_member uuid, p_league uuid, p_season uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT l.weekly_add_limit IS NOT NULL
     AND COALESCE((SELECT c.add_count FROM public.weekly_add_counts c
                    WHERE c.league_id = p_league AND c.league_season_id = p_season AND c.member_id = p_member
                      AND c.week_number = (SELECT week_number FROM private.current_add_week(p_league, p_season))), 0) >= l.weekly_add_limit
    FROM public.leagues l WHERE l.id = p_league
$$;

CREATE FUNCTION pg_temp.check_invariants(p_step int, p_op text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
  v_before oracle_history%ROWTYPE;
  v_after oracle_history%ROWTYPE;
  v_row record;
  v_tail text;
BEGIN
  SELECT string_agg(format('#%s %s by %s: %s -> %s %s', step, op, actor, detail, outcome, COALESCE(error, '')), E'\n' ORDER BY step)
    INTO v_tail
    FROM (SELECT * FROM oracle_log ORDER BY step DESC LIMIT 6) AS recent;

  -- I1: a player listing needs an active current-season roster row for that member.
  SELECT count(*) INTO v_count
    FROM public.trade_block_items AS item
   WHERE item.player_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.roster_players AS roster
         JOIN public.league_seasons AS season ON season.id = roster.league_season_id AND season.is_current
        WHERE roster.league_id = item.league_id AND roster.member_id = item.member_id AND roster.player_id = item.player_id
          AND roster.is_on_ir = false AND roster.is_on_taxi = false);
  IF v_count > 0 THEN RAISE EXCEPTION 'I1 violated after step % (%): % stale player listing(s)', p_step, p_op, v_count USING DETAIL = v_tail; END IF;

  -- I2: a pick listing needs an unused pick owned by that member.
  SELECT count(*) INTO v_count
    FROM public.trade_block_items AS item
   WHERE item.pick_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.draft_picks AS pick WHERE pick.id = item.pick_id AND pick.league_id = item.league_id AND pick.current_owner_id = item.member_id AND pick.is_used = false);
  IF v_count > 0 THEN RAISE EXCEPTION 'I2 violated after step % (%): % stale pick listing(s)', p_step, p_op, v_count USING DETAIL = v_tail; END IF;

  -- I3: future lineup slots belong to active roster players of that member,
  -- except slots whose game already started (clear_future_unlocked_lineups
  -- leaves those alone on purpose).
  SELECT count(*) INTO v_count
    FROM public.weekly_lineups AS lineup
   WHERE lineup.game_date >= (now() AT TIME ZONE 'America/New_York')::date
     AND NOT EXISTS (
       SELECT 1 FROM public.roster_players AS roster
        WHERE roster.league_id = lineup.league_id AND roster.league_season_id = lineup.league_season_id
          AND roster.member_id = lineup.member_id AND roster.player_id = lineup.player_id
          AND roster.is_on_ir = false AND roster.is_on_taxi = false)
     AND NOT private.lineup_game_started(lineup.player_id, lineup.game_date);
  IF v_count > 0 THEN RAISE EXCEPTION 'I3 violated after step % (%): % stale future lineup slot(s)', p_step, p_op, v_count USING DETAIL = v_tail; END IF;

  -- I4: a pending claim's drop player is on that member's active roster.
  SELECT count(*) INTO v_count
    FROM public.waiver_claims AS claim
   WHERE claim.status = 'pending' AND claim.drop_player_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.roster_players AS roster
        WHERE roster.league_id = claim.league_id AND roster.league_season_id = claim.league_season_id
          AND roster.member_id = claim.member_id AND roster.player_id = claim.drop_player_id
          AND roster.is_on_ir = false AND roster.is_on_taxi = false);
  IF v_count > 0 THEN RAISE EXCEPTION 'I4 violated after step % (%): % pending claim(s) with a stale drop', p_step, p_op, v_count USING DETAIL = v_tail; END IF;

  -- I5: pending offers only carry assets the offering side still holds.
  SELECT count(*) INTO v_count
    FROM public.trades AS trade JOIN public.trade_items AS item ON item.trade_id = trade.id
   WHERE trade.status = 'pending'
     AND ((item.player_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.roster_players AS roster
             WHERE roster.league_id = trade.league_id AND roster.league_season_id = trade.league_season_id
               AND roster.member_id = item.from_member_id AND roster.player_id = item.player_id))
       OR (item.pick_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.draft_picks AS pick
             WHERE pick.id = item.pick_id AND pick.current_owner_id = item.from_member_id AND pick.is_used = false)));
  IF v_count > 0 THEN RAISE EXCEPTION 'I5 violated after step % (%): % pending offer item(s) with a lost asset', p_step, p_op, v_count USING DETAIL = v_tail; END IF;

  -- I6: accepted trades keep their reserved assets active and owned.
  SELECT count(*) INTO v_count
    FROM public.trades AS trade JOIN public.trade_items AS item ON item.trade_id = trade.id
   WHERE trade.status = 'accepted'
     AND ((item.player_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.roster_players AS roster
             WHERE roster.league_id = trade.league_id AND roster.league_season_id = trade.league_season_id
               AND roster.member_id = item.from_member_id AND roster.player_id = item.player_id
               AND roster.is_on_ir = false AND roster.is_on_taxi = false))
       OR (item.pick_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.draft_picks AS pick
             WHERE pick.id = item.pick_id AND pick.current_owner_id = item.from_member_id AND pick.is_used = false)));
  IF v_count > 0 THEN RAISE EXCEPTION 'I6 violated after step % (%): % accepted trade item(s) lost their reservation', p_step, p_op, v_count USING DETAIL = v_tail; END IF;

  -- I7: roster flags are exclusive and members match their league.
  SELECT count(*) INTO v_count FROM public.roster_players WHERE is_on_ir AND is_on_taxi;
  IF v_count > 0 THEN RAISE EXCEPTION 'I7 violated after step % (%): % row(s) both IR and taxi', p_step, p_op, v_count USING DETAIL = v_tail; END IF;
  SELECT count(*) INTO v_count
    FROM public.roster_players AS roster JOIN public.league_members AS member ON member.id = roster.member_id
   WHERE member.league_id <> roster.league_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'I7 violated after step % (%): % roster row(s) in a foreign league', p_step, p_op, v_count USING DETAIL = v_tail; END IF;
  SELECT count(*) INTO v_count
    FROM public.trade_block_items AS item JOIN public.league_members AS member ON member.id = item.member_id
   WHERE member.league_id <> item.league_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'I7 violated after step % (%): % listing(s) in a foreign league', p_step, p_op, v_count USING DETAIL = v_tail; END IF;

  -- I8: history only grows; terminal claims and trades never change.
  SELECT * INTO v_before FROM oracle_history;
  SELECT (SELECT count(*) FROM public.roster_transactions), (SELECT count(*) FROM public.waiver_wire_log), (SELECT count(*) FROM public.league_activity) INTO v_after;
  IF v_after.transactions < v_before.transactions OR v_after.waiver_logs < v_before.waiver_logs OR v_after.activity < v_before.activity THEN
    RAISE EXCEPTION 'I8 violated after step % (%): history shrank (% -> %, % -> %, % -> %)', p_step, p_op,
      v_before.transactions, v_after.transactions, v_before.waiver_logs, v_after.waiver_logs, v_before.activity, v_after.activity USING DETAIL = v_tail;
  END IF;
  UPDATE oracle_history SET transactions = v_after.transactions, waiver_logs = v_after.waiver_logs, activity = v_after.activity;
  FOR v_row IN SELECT t.id, t.status AS remembered, t.drop_player_id AS remembered_drop, c.status, c.drop_player_id
                 FROM oracle_terminal_claims AS t JOIN public.waiver_claims AS c ON c.id = t.id
  LOOP
    IF v_row.status::text <> v_row.remembered OR v_row.drop_player_id IS DISTINCT FROM v_row.remembered_drop THEN
      RAISE EXCEPTION 'I8 violated after step % (%): terminal claim % changed (% -> %)', p_step, p_op, v_row.id, v_row.remembered, v_row.status USING DETAIL = v_tail;
    END IF;
  END LOOP;
  INSERT INTO oracle_terminal_claims (id, status, drop_player_id)
  SELECT id, status::text, drop_player_id FROM public.waiver_claims WHERE status <> 'pending'
  ON CONFLICT (id) DO NOTHING;
  FOR v_row IN SELECT t.id, t.status AS remembered, tr.status
                 FROM oracle_terminal_trades AS t JOIN public.trades AS tr ON tr.id = t.id
  LOOP
    IF v_row.status::text <> v_row.remembered THEN
      RAISE EXCEPTION 'I8 violated after step % (%): terminal trade % changed (% -> %)', p_step, p_op, v_row.id, v_row.remembered, v_row.status USING DETAIL = v_tail;
    END IF;
  END LOOP;
  INSERT INTO oracle_terminal_trades (id, status)
  SELECT id, status::text FROM public.trades WHERE status NOT IN ('pending', 'accepted')
  ON CONFLICT (id) DO NOTHING;

  -- I9: weekly add counts respect the limit unless a commissioner override set them.
  SELECT count(*) INTO v_count
    FROM public.weekly_add_counts AS counts JOIN public.leagues AS league ON league.id = counts.league_id
   WHERE league.weekly_add_limit IS NOT NULL AND counts.add_count > league.weekly_add_limit
     AND NOT EXISTS (SELECT 1 FROM oracle_overrides AS o WHERE o.league_id = counts.league_id AND o.member_id = counts.member_id);
  IF v_count > 0 THEN RAISE EXCEPTION 'I9 violated after step % (%): % add count(s) above the limit', p_step, p_op, v_count USING DETAIL = v_tail; END IF;

  -- I10: a player still clearing waivers is on nobody's roster in that season.
  SELECT count(*) INTO v_count
    FROM public.waiver_wire_log AS log JOIN public.roster_players AS roster
      ON roster.league_id = log.league_id AND roster.league_season_id = log.league_season_id AND roster.player_id = log.player_id
   WHERE log.cleared_at IS NULL AND log.clears_at > now();
  IF v_count > 0 THEN RAISE EXCEPTION 'I10 violated after step % (%): % rostered player(s) still on waivers', p_step, p_op, v_count USING DETAIL = v_tail; END IF;
END;
$$;

DO $$
DECLARE
  v_steps int := COALESCE(NULLIF(current_setting('oracle.steps', true), ''), '320')::int;
  v_step int;
  v_roll float;
  v_op text;
  v_sql text;
  v_actor text;
  v_detail text;
  v_expect_failure boolean;
  v_member uuid;
  v_other uuid;
  v_league uuid;
  v_season uuid;
  v_user uuid;
  v_player uuid;
  v_pick uuid;
  v_roster uuid;
  v_trade uuid;
  v_claim uuid;
  v_item uuid;
  v_offer uuid[];
  v_request uuid[];
  v_offer_picks uuid[];
  v_request_picks uuid[];
  v_replays int := 0;
  v_ok int := 0;
  v_rejected int := 0;
  v_expected_failures int := 0;
  v_flag boolean;
  v_eligible boolean;
  v_drop uuid;
  v_context text;
  v_row record;
BEGIN
  FOR v_step IN 1..v_steps LOOP
    v_roll := random();
    v_sql := NULL;
    v_detail := NULL;
    v_expect_failure := false;
    v_member := pg_temp.random_member();
    SELECT league_id INTO v_league FROM public.league_members WHERE id = v_member;
    v_season := pg_temp.current_season(v_league);
    v_user := pg_temp.member_user(v_member);
    v_actor := 'member ' || left(v_member::text, 8);
    PERFORM pg_temp.act_as(v_user);

    IF v_roll < 0.09 THEN
      v_op := 'list_player';
      SELECT player_id INTO v_player FROM public.roster_players WHERE member_id = v_member AND league_season_id = v_season ORDER BY random() LIMIT 1;
      IF v_player IS NULL THEN CONTINUE; END IF;
      v_sql := format('SELECT public.add_trade_block_item_atomic(%L, %L, %L, NULL, %L, %L)', v_member, v_league, v_player, 'listed at step ' || v_step, v_user);
      v_detail := 'player ' || left(v_player::text, 8);
    ELSIF v_roll < 0.13 THEN
      v_op := 'list_pick';
      SELECT id INTO v_pick FROM public.draft_picks WHERE current_owner_id = v_member ORDER BY random() LIMIT 1;
      IF v_pick IS NULL THEN CONTINUE; END IF;
      v_sql := format('SELECT public.add_trade_block_item_atomic(%L, %L, NULL, %L, NULL, %L)', v_member, v_league, v_pick, v_user);
      v_detail := 'pick ' || left(v_pick::text, 8);
    ELSIF v_roll < 0.18 THEN
      v_op := 'remove_listing';
      IF random() < 0.3 THEN
        SELECT id INTO v_item FROM public.trade_block_items WHERE member_id <> v_member ORDER BY random() LIMIT 1;
        v_expect_failure := v_item IS NOT NULL;
        v_detail := 'someone else''s listing';
      ELSE
        SELECT id INTO v_item FROM public.trade_block_items WHERE member_id = v_member ORDER BY random() LIMIT 1;
        v_detail := 'own listing';
      END IF;
      v_item := COALESCE(v_item, gen_random_uuid());
      v_sql := format('SELECT public.remove_trade_block_item_atomic(%L, %L, %L)', v_item, v_member, v_user);
    ELSIF v_roll < 0.27 THEN
      v_op := 'drop';
      SELECT id INTO v_roster FROM public.roster_players WHERE member_id = v_member AND league_season_id = v_season ORDER BY random() LIMIT 1;
      IF v_roster IS NULL THEN CONTINUE; END IF;
      v_expect_failure := pg_temp.reserved_row(v_roster);
      v_sql := format('SELECT public.drop_player_atomic(%L)', v_roster);
      v_detail := 'roster ' || left(v_roster::text, 8);
      INSERT INTO oracle_dropped VALUES (v_roster);
    ELSIF v_roll < 0.30 THEN
      v_op := 'drop_stale';
      SELECT roster_player_id INTO v_roster FROM oracle_dropped ORDER BY random() LIMIT 1;
      IF v_roster IS NULL THEN CONTINUE; END IF;
      -- Authorization is per user: the row must belong to a team this user owns.
      v_expect_failure := NOT EXISTS (
        SELECT 1 FROM public.roster_players AS roster JOIN public.league_members AS member ON member.id = roster.member_id
         WHERE roster.id = v_roster AND member.user_id = v_user) OR pg_temp.reserved_row(v_roster);
      v_sql := format('SELECT public.drop_player_atomic(%L)', v_roster);
      v_detail := 'retry of dropped row';
    ELSIF v_roll < 0.33 THEN
      v_op := 'drop_other';
      SELECT roster.id INTO v_roster FROM public.roster_players AS roster JOIN public.league_members AS member ON member.id = roster.member_id
       WHERE member.user_id <> v_user AND roster.league_id = v_league ORDER BY random() LIMIT 1;
      IF v_roster IS NULL THEN CONTINUE; END IF;
      v_expect_failure := true;
      v_sql := format('SELECT public.drop_player_atomic(%L)', v_roster);
      v_detail := 'another user''s row';
    ELSIF v_roll < 0.41 THEN
      v_op := 'add_free_agent';
      -- Mostly true free agents; a player still on waivers must be rejected.
      SELECT id INTO v_player FROM public.players AS p
       WHERE NOT EXISTS (SELECT 1 FROM public.roster_players r WHERE r.league_season_id = v_season AND r.player_id = p.id)
         AND (NOT pg_temp.on_waivers(v_league, v_season, p.id) OR random() < 0.2)
       ORDER BY random() LIMIT 1;
      IF v_player IS NULL THEN CONTINUE; END IF;
      v_expect_failure := pg_temp.add_limit_reached(v_member, v_league, v_season) OR pg_temp.on_waivers(v_league, v_season, v_player);
      v_sql := format('SELECT public.add_free_agent_atomic(%L, %L, %L)', v_member, v_league, v_player);
      v_detail := 'player ' || left(v_player::text, 8);
    ELSIF v_roll < 0.46 THEN
      v_op := 'drop_and_add';
      -- Mostly droppable rows and true free agents; a reserved drop or a
      -- player still on waivers must be rejected.
      SELECT id INTO v_roster FROM public.roster_players r
       WHERE r.member_id = v_member AND r.league_season_id = v_season AND (NOT pg_temp.reserved_row(r.id) OR random() < 0.2)
       ORDER BY random() LIMIT 1;
      SELECT id INTO v_player FROM public.players AS p
       WHERE NOT EXISTS (SELECT 1 FROM public.roster_players r WHERE r.league_season_id = v_season AND r.player_id = p.id)
         AND (NOT pg_temp.on_waivers(v_league, v_season, p.id) OR random() < 0.2)
       ORDER BY random() LIMIT 1;
      IF v_roster IS NULL OR v_player IS NULL THEN CONTINUE; END IF;
      v_expect_failure := pg_temp.add_limit_reached(v_member, v_league, v_season)
        OR pg_temp.on_waivers(v_league, v_season, v_player) OR pg_temp.reserved_row(v_roster);
      v_sql := format('SELECT public.drop_and_add_free_agent_atomic(%L, %L, %L, %L)', v_roster, v_member, v_league, v_player);
      v_detail := 'drop ' || left(v_roster::text, 8) || ' add ' || left(v_player::text, 8);
      INSERT INTO oracle_dropped VALUES (v_roster);
    ELSIF v_roll < 0.52 THEN
      v_op := 'toggle_ir';
      -- Mostly rows the IR rule allows (already on IR, or Out/IR designated);
      -- a move that breaks the rule must be rejected.
      SELECT rp.id, rp.is_on_ir, true INTO v_roster, v_flag, v_eligible
        FROM public.roster_players rp JOIN public.players p ON p.id = rp.player_id
       WHERE rp.member_id = v_member AND rp.league_season_id = v_season
         AND (rp.is_on_ir OR lower(COALESCE(p.injury_status, '')) = 'out' OR lower(COALESCE(p.injury_status, '')) LIKE 'ir%')
         AND random() < 0.8
       ORDER BY random() LIMIT 1;
      IF v_roster IS NULL THEN
        SELECT rp.id, rp.is_on_ir, rp.is_on_ir OR lower(COALESCE(p.injury_status, '')) = 'out' OR lower(COALESCE(p.injury_status, '')) LIKE 'ir%'
          INTO v_roster, v_flag, v_eligible
          FROM public.roster_players rp JOIN public.players p ON p.id = rp.player_id
         WHERE rp.member_id = v_member AND rp.league_season_id = v_season
         ORDER BY random() LIMIT 1;
      END IF;
      IF v_roster IS NULL THEN CONTINUE; END IF;
      v_expect_failure := NOT v_eligible OR pg_temp.reserved_row(v_roster) OR (NOT v_flag AND pg_temp.pending_drop_row(v_roster));
      v_sql := format('SELECT public.toggle_ir_atomic(%L, %L, %L)', v_roster, NOT v_flag, v_user);
      v_detail := CASE WHEN v_flag THEN 'activate from IR' ELSE 'move to IR' END || ' ' || left(v_roster::text, 8);
    ELSIF v_roll < 0.56 THEN
      v_op := 'toggle_taxi';
      -- Mostly rows the taxi rule allows (already on taxi, or a drafted rookie
      -- not on IR); a move that breaks the rule must be rejected.
      SELECT rp.id, rp.is_on_taxi, true INTO v_roster, v_flag, v_eligible
        FROM public.roster_players rp JOIN public.players p ON p.id = rp.player_id
       WHERE rp.member_id = v_member AND rp.league_season_id = v_season
         AND (rp.is_on_taxi OR (p.nba_draft_number IS NOT NULL AND p.years_exp = 0 AND rp.is_on_ir = false))
         AND random() < 0.8
       ORDER BY random() LIMIT 1;
      IF v_roster IS NULL THEN
        SELECT rp.id, rp.is_on_taxi, rp.is_on_taxi OR (p.nba_draft_number IS NOT NULL AND p.years_exp = 0 AND rp.is_on_ir = false)
          INTO v_roster, v_flag, v_eligible
          FROM public.roster_players rp JOIN public.players p ON p.id = rp.player_id
         WHERE rp.member_id = v_member AND rp.league_season_id = v_season
         ORDER BY random() LIMIT 1;
      END IF;
      IF v_roster IS NULL THEN CONTINUE; END IF;
      v_expect_failure := NOT v_eligible OR pg_temp.reserved_row(v_roster) OR (NOT v_flag AND pg_temp.pending_drop_row(v_roster));
      v_sql := format('SELECT public.toggle_taxi_atomic(%L, %L, %L)', v_roster, NOT v_flag, v_user);
      v_detail := CASE WHEN v_flag THEN 'activate from taxi' ELSE 'move to taxi' END || ' ' || left(v_roster::text, 8);
    ELSIF v_roll < 0.64 THEN
      v_op := 'propose_trade';
      SELECT id INTO v_other FROM public.league_members WHERE league_id = v_league AND id <> v_member ORDER BY random() LIMIT 1;
      SELECT COALESCE(array_agg(player_id), '{}') INTO v_offer FROM (SELECT player_id FROM public.roster_players WHERE member_id = v_member AND league_season_id = v_season AND is_on_ir = false AND is_on_taxi = false ORDER BY random() LIMIT (random() * 2)::int) AS s;
      SELECT COALESCE(array_agg(player_id), '{}') INTO v_request FROM (SELECT player_id FROM public.roster_players WHERE member_id = v_other AND league_season_id = v_season AND is_on_ir = false AND is_on_taxi = false ORDER BY random() LIMIT (random() * 2)::int) AS s;
      SELECT COALESCE(array_agg(id), '{}') INTO v_offer_picks FROM (SELECT id FROM public.draft_picks WHERE current_owner_id = v_member AND is_used = false ORDER BY random() LIMIT (random() * 1.5)::int) AS s;
      SELECT COALESCE(array_agg(id), '{}') INTO v_request_picks FROM (SELECT id FROM public.draft_picks WHERE current_owner_id = v_other AND is_used = false ORDER BY random() LIMIT (random() * 1.5)::int) AS s;
      IF cardinality(v_offer) + cardinality(v_request) + cardinality(v_offer_picks) + cardinality(v_request_picks) = 0 THEN CONTINUE; END IF;
      v_sql := format('SELECT public.propose_trade_atomic(%L, %L, %L, %L, %L, %L, %L, %L)', v_league, v_season, v_member, v_other, v_offer, v_request, v_offer_picks, v_request_picks);
      v_detail := format('%s players + %s picks for %s players + %s picks', cardinality(v_offer), cardinality(v_offer_picks), cardinality(v_request), cardinality(v_request_picks));
    ELSIF v_roll < 0.69 THEN
      v_op := 'accept_trade';
      -- Accept runs as the service for the recipient it names. Mostly a live
      -- offer whose player assets are still on the active side (any recipient,
      -- so the walk reaches acceptance); sometimes a stale accept of a
      -- terminal trade, which must be rejected.
      v_trade := NULL;
      IF random() < 0.25 THEN
        SELECT id INTO v_trade FROM public.trades WHERE status <> 'pending' AND recipient_member_id = v_member ORDER BY random() LIMIT 1;
      END IF;
      IF v_trade IS NOT NULL THEN
        v_expect_failure := true;
        v_detail := 'stale accept of a terminal trade';
      ELSE
        SELECT t.id, t.recipient_member_id INTO v_trade, v_member FROM public.trades t
         WHERE t.status = 'pending'
           AND (t.expires_at IS NULL OR t.expires_at > now())
           AND NOT EXISTS (
             SELECT 1 FROM public.trade_items ti
              WHERE ti.trade_id = t.id AND ti.player_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM public.roster_players rp
                   WHERE rp.player_id = ti.player_id AND rp.member_id = ti.from_member_id AND rp.league_id = t.league_id
                     AND rp.league_season_id = t.league_season_id AND rp.is_on_ir = false AND rp.is_on_taxi = false))
         ORDER BY random() LIMIT 1;
        IF v_trade IS NULL THEN
          SELECT id, recipient_member_id INTO v_trade, v_member FROM public.trades WHERE status = 'pending' ORDER BY random() LIMIT 1;
        END IF;
        IF v_trade IS NULL THEN CONTINUE; END IF;
        v_detail := 'trade ' || left(v_trade::text, 8);
      END IF;
      PERFORM pg_temp.act_as(NULL);
      v_actor := 'service for ' || left(v_member::text, 8);
      v_sql := format('SELECT public.accept_trade_atomic(%L, %L)', v_trade, v_member);
    ELSIF v_roll < 0.73 THEN
      v_op := 'complete_due_trades';
      PERFORM pg_temp.act_as(NULL);
      v_actor := 'service';
      UPDATE public.trades SET veto_window_expires_at = now() - interval '1 minute' WHERE status = 'accepted' AND veto_window_expires_at > now();
      v_sql := 'SELECT count(*) FROM public.process_due_accepted_trades_atomic(50)';
      v_detail := 'veto windows expired';
    ELSIF v_roll < 0.76 THEN
      v_op := 'reject_or_withdraw';
      SELECT id, proposer_member_id INTO v_trade, v_other FROM public.trades WHERE status = 'pending' AND (proposer_member_id = v_member OR recipient_member_id = v_member) ORDER BY random() LIMIT 1;
      IF v_trade IS NULL THEN CONTINUE; END IF;
      -- Like accept, these RPCs are service-role only: the API calls them with
      -- the acting member and user as arguments, never as the end user.
      PERFORM pg_temp.act_as(NULL);
      v_actor := 'service for ' || left(v_member::text, 8);
      IF v_other = v_member THEN
        v_sql := format('SELECT public.withdraw_trade_atomic(%L, %L, %L)', v_trade, v_member, v_user);
        v_detail := 'withdraw ' || left(v_trade::text, 8);
      ELSE
        v_sql := format('SELECT public.reject_trade_atomic(%L, %L, %L)', v_trade, v_member, v_user);
        v_detail := 'reject ' || left(v_trade::text, 8);
      END IF;
    ELSIF v_roll < 0.82 THEN
      v_op := 'waiver_claim';
      SELECT log.player_id INTO v_player FROM public.waiver_wire_log AS log
       WHERE log.league_id = v_league AND log.league_season_id = v_season AND log.cleared_at IS NULL
       ORDER BY random() LIMIT 1;
      IF v_player IS NULL THEN CONTINUE; END IF;
      v_drop := NULL;
      IF random() < 0.5 THEN
        SELECT player_id INTO v_drop FROM public.roster_players WHERE member_id = v_member AND league_season_id = v_season AND is_on_ir = false AND is_on_taxi = false ORDER BY random() LIMIT 1;
      END IF;
      v_expect_failure := pg_temp.add_limit_reached(v_member, v_league, v_season)
        OR (v_drop IS NOT NULL AND pg_temp.reserved_player(v_league, v_season, v_member, v_drop));
      v_sql := format('SELECT public.create_waiver_claim_atomic(%L, %L, %L, %L, %L, %s)', v_league, v_member, v_player, v_drop, v_user, (random() * 5)::int);
      v_detail := 'claim ' || left(v_player::text, 8) || COALESCE(' drop ' || left(v_drop::text, 8), '');
    ELSIF v_roll < 0.86 THEN
      v_op := 'process_waivers';
      PERFORM pg_temp.act_as(NULL);
      v_actor := 'service';
      UPDATE public.waiver_wire_log SET clears_at = now() - interval '1 minute' WHERE cleared_at IS NULL AND clears_at > now();
      v_sql := 'SELECT count(*) FROM public.process_due_waiver_claims_atomic(CURRENT_DATE + 3, 20)';
      v_detail := 'clock advanced past every waiver window';
    ELSIF v_roll < 0.88 THEN
      v_op := 'cancel_claim';
      IF random() < 0.3 THEN
        SELECT id INTO v_claim FROM public.waiver_claims WHERE status = 'pending' AND member_id <> v_member ORDER BY random() LIMIT 1;
        v_expect_failure := v_claim IS NOT NULL;
        v_detail := 'someone else''s claim';
      ELSE
        SELECT id INTO v_claim FROM public.waiver_claims WHERE status = 'pending' AND member_id = v_member ORDER BY random() LIMIT 1;
        v_detail := 'own claim';
      END IF;
      IF v_claim IS NULL THEN CONTINUE; END IF;
      v_sql := format('SELECT public.cancel_waiver_claim_atomic(%L, %L, %L)', v_claim, v_member, v_user);
    ELSIF v_roll < 0.90 THEN
      v_op := 'commissioner_override';
      SELECT commissioner_id INTO v_user FROM public.leagues WHERE id = v_league;
      PERFORM pg_temp.act_as(v_user);
      v_actor := 'commissioner of ' || left(v_league::text, 8);
      v_sql := format('SELECT public.commissioner_override_weekly_add_count_atomic(%L, %L, %s)', v_league, v_member, (random() * 5)::int);
      v_detail := 'add count for ' || left(v_member::text, 8);
      INSERT INTO oracle_overrides VALUES (v_league, v_member);
    ELSIF v_roll < 0.92 THEN
      v_op := 'service_delete_roster';
      PERFORM pg_temp.act_as(NULL);
      v_actor := 'service';
      SELECT id INTO v_roster FROM public.roster_players ORDER BY random() LIMIT 1;
      v_sql := format('DELETE FROM public.roster_players WHERE id = %L', v_roster);
      v_detail := 'roster ' || left(v_roster::text, 8);
      INSERT INTO oracle_dropped VALUES (v_roster);
    ELSIF v_roll < 0.94 THEN
      v_op := 'pick_change';
      PERFORM pg_temp.act_as(NULL);
      v_actor := 'service';
      SELECT id, current_owner_id INTO v_pick, v_other FROM public.draft_picks WHERE league_id = v_league AND is_used = false ORDER BY random() LIMIT 1;
      IF v_pick IS NULL THEN CONTINUE; END IF;
      -- A pick reserved by an accepted trade cannot change hands or be used.
      v_expect_failure := pg_temp.reserved_pick(v_pick);
      IF random() < 0.5 THEN
        v_sql := format('UPDATE public.draft_picks SET is_used = true, used_at = now() WHERE id = %L', v_pick);
        v_detail := 'pick used ' || left(v_pick::text, 8);
      ELSE
        SELECT id INTO v_member FROM public.league_members WHERE league_id = v_league AND id <> v_other ORDER BY random() LIMIT 1;
        v_sql := format('UPDATE public.draft_picks SET current_owner_id = %L WHERE id = %L', v_member, v_pick);
        v_detail := 'pick owner change ' || left(v_pick::text, 8);
      END IF;
    ELSIF v_roll < 0.95 THEN
      v_op := 'merge_players';
      PERFORM pg_temp.act_as(NULL);
      v_actor := 'service';
      SELECT id INTO v_player FROM public.players WHERE id IN (SELECT pg_temp.oid('player-' || n) FROM generate_series(1, 40) AS n) ORDER BY random() LIMIT 1;
      -- A merge joins two records of one real player, so both carry the same team.
      SELECT id INTO v_other FROM public.players WHERE id IN (SELECT pg_temp.oid('player-' || n) FROM generate_series(1, 40) AS n) AND id <> v_player
         AND nba_team = (SELECT nba_team FROM public.players WHERE id = v_player) ORDER BY random() LIMIT 1;
      IF v_player IS NULL OR v_other IS NULL THEN CONTINUE; END IF;
      v_sql := format('SELECT public.merge_players(%L, %L)', v_player, v_other);
      v_detail := 'winner ' || left(v_player::text, 8) || ' loser ' || left(v_other::text, 8);
    ELSIF v_roll < 0.97 THEN
      v_op := 'cross_league_listing';
      -- A member of the other league tries to list into this league.
      SELECT id INTO v_other FROM public.league_members WHERE league_id <> v_league ORDER BY random() LIMIT 1;
      SELECT player_id INTO v_player FROM public.roster_players WHERE league_season_id = v_season ORDER BY random() LIMIT 1;
      IF v_other IS NULL OR v_player IS NULL THEN CONTINUE; END IF;
      v_user := pg_temp.member_user(v_other);
      PERFORM pg_temp.act_as(v_user);
      v_actor := 'foreign member ' || left(v_other::text, 8);
      v_expect_failure := true;
      v_sql := format('SELECT public.add_trade_block_item_atomic(%L, %L, %L, NULL, NULL, %L)', v_other, v_league, v_player, v_user);
      v_detail := 'league ' || left(v_league::text, 8);
    ELSIF v_roll < 0.99 THEN
      v_op := 'lineup_set';
      PERFORM pg_temp.act_as(NULL);
      v_actor := 'service';
      SELECT id, player_id, league_id, league_season_id, member_id INTO v_row FROM public.roster_players WHERE member_id = v_member AND league_season_id = v_season AND is_on_ir = false AND is_on_taxi = false ORDER BY random() LIMIT 1;
      IF v_row.id IS NULL THEN CONTINUE; END IF;
      v_sql := format('INSERT INTO public.weekly_lineups (league_id, league_season_id, member_id, player_id, slot_type, game_date) VALUES (%L, %L, %L, %L, %L, (now() AT TIME ZONE %L)::date + %s) ON CONFLICT DO NOTHING',
        v_row.league_id, v_row.league_season_id, v_row.member_id, v_row.player_id, 'UTIL', 'America/New_York', (random() * 3)::int);
      v_detail := 'slot today or later for ' || left(v_row.player_id::text, 8);
    ELSE
      v_op := 'replay_last';
      SELECT sql INTO v_sql FROM oracle_last;
      IF v_sql IS NULL THEN CONTINUE; END IF;
      v_detail := 'exact retry of the previous statement';
      v_replays := v_replays + 1;
    END IF;

    BEGIN
      EXECUTE v_sql;
      IF v_expect_failure THEN
        RAISE EXCEPTION 'AUTHZ violated at step % (%): % succeeded for %', v_step, v_op, v_detail, v_actor;
      END IF;
      v_ok := v_ok + 1;
      INSERT INTO oracle_log VALUES (v_step, v_op, v_actor, v_detail, 'ok', NULL);
      IF v_op = 'merge_players' THEN
        -- A merge re-points history to the surviving identity; remember the mapping.
        UPDATE oracle_terminal_claims SET drop_player_id = v_player WHERE drop_player_id = v_other;
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM LIKE 'AUTHZ violated%' THEN
          RAISE;
        END IF;
        -- A business rule is a RAISE in a function. An error the engine raised
        -- (a missing column, a raw constraint violation, a bad call) is a broken
        -- function or a broken walk, never a rule, so it fails the run.
        GET STACKED DIAGNOSTICS v_context = PG_EXCEPTION_CONTEXT;
        IF split_part(v_context, E'\n', 1) NOT LIKE '%at RAISE' THEN
          RAISE EXCEPTION 'HARNESS defect at step % (%): % raised SQLSTATE % (%)', v_step, v_op, v_detail, SQLSTATE, SQLERRM
            USING DETAIL = v_context;
        END IF;
        IF v_expect_failure THEN
          v_expected_failures := v_expected_failures + 1;
          INSERT INTO oracle_log VALUES (v_step, v_op, v_actor, v_detail, 'rejected as expected', SQLERRM);
        ELSE
          v_rejected := v_rejected + 1;
          INSERT INTO oracle_log VALUES (v_step, v_op, v_actor, v_detail, 'rejected', SQLERRM);
        END IF;
    END;

    IF v_op <> 'replay_last' THEN
      DELETE FROM oracle_last;
      INSERT INTO oracle_last VALUES (v_sql);
    END IF;

    PERFORM pg_temp.act_as(NULL);
    PERFORM pg_temp.check_invariants(v_step, v_op);
  END LOOP;

  RAISE NOTICE 'roster lifecycle oracle: seed % steps % ok % rejected % expected-failures % replays %',
    COALESCE(NULLIF(current_setting('oracle.seed', true), ''), '1'), v_steps, v_ok, v_rejected, v_expected_failures, v_replays;
  FOR v_row IN SELECT op, count(*) FILTER (WHERE outcome = 'ok') AS ok, count(*) FILTER (WHERE outcome <> 'ok') AS other FROM oracle_log GROUP BY op ORDER BY op LOOP
    RAISE NOTICE '  % ok=% other=%', rpad(v_row.op, 24), v_row.ok, v_row.other;
  END LOOP;
  -- A family that expected success at least once but never got it is
  -- exercising nothing; the walk must reach every success path, or the run is
  -- not a run. Replays are exempt: a retry may legitimately fail every time.
  FOR v_row IN
    SELECT op, string_agg(DISTINCT left(error, 160), ' | ') FILTER (WHERE outcome = 'rejected') AS errors FROM oracle_log
     WHERE op <> 'replay_last'
     GROUP BY op
    HAVING count(*) FILTER (WHERE outcome IN ('ok', 'rejected')) > 0
       AND count(*) FILTER (WHERE outcome = 'ok') = 0
  LOOP
    RAISE EXCEPTION 'COVERAGE gap: op family % never succeeded in % steps', v_row.op, v_steps USING DETAIL = v_row.errors;
  END LOOP;
END $$;

ROLLBACK;
