-- Three-season end-to-end simulation.
--
-- Two leagues with different settings play three seasons through the real
-- RPCs: an auction start with full-budget bids and open slots, free agency
-- under weekly add limits (with commissioner overrides and week resets),
-- drops, waiver claims in FAAB and rolling modes, trades (completion, member
-- and commissioner vetoes, expiry when an asset leaves), trade-block cleanup,
-- lineups, IR and taxi moves, rookie snake drafts with commissioner picks and
-- pause/resume, retries of every mutation, and three season rollovers. After
-- every phase the roster-linked invariants hold, history only grows, and past
-- seasons stay byte-for-byte unchanged.
-- Runs inside one transaction and rolls back. Never run against production.
BEGIN;

CREATE FUNCTION pg_temp.oid(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT md5('three-season:' || p)::uuid
$$;
CREATE FUNCTION pg_temp.act_as(p_user uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true)
$$;
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ': ' || SQLERRM;
END $$;
CREATE FUNCTION pg_temp.ok(p_label text, p_result text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_result IS NOT NULL THEN RAISE EXCEPTION '% failed: %', p_label, p_result; END IF;
END $$;
-- p_pattern is a LIKE pattern or, with alternatives, a regular expression.
CREATE FUNCTION pg_temp.rejected(p_label text, p_result text, p_pattern text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_result IS NULL THEN RAISE EXCEPTION '% was accepted but must be rejected', p_label; END IF;
  IF p_result NOT LIKE p_pattern AND p_result !~ p_pattern THEN RAISE EXCEPTION '% rejected for the wrong reason: %', p_label, p_result; END IF;
END $$;
CREATE FUNCTION pg_temp.assert(p_cond boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT COALESCE(p_cond, false) THEN RAISE EXCEPTION '%', p_msg; END IF;
END $$;
CREATE FUNCTION pg_temp.season(p_league uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM public.league_seasons WHERE league_id = p_league AND is_current ORDER BY season_year DESC LIMIT 1
$$;
CREATE FUNCTION pg_temp.row_of(p_member uuid, p_player uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT r.id FROM public.roster_players r JOIN public.league_seasons s ON s.id = r.league_season_id AND s.is_current
   WHERE r.member_id = p_member AND r.player_id = p_player
$$;
CREATE FUNCTION pg_temp.owner_of(p_league uuid, p_player uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT r.member_id FROM public.roster_players r WHERE r.league_id = p_league AND r.league_season_id = pg_temp.season(p_league) AND r.player_id = p_player
$$;
CREATE FUNCTION pg_temp.active_count(p_member uuid) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT count(*)::int FROM public.roster_players r JOIN public.league_seasons s ON s.id = r.league_season_id AND s.is_current
   WHERE r.member_id = p_member AND r.is_on_ir = false AND r.is_on_taxi = false
$$;
CREATE FUNCTION pg_temp.listed(p_member uuid, p_player uuid DEFAULT NULL, p_pick uuid DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.trade_block_items WHERE member_id = p_member
                   AND (p_player IS NULL OR player_id = p_player) AND (p_pick IS NULL OR pick_id = p_pick))
$$;
CREATE FUNCTION pg_temp.trade_status(p_trade uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT status::text FROM public.trades WHERE id = p_trade
$$;
-- Moves the calendar one week forward for a season year by sliding its schedule back.
CREATE FUNCTION pg_temp.next_week(p_year int) RETURNS void LANGUAGE sql AS $$
  UPDATE public.season_weeks SET week_start = week_start - 7, week_end = week_end - 7 WHERE season_year = p_year
$$;
CREATE FUNCTION pg_temp.make_claims_due(p_league uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE public.waiver_wire_log SET clears_at = now() - interval '1 minute' WHERE league_id = p_league AND cleared_at IS NULL;
  UPDATE public.waiver_claims SET process_date = current_date WHERE league_id = p_league AND status = 'pending';
$$;
CREATE FUNCTION pg_temp.process_claims() RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_total int := 0; v_n int; v_guard int := 0;
BEGIN
  PERFORM pg_temp.act_as(NULL);
  LOOP
    SELECT count(*) INTO v_n FROM public.process_next_waiver_claim_atomic(current_date);
    v_total := v_total + v_n;
    v_guard := v_guard + 1;
    EXIT WHEN v_n = 0 OR v_guard > 50;
  END LOOP;
  PERFORM public.expire_waiver_wire_logs();
  RETURN v_total;
END $$;
CREATE FUNCTION pg_temp.complete_due_trades() RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_n int;
BEGIN
  PERFORM pg_temp.act_as(NULL);
  UPDATE public.trades SET veto_window_expires_at = now() - interval '1 minute' WHERE status = 'accepted';
  SELECT count(*) INTO v_n FROM public.process_due_accepted_trades_atomic(50);
  RETURN v_n;
END $$;
-- What the season-boundary job does before a rollover: process due claims,
-- expire empty waiver entries, and complete accepted trades.
CREATE FUNCTION pg_temp.close_out(p_league uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.make_claims_due(p_league);
  PERFORM pg_temp.process_claims();
  PERFORM pg_temp.complete_due_trades();
END $$;
CREATE FUNCTION pg_temp.on_clock(p_draft uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT o.member_id FROM public.drafts d JOIN public.draft_orders o ON o.draft_id = d.id
   WHERE d.id = p_draft
     AND o.position = ((d.current_nomination_order - 1) % (SELECT count(*) FROM public.draft_orders WHERE draft_id = p_draft)) + 1
$$;
CREATE FUNCTION pg_temp.snake_clock(p_draft uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT member_id FROM public.snake_draft_picks WHERE draft_id = p_draft AND player_id IS NULL ORDER BY overall_pick LIMIT 1
$$;
CREATE FUNCTION pg_temp.user_of(p_member uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT user_id FROM public.league_members WHERE id = p_member
$$;

-- Invariants over every league and its current season (the oracle's I1-I10 in
-- one place), plus history that only grows and past seasons that never change.
CREATE TEMP TABLE sim_history (label text, transactions bigint, wire bigint, trades bigint, activity bigint, checked_at timestamptz DEFAULT now());
CREATE TEMP TABLE sim_frozen (league_season_id uuid, roster_hash text, transaction_hash text, trade_hash text);
CREATE FUNCTION pg_temp.season_hash(p_season uuid, p_table text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  IF p_table = 'roster' THEN
    SELECT md5(COALESCE(string_agg(format('%s|%s|%s|%s|%s', member_id, player_id, is_on_ir, is_on_taxi, acquired_via), ',' ORDER BY member_id, player_id), '')) INTO v
      FROM public.roster_players WHERE league_season_id = p_season;
  ELSIF p_table = 'transactions' THEN
    SELECT md5(COALESCE(string_agg(format('%s|%s|%s|%s', member_id, player_id, transaction_type, occurred_at), ',' ORDER BY occurred_at, member_id, player_id, transaction_type), '')) INTO v
      FROM public.roster_transactions WHERE league_season_id = p_season;
  ELSE
    SELECT md5(COALESCE(string_agg(format('%s|%s|%s', id, status, completed_at), ',' ORDER BY id), '')) INTO v
      FROM public.trades WHERE league_season_id = p_season;
  END IF;
  RETURN v;
END $$;
CREATE FUNCTION pg_temp.checkpoint(p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_count int; v_prev sim_history%ROWTYPE; v_row record;
BEGIN
  -- I1 player listings need an active current-season roster row.
  SELECT count(*) INTO v_count FROM public.trade_block_items AS item
   WHERE item.player_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM public.roster_players AS r JOIN public.league_seasons AS s ON s.id = r.league_season_id AND s.is_current
      WHERE r.league_id = item.league_id AND r.member_id = item.member_id AND r.player_id = item.player_id AND r.is_on_ir = false AND r.is_on_taxi = false);
  PERFORM pg_temp.assert(v_count = 0, format('%s: %s stale player listing(s)', p_label, v_count));
  -- I2 pick listings need an owned unused pick.
  SELECT count(*) INTO v_count FROM public.trade_block_items AS item
   WHERE item.pick_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM public.draft_picks AS pick WHERE pick.id = item.pick_id AND pick.league_id = item.league_id AND pick.current_owner_id = item.member_id AND pick.is_used = false);
  PERFORM pg_temp.assert(v_count = 0, format('%s: %s stale pick listing(s)', p_label, v_count));
  -- I3 future unlocked lineup slots belong to active roster players.
  SELECT count(*) INTO v_count FROM public.weekly_lineups AS lineup
   WHERE lineup.game_date >= (now() AT TIME ZONE 'America/New_York')::date
     AND NOT private.lineup_game_started(lineup.player_id, lineup.game_date)
     AND NOT EXISTS (
     SELECT 1 FROM public.roster_players AS r WHERE r.league_id = lineup.league_id AND r.league_season_id = lineup.league_season_id
      AND r.member_id = lineup.member_id AND r.player_id = lineup.player_id AND r.is_on_ir = false AND r.is_on_taxi = false);
  PERFORM pg_temp.assert(v_count = 0, format('%s: %s stale future lineup slot(s)', p_label, v_count));
  -- I4 pending claims name an active drop or none.
  SELECT count(*) INTO v_count FROM public.waiver_claims AS claim
   WHERE claim.status = 'pending' AND claim.drop_player_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM public.roster_players AS r WHERE r.league_id = claim.league_id AND r.league_season_id = claim.league_season_id
      AND r.member_id = claim.member_id AND r.player_id = claim.drop_player_id AND r.is_on_ir = false AND r.is_on_taxi = false);
  PERFORM pg_temp.assert(v_count = 0, format('%s: %s pending claim(s) with a stale drop', p_label, v_count));
  -- I5 pending offers hold their assets; I6 accepted offers keep them active.
  SELECT count(*) INTO v_count FROM public.trade_items AS item JOIN public.trades AS t ON t.id = item.trade_id
   WHERE t.status IN ('pending', 'accepted') AND item.player_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM public.roster_players AS r WHERE r.league_id = t.league_id AND r.league_season_id = t.league_season_id
      AND r.member_id = item.from_member_id AND r.player_id = item.player_id
      AND (t.status = 'pending' OR (r.is_on_ir = false AND r.is_on_taxi = false)));
  PERFORM pg_temp.assert(v_count = 0, format('%s: %s open offer item(s) whose player left', p_label, v_count));
  SELECT count(*) INTO v_count FROM public.trade_items AS item JOIN public.trades AS t ON t.id = item.trade_id
   WHERE t.status IN ('pending', 'accepted') AND item.pick_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM public.draft_picks AS pick WHERE pick.id = item.pick_id AND pick.current_owner_id = item.from_member_id AND pick.is_used = false);
  PERFORM pg_temp.assert(v_count = 0, format('%s: %s open offer item(s) whose pick left', p_label, v_count));
  -- Ownership: one roster row per player and season; IR/taxi never both; rows only in their league; active rosters within size.
  SELECT count(*) INTO v_count FROM (SELECT league_season_id, player_id FROM public.roster_players GROUP BY 1, 2 HAVING count(*) > 1) AS d;
  PERFORM pg_temp.assert(v_count = 0, format('%s: %s player(s) on two rosters in one season', p_label, v_count));
  SELECT count(*) INTO v_count FROM public.roster_players WHERE is_on_ir AND is_on_taxi;
  PERFORM pg_temp.assert(v_count = 0, format('%s: %s row(s) both IR and taxi', p_label, v_count));
  SELECT count(*) INTO v_count FROM public.roster_players r JOIN public.league_members m ON m.id = r.member_id WHERE m.league_id <> r.league_id;
  PERFORM pg_temp.assert(v_count = 0, format('%s: %s roster row(s) in a foreign league', p_label, v_count));
  SELECT count(*) INTO v_count FROM (
    SELECT r.member_id FROM public.roster_players r JOIN public.league_seasons s ON s.id = r.league_season_id AND s.is_current
      JOIN public.leagues l ON l.id = r.league_id
     WHERE r.is_on_ir = false AND r.is_on_taxi = false GROUP BY r.member_id, l.roster_size HAVING count(*) > l.roster_size) AS o;
  PERFORM pg_temp.assert(v_count = 0, format('%s: %s roster(s) above the league size', p_label, v_count));
  -- I10 a rostered player is not clearing waivers in the same season.
  SELECT count(*) INTO v_count FROM public.waiver_wire_log w JOIN public.roster_players r
    ON r.league_id = w.league_id AND r.league_season_id = w.league_season_id AND r.player_id = w.player_id
   WHERE w.cleared_at IS NULL;
  PERFORM pg_temp.assert(v_count = 0, format('%s: %s rostered player(s) still on waivers', p_label, v_count));
  -- I9 add counts never exceed the limit in the current season (past seasons
  -- played under the limit of their day).
  SELECT count(*) INTO v_count FROM public.weekly_add_counts c JOIN public.leagues l ON l.id = c.league_id
    JOIN public.league_seasons s ON s.id = c.league_season_id AND s.is_current
   WHERE l.weekly_add_limit IS NOT NULL AND c.add_count > l.weekly_add_limit;
  PERFORM pg_temp.assert(v_count = 0, format('%s: %s add count(s) above the limit', p_label, v_count));
  -- History only grows.
  SELECT * INTO v_prev FROM sim_history ORDER BY checked_at DESC LIMIT 1;
  INSERT INTO sim_history (label, transactions, wire, trades, activity)
  SELECT p_label, (SELECT count(*) FROM public.roster_transactions), (SELECT count(*) FROM public.waiver_wire_log),
         (SELECT count(*) FROM public.trades), (SELECT count(*) FROM public.league_activity);
  IF v_prev.label IS NOT NULL THEN
    SELECT * INTO v_row FROM sim_history WHERE label = p_label;
    PERFORM pg_temp.assert(v_row.transactions >= v_prev.transactions AND v_row.wire >= v_prev.wire AND v_row.trades >= v_prev.trades AND v_row.activity >= v_prev.activity,
      format('%s: history shrank since %s', p_label, v_prev.label));
  END IF;
  -- Past seasons never change.
  FOR v_row IN SELECT * FROM sim_frozen LOOP
    PERFORM pg_temp.assert(pg_temp.season_hash(v_row.league_season_id, 'roster') = v_row.roster_hash, format('%s: a past season roster changed', p_label));
    PERFORM pg_temp.assert(pg_temp.season_hash(v_row.league_season_id, 'transactions') = v_row.transaction_hash, format('%s: a past season history changed', p_label));
    PERFORM pg_temp.assert(pg_temp.season_hash(v_row.league_season_id, 'trades') = v_row.trade_hash, format('%s: a past season trade record changed', p_label));
  END LOOP;
END $$;
CREATE FUNCTION pg_temp.freeze_season(p_season uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO sim_frozen SELECT p_season, pg_temp.season_hash(p_season, 'roster'), pg_temp.season_hash(p_season, 'transactions'), pg_temp.season_hash(p_season, 'trades')
$$;

-- Seed ------------------------------------------------------------------------
INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
SELECT pg_temp.oid('user-' || n), 'authenticated', 'authenticated', 'sim-' || n || '@example.test', 'x', now(), '{}', '{}', now(), now() FROM generate_series(1, 4) AS n;
INSERT INTO public.profiles (id, username, display_name)
SELECT pg_temp.oid('user-' || n), 'sim_user_' || n, 'Sim User ' || n FROM generate_series(1, 4) AS n ON CONFLICT (id) DO NOTHING;

-- League A: auction start, FAAB waivers, weekly add limit 3, six-player rosters, member-vote vetoes.
-- League B: seeded rosters, rolling waivers, no add limit, five-player rosters, commissioner vetoes.
INSERT INTO public.leagues (id, name, slug, commissioner_id, status, roster_size, ir_slots, taxi_slots, auction_budget, waiver_mode, faab_starting_budget, weekly_add_limit, trade_veto_mode, trade_veto_threshold_percent)
VALUES
  (pg_temp.oid('league-A'), 'Sim Auction League', 'sim-auction-league', pg_temp.oid('user-1'), 'setup', 6, 1, 1, 10, 'faab', 100, 3, 'member_vote', 50),
  (pg_temp.oid('league-B'), 'Sim Rolling League', 'sim-rolling-league', pg_temp.oid('user-2'), 'active', 5, 1, 2, 20, 'rolling', 100, NULL, 'commissioner', 50);
INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES
  (pg_temp.oid('A1'), pg_temp.oid('league-A'), pg_temp.oid('user-1'), 'commissioner', 'Alpha'),
  (pg_temp.oid('A2'), pg_temp.oid('league-A'), pg_temp.oid('user-2'), 'manager', 'Bravo'),
  (pg_temp.oid('A3'), pg_temp.oid('league-A'), pg_temp.oid('user-3'), 'manager', 'Charlie'),
  (pg_temp.oid('B1'), pg_temp.oid('league-B'), pg_temp.oid('user-2'), 'commissioner', 'Delta'),
  (pg_temp.oid('B2'), pg_temp.oid('league-B'), pg_temp.oid('user-3'), 'manager', 'Echo'),
  (pg_temp.oid('B3'), pg_temp.oid('league-B'), pg_temp.oid('user-4'), 'manager', 'Foxtrot');
INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES (pg_temp.oid('season-A-2098'), pg_temp.oid('league-A'), 2098, true), (pg_temp.oid('season-B-2098'), pg_temp.oid('league-B'), 2098, true);
-- Three weeks per season around today; pg_temp.next_week slides a season's calendar.
INSERT INTO public.season_weeks (season_year, week_number, week_start, week_end)
SELECT y, w, (now() AT TIME ZONE 'America/New_York')::date - 3 + 7 * (w - 1), (now() AT TIME ZONE 'America/New_York')::date + 3 + 7 * (w - 1)
  FROM generate_series(2098, 2101) AS y CROSS JOIN generate_series(1, 3) AS w;
INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
VALUES
  (pg_temp.oid('league-A'), pg_temp.oid('season-A-2098'), pg_temp.oid('A1'), 1), (pg_temp.oid('league-A'), pg_temp.oid('season-A-2098'), pg_temp.oid('A2'), 2), (pg_temp.oid('league-A'), pg_temp.oid('season-A-2098'), pg_temp.oid('A3'), 3),
  (pg_temp.oid('league-B'), pg_temp.oid('season-B-2098'), pg_temp.oid('B1'), 1), (pg_temp.oid('league-B'), pg_temp.oid('season-B-2098'), pg_temp.oid('B2'), 2), (pg_temp.oid('league-B'), pg_temp.oid('season-B-2098'), pg_temp.oid('B3'), 3);
-- Forty veterans (13-18 are Out) and twelve rookies (draft classes of six).
INSERT INTO public.players (id, first_name, last_name, nba_team, position, years_exp, eligible_positions, injury_status, nba_draft_number)
SELECT pg_temp.oid('vet-' || n), 'Vet', 'Player ' || n, (ARRAY['ATL', 'BOS', 'DAL', 'DEN', 'LAL', 'MIA'])[1 + n % 6],
       (ARRAY['PG', 'SG', 'SF', 'PF', 'C'])[1 + n % 5]::nba_position, 2 + n % 5, ARRAY[(ARRAY['PG', 'SG', 'SF', 'PF', 'C'])[1 + n % 5]],
       CASE WHEN n BETWEEN 13 AND 18 THEN 'Out' END, NULL
  FROM generate_series(1, 40) AS n;
INSERT INTO public.players (id, first_name, last_name, nba_team, position, years_exp, eligible_positions, injury_status, nba_draft_number)
SELECT pg_temp.oid('rookie-' || n), 'Rookie', 'Class ' || n, 'MIA', 'SF'::nba_position, 0, ARRAY['SF'], NULL, n FROM generate_series(1, 12) AS n;
-- Rookie draft assets for 2099 and 2100, two rounds per member.
INSERT INTO public.draft_picks (id, league_id, season_year, round, original_owner_id, current_owner_id)
SELECT pg_temp.oid('pick-' || m.key || '-' || y || '-' || r), m.league, y, r, m.id, m.id
  FROM (VALUES ('A1', pg_temp.oid('A1'), pg_temp.oid('league-A')), ('A2', pg_temp.oid('A2'), pg_temp.oid('league-A')), ('A3', pg_temp.oid('A3'), pg_temp.oid('league-A')),
               ('B1', pg_temp.oid('B1'), pg_temp.oid('league-B')), ('B2', pg_temp.oid('B2'), pg_temp.oid('league-B')), ('B3', pg_temp.oid('B3'), pg_temp.oid('league-B'))) AS m(key, id, league)
  CROSS JOIN generate_series(2099, 2100) AS y CROSS JOIN generate_series(1, 2) AS r;
-- League B starts with seeded rosters (a league that joined mid-flight).
INSERT INTO public.roster_players (league_id, league_season_id, member_id, player_id, acquired_via)
SELECT pg_temp.oid('league-B'), pg_temp.oid('season-B-2098'), m, pg_temp.oid('vet-' || n), 'draft'
  FROM (VALUES (pg_temp.oid('B1'), 20), (pg_temp.oid('B1'), 21), (pg_temp.oid('B1'), 22),
               (pg_temp.oid('B2'), 23), (pg_temp.oid('B2'), 24), (pg_temp.oid('B2'), 25),
               (pg_temp.oid('B3'), 26), (pg_temp.oid('B3'), 27), (pg_temp.oid('B3'), 28)) AS s(m, n);

CREATE TEMP TABLE ids AS
SELECT pg_temp.oid('league-A') AS a, pg_temp.oid('league-B') AS b,
       pg_temp.oid('user-1') AS u1, pg_temp.oid('user-2') AS u2, pg_temp.oid('user-3') AS u3, pg_temp.oid('user-4') AS u4,
       pg_temp.oid('A1') AS a1, pg_temp.oid('A2') AS a2, pg_temp.oid('A3') AS a3,
       pg_temp.oid('B1') AS b1, pg_temp.oid('B2') AS b2, pg_temp.oid('B3') AS b3;
CREATE FUNCTION pg_temp.vet(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT pg_temp.oid('vet-' || n) $$;
CREATE FUNCTION pg_temp.rookie(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT pg_temp.oid('rookie-' || n) $$;
CREATE FUNCTION pg_temp.pick(p_key text, p_year int, p_round int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT pg_temp.oid('pick-' || p_key || '-' || p_year || '-' || p_round) $$;
-- An active veteran (or rookie) currently on the member's roster.
CREATE FUNCTION pg_temp.any_player(p_member uuid, p_rookie boolean) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT r.player_id FROM public.roster_players r JOIN public.players p ON p.id = r.player_id
    JOIN public.league_seasons s ON s.id = r.league_season_id AND s.is_current
   WHERE r.member_id = p_member AND r.is_on_ir = false AND r.is_on_taxi = false AND (p.years_exp = 0) = p_rookie
   ORDER BY r.id LIMIT 1
$$;

SELECT pg_temp.checkpoint('seed');

-- Season 1: auction start with full-budget bids and open slots ----------------
DO $$
DECLARE i ids%ROWTYPE; v_draft uuid; v_nom uuid; v_status text;
BEGIN
  SELECT * INTO i FROM ids;
  PERFORM pg_temp.act_as(NULL);
  PERFORM public.start_auction_draft_atomic(i.a, 'user_nominated', false, 30, 10, 'auction_no_bid');
  SELECT id INTO v_draft FROM public.drafts WHERE league_id = i.a AND status = 'in_progress';
  PERFORM pg_temp.assert(v_draft IS NOT NULL, 'auction: draft did not start');
  SELECT status::text INTO v_status FROM public.leagues WHERE id = i.a;
  PERFORM pg_temp.assert(v_status = 'drafting', 'auction: league is not drafting');
  -- A retry of the start is refused.
  PERFORM pg_temp.rejected('auction start retry', pg_temp.try(format('SELECT public.start_auction_draft_atomic(%L, %L, false, 30, 10, %L)', i.a, 'user_nominated', 'auction_no_bid')), '%draft%');

  -- Six nominations: everyone spends the full $10 in two $5 wins and keeps four open slots.
  FOR n IN 1..6 LOOP
    DECLARE v_nominator uuid := pg_temp.on_clock(v_draft); v_other uuid; v_user uuid := pg_temp.user_of(pg_temp.on_clock(v_draft));
    BEGIN
      PERFORM pg_temp.act_as(v_user);
      SELECT id INTO v_nom FROM public.create_auction_nomination_atomic(v_draft, v_nominator, pg_temp.vet(n), v_user, 60);
      -- A rival opens low, the nominator answers with an exact $5; the rival cannot follow with more than $5.
      SELECT id INTO v_other FROM public.league_members WHERE league_id = i.a AND id <> v_nominator ORDER BY id LIMIT 1;
      IF n <= 3 THEN
        PERFORM pg_temp.act_as(pg_temp.user_of(v_other));
        PERFORM pg_temp.ok('rival opening bid ' || n, pg_temp.try(format('SELECT public.place_auction_bid_atomic(%L, %L, %L, 2, %L)', v_draft, v_other, v_nom, pg_temp.user_of(v_other))));
        PERFORM pg_temp.act_as(v_user);
        PERFORM pg_temp.rejected('overbid ' || n, pg_temp.try(format('SELECT public.place_auction_bid_atomic(%L, %L, %L, 11, %L)', v_draft, v_nominator, v_nom, v_user)), '%Insufficient budget%');
      END IF;
      IF n = 4 THEN
        -- The commissioner pauses and resumes mid-draft.
        PERFORM pg_temp.act_as(i.u1);
        PERFORM public.pause_draft_atomic(v_draft, i.u1);
        PERFORM pg_temp.rejected('bid while paused', pg_temp.try(format('SELECT public.place_auction_bid_atomic(%L, %L, %L, 5, %L)', v_draft, v_nominator, v_nom, v_user)), '%not in progress%');
        PERFORM public.resume_draft_atomic(v_draft, i.u1);
      END IF;
      PERFORM pg_temp.act_as(v_user);
      PERFORM pg_temp.ok('winning bid ' || n, pg_temp.try(format('SELECT public.place_auction_bid_atomic(%L, %L, %L, 5, %L)', v_draft, v_nominator, v_nom, v_user)));
      PERFORM pg_temp.rejected('bid retry ' || n, pg_temp.try(format('SELECT public.place_auction_bid_atomic(%L, %L, %L, 5, %L)', v_draft, v_nominator, v_nom, v_user)), 'highest bidder|closed|must exceed|not in progress');
      PERFORM pg_temp.act_as(NULL);
      IF (SELECT status FROM public.nominations WHERE id = v_nom) = 'open' THEN
        -- The countdown runs out (the cron closes expired nominations the same way).
        UPDATE public.nominations SET countdown_expires_at = now() - interval '1 second' WHERE id = v_nom;
        PERFORM public.close_auction_nomination_atomic(v_nom);
      END IF;
      PERFORM pg_temp.assert((SELECT status::text FROM public.nominations WHERE id = v_nom) = 'sold', 'auction: nomination ' || n || ' did not sell');
      PERFORM pg_temp.assert(pg_temp.owner_of(i.a, pg_temp.vet(n)) = v_nominator, 'auction: nomination ' || n || ' went to the wrong roster');
    END;
  END LOOP;
  SELECT status::text INTO v_status FROM public.drafts WHERE id = v_draft;
  PERFORM pg_temp.assert(v_status = 'completed', 'auction: draft did not complete once every budget was spent, status ' || v_status);
  SELECT status::text INTO v_status FROM public.leagues WHERE id = i.a;
  PERFORM pg_temp.assert(v_status = 'active', 'auction: league did not go active, status ' || v_status);
  PERFORM pg_temp.assert(pg_temp.active_count(i.a1) = 2 AND pg_temp.active_count(i.a2) = 2 AND pg_temp.active_count(i.a3) = 2, 'auction: rosters should hold two players each');
  PERFORM pg_temp.assert((SELECT bool_and(remaining = 0) FROM public.draft_budgets WHERE draft_id = v_draft), 'auction: budgets should be spent to zero');
END $$;
SELECT pg_temp.checkpoint('season 1: auction');

-- Season 1: free agency under the weekly limit, overrides, and the week reset -----
DO $$
DECLARE i ids%ROWTYPE; v_message text; v_state record;
BEGIN
  SELECT * INTO i FROM ids;
  PERFORM pg_temp.act_as(i.u1);
  PERFORM pg_temp.ok('add 1', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.a1, i.a, pg_temp.vet(7))));
  PERFORM pg_temp.ok('add 2', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.a1, i.a, pg_temp.vet(8))));
  PERFORM pg_temp.ok('add 3', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.a1, i.a, pg_temp.vet(9))));
  PERFORM pg_temp.rejected('add retry', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.a1, i.a, pg_temp.vet(9))), '23505%');
  v_message := pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.a1, i.a, pg_temp.vet(10)));
  PERFORM pg_temp.rejected('fourth add', v_message, 'PA001: Weekly add limit reached (3/3 adds used this week). Adds reset %');
  SELECT * INTO v_state FROM public.get_member_transaction_state(i.a1, i.a);
  PERFORM pg_temp.assert(v_state.weekly_add_count = 3 AND v_state.add_limit_message = substr(v_message, 8), 'state and rejection disagree: ' || COALESCE(v_state.add_limit_message, 'null'));
  -- The commissioner hands back one add; the week then resets on its own.
  PERFORM pg_temp.assert(public.commissioner_override_weekly_add_count_atomic(i.a, i.a1, 2) = 2, 'override did not return the new count');
  PERFORM pg_temp.ok('add after override', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.a1, i.a, pg_temp.vet(10))));
  PERFORM pg_temp.rejected('limit again', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.a1, i.a, pg_temp.vet(11))), 'PA001:%');
  PERFORM pg_temp.next_week(2098);
  SELECT * INTO v_state FROM public.get_member_transaction_state(i.a1, i.a);
  PERFORM pg_temp.assert(v_state.week_number = 2 AND v_state.weekly_add_count = 0 AND v_state.add_limit_message IS NULL, 'the new week did not reset the count');
  PERFORM pg_temp.rejected('roster full', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.a1, i.a, pg_temp.vet(11))), 'PA003:%');
  PERFORM pg_temp.assert(pg_temp.active_count(i.a1) = 6, 'A1 should be full');
  -- Others fill up too; A3 keeps one open slot.
  PERFORM pg_temp.act_as(i.u2);
  PERFORM pg_temp.ok('A2 add 12', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.a2, i.a, pg_temp.vet(12))));
  PERFORM pg_temp.ok('A2 add 13', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.a2, i.a, pg_temp.vet(13))));
  PERFORM pg_temp.act_as(i.u3);
  PERFORM pg_temp.ok('A3 add 14', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.a3, i.a, pg_temp.vet(14))));
  PERFORM pg_temp.ok('A3 add 15', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.a3, i.a, pg_temp.vet(15))));
  -- League B has no limit: two more adds go through unchecked.
  PERFORM pg_temp.act_as(i.u4);
  FOR n IN 29..30 LOOP
    PERFORM pg_temp.ok('B3 add ' || n, pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.b3, i.b, pg_temp.vet(n))));
  END LOOP;
END $$;
SELECT pg_temp.checkpoint('season 1: free agency');

-- Season 1: listings, drops, waivers in both modes --------------------------------
DO $$
DECLARE i ids%ROWTYPE; v_row uuid; v_claim uuid; v_processed int; v_bal int;
BEGIN
  SELECT * INTO i FROM ids;
  -- Listings survive only while the asset does.
  PERFORM public.add_trade_block_item_atomic(i.a1, i.a, pg_temp.vet(7), NULL, 'shopping', i.u1);
  PERFORM public.add_trade_block_item_atomic(i.a1, i.a, NULL, pg_temp.pick('A1', 2099, 1), NULL, i.u1);
  PERFORM public.add_trade_block_item_atomic(i.a2, i.a, pg_temp.vet(12), NULL, NULL, i.u2);
  PERFORM public.add_trade_block_item_atomic(i.a2, i.a, pg_temp.vet(13), NULL, NULL, i.u2);
  PERFORM public.add_trade_block_item_atomic(i.a2, i.a, NULL, pg_temp.pick('A2', 2099, 2), NULL, i.u2);
  INSERT INTO public.weekly_lineups (league_id, league_season_id, member_id, player_id, slot_type, game_date)
  VALUES (i.a, pg_temp.season(i.a), i.a1, pg_temp.vet(7), 'UTIL', (now() AT TIME ZONE 'America/New_York')::date + 1);
  PERFORM pg_temp.act_as(i.u1);
  v_row := pg_temp.row_of(i.a1, pg_temp.vet(7));
  PERFORM public.drop_player_atomic(v_row);
  PERFORM pg_temp.rejected('drop retry', pg_temp.try(format('SELECT public.drop_player_atomic(%L)', v_row)), 'P0002%');
  PERFORM pg_temp.assert(NOT pg_temp.listed(i.a1, pg_temp.vet(7)), 'listing survived the drop');
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM public.weekly_lineups WHERE member_id = i.a1 AND player_id = pg_temp.vet(7)), 'lineup slot survived the drop');
  PERFORM pg_temp.assert(EXISTS (SELECT 1 FROM public.waiver_wire_log WHERE player_id = pg_temp.vet(7) AND cleared_at IS NULL), 'drop did not open a waiver entry');
  PERFORM pg_temp.rejected('add a player on waivers', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.a1, i.a, pg_temp.vet(7))), 'PA002:%');

  -- FAAB: the higher bid wins, its drop is released, the loser fails, and a retry of a claim is refused.
  PERFORM pg_temp.act_as(NULL);
  PERFORM public.create_waiver_claim_atomic(i.a, i.a2, pg_temp.vet(7), NULL, i.u2, 20);
  PERFORM pg_temp.rejected('claim retry', pg_temp.try(format('SELECT public.create_waiver_claim_atomic(%L, %L, %L, NULL, %L, 20)', i.a, i.a2, pg_temp.vet(7), i.u2)), '%already have a pending claim%');
  v_claim := public.create_waiver_claim_atomic(i.a, i.a3, pg_temp.vet(7), pg_temp.vet(14), i.u3, 30);
  PERFORM pg_temp.rejected('IR move of a pending drop', pg_temp.try(format('SELECT public.toggle_ir_atomic(%L, true, %L)', pg_temp.row_of(i.a3, pg_temp.vet(14)), i.u3)), '%pending waiver drop%');
  PERFORM pg_temp.make_claims_due(i.a);
  v_processed := pg_temp.process_claims();
  PERFORM pg_temp.assert(pg_temp.owner_of(i.a, pg_temp.vet(7)) = i.a3, 'the higher FAAB bid did not win');
  PERFORM pg_temp.assert(pg_temp.owner_of(i.a, pg_temp.vet(14)) IS NULL, 'the winning claim did not release its drop');
  PERFORM pg_temp.assert((SELECT status::text FROM public.waiver_claims WHERE id = v_claim) = 'succeeded', 'winning claim not marked succeeded');
  PERFORM pg_temp.assert((SELECT status::text FROM public.waiver_claims WHERE member_id = i.a2 AND player_id = pg_temp.vet(7)) LIKE 'failed%', 'losing claim not marked failed');
  PERFORM pg_temp.act_as(i.u3);
  SELECT faab_balance INTO v_bal FROM public.get_member_transaction_state(i.a3, i.a);
  PERFORM pg_temp.assert(v_bal = 70, 'FAAB balance after the winning bid should be 70, got ' || v_bal);
  -- The commissioner adjusts a budget.
  PERFORM pg_temp.act_as(i.u1);
  PERFORM pg_temp.assert(public.commissioner_adjust_faab_balance_atomic(i.a, i.a2, 55) = 55, 'FAAB adjust did not apply');

  -- Rolling: the better priority wins and rotates to the back.
  PERFORM pg_temp.act_as(i.u2);
  PERFORM public.drop_player_atomic(pg_temp.row_of(i.b1, pg_temp.vet(20)));
  PERFORM pg_temp.act_as(NULL);
  PERFORM public.create_waiver_claim_atomic(i.b, i.b3, pg_temp.vet(20), NULL, i.u4, 0);
  PERFORM public.create_waiver_claim_atomic(i.b, i.b2, pg_temp.vet(20), NULL, i.u3, 0);
  PERFORM pg_temp.make_claims_due(i.b);
  v_processed := pg_temp.process_claims();
  PERFORM pg_temp.assert(pg_temp.owner_of(i.b, pg_temp.vet(20)) = i.b2, 'rolling waivers: the better priority did not win');
  -- Rolling: the winner takes the back of the line (max + 1).
  PERFORM pg_temp.assert((SELECT priority FROM public.waiver_priorities WHERE member_id = i.b2 AND league_season_id = pg_temp.season(i.b))
    = (SELECT max(priority) FROM public.waiver_priorities WHERE league_season_id = pg_temp.season(i.b)), 'rolling waivers: the winner did not move to the back');
END $$;
SELECT pg_temp.checkpoint('season 1: waivers');

-- Season 1: trades, vetoes, expiry, reservations, and pick swaps ---------------------
CREATE TEMP TABLE sim_trades (key text PRIMARY KEY, id uuid);
DO $$
DECLARE i ids%ROWTYPE; v_t1 uuid; v_t2 uuid; v_t3 uuid; v_t4 uuid; v_tb uuid; v_n int;
BEGIN
  SELECT * INTO i FROM ids;
  PERFORM pg_temp.act_as(NULL);
  -- T1 completes: A1's vet 8 for A2's listed (and injured) vet 13.
  v_t1 := public.propose_trade_atomic(i.a, pg_temp.season(i.a), i.a1, i.a2, ARRAY[pg_temp.vet(8)], ARRAY[pg_temp.vet(13)], '{}', '{}');
  PERFORM public.accept_trade_atomic(v_t1, i.a2);
  PERFORM pg_temp.rejected('accept retry', pg_temp.try(format('SELECT public.accept_trade_atomic(%L, %L)', v_t1, i.a2)), 'not pending|no longer pending|already');
  PERFORM pg_temp.rejected('party veto', pg_temp.try(format('SELECT public.veto_trade_atomic(%L, %L)', v_t1, i.a1)), '%cannot veto%');
  PERFORM pg_temp.act_as(i.u1);
  PERFORM pg_temp.rejected('drop a reserved asset', pg_temp.try(format('SELECT public.drop_player_atomic(%L)', pg_temp.row_of(i.a1, pg_temp.vet(8)))), 'PA004:%reserved%');
  PERFORM pg_temp.rejected('IR a reserved asset', pg_temp.try(format('SELECT public.toggle_ir_atomic(%L, true, %L)', pg_temp.row_of(i.a2, pg_temp.vet(13)), i.u2)), 'PA004:%reserved%');
  -- T2 is vetoed by the one eligible voter (member vote, 50%).
  PERFORM pg_temp.act_as(NULL);
  v_t2 := public.propose_trade_atomic(i.a, pg_temp.season(i.a), i.a2, i.a3, ARRAY[pg_temp.vet(12)], ARRAY[pg_temp.vet(15)], '{}', '{}');
  PERFORM public.accept_trade_atomic(v_t2, i.a3);
  PERFORM public.veto_trade_atomic(v_t2, i.a1);
  PERFORM pg_temp.assert(pg_temp.trade_status(v_t2) = 'vetoed', 'member veto did not take: ' || pg_temp.trade_status(v_t2));
  PERFORM pg_temp.assert(pg_temp.owner_of(i.a, pg_temp.vet(12)) = i.a2, 'vetoed trade moved an asset');
  -- T3 expires when its asset is dropped.
  v_t3 := public.propose_trade_atomic(i.a, pg_temp.season(i.a), i.a3, i.a1, ARRAY[pg_temp.vet(15)], ARRAY[pg_temp.vet(9)], '{}', '{}');
  PERFORM pg_temp.act_as(i.u1);
  PERFORM public.drop_player_atomic(pg_temp.row_of(i.a1, pg_temp.vet(9)));
  PERFORM pg_temp.assert(pg_temp.trade_status(v_t3) = 'expired', 'pending offer survived losing its asset: ' || pg_temp.trade_status(v_t3));
  PERFORM pg_temp.assert((SELECT completion_failure_reason FROM public.trades WHERE id = v_t3) IS NOT NULL, 'expired offer has no reason');
  -- T4 swaps picks; A1's listed pick leaves the block when it changes hands.
  PERFORM pg_temp.act_as(NULL);
  v_t4 := public.propose_trade_atomic(i.a, pg_temp.season(i.a), i.a1, i.a3, '{}', '{}', ARRAY[pg_temp.pick('A1', 2099, 1)], ARRAY[pg_temp.pick('A3', 2099, 2)]);
  PERFORM public.accept_trade_atomic(v_t4, i.a3);
  PERFORM pg_temp.rejected('use a reserved pick', pg_temp.try(format('UPDATE public.draft_picks SET is_used = true WHERE id = %L', pg_temp.pick('A1', 2099, 1))), 'PA004:%reserved%');
  v_n := pg_temp.complete_due_trades();
  PERFORM pg_temp.assert(pg_temp.trade_status(v_t1) = 'completed' AND pg_temp.trade_status(v_t4) = 'completed', 'due trades did not complete');
  PERFORM pg_temp.assert(pg_temp.owner_of(i.a, pg_temp.vet(8)) = i.a2 AND pg_temp.owner_of(i.a, pg_temp.vet(13)) = i.a1, 'T1 assets did not move');
  PERFORM pg_temp.assert(NOT pg_temp.listed(i.a2, pg_temp.vet(13)) AND pg_temp.listed(i.a2, pg_temp.vet(12)), 'listings did not follow the trade');
  PERFORM pg_temp.assert((SELECT current_owner_id FROM public.draft_picks WHERE id = pg_temp.pick('A1', 2099, 1)) = i.a3, 'pick did not change hands');
  PERFORM pg_temp.assert(NOT pg_temp.listed(i.a1, NULL, pg_temp.pick('A1', 2099, 1)), 'pick listing survived the trade');
  PERFORM pg_temp.assert(EXISTS (SELECT 1 FROM public.roster_transactions WHERE member_id = i.a1 AND player_id = pg_temp.vet(13) AND transaction_type::text LIKE 'trade%'), 'trade history missing');
  -- League B: commissioner-only vetoes.
  v_tb := public.propose_trade_atomic(i.b, pg_temp.season(i.b), i.b2, i.b3, ARRAY[pg_temp.vet(23)], ARRAY[pg_temp.vet(26)], '{}', '{}');
  PERFORM public.accept_trade_atomic(v_tb, i.b3);
  PERFORM public.veto_trade_atomic(v_tb, i.b1);
  PERFORM pg_temp.assert(pg_temp.trade_status(v_tb) = 'vetoed', 'commissioner veto did not take');
  INSERT INTO sim_trades VALUES ('t1', v_t1), ('t2', v_t2), ('t3', v_t3), ('t4', v_t4), ('tb', v_tb);
END $$;
SELECT pg_temp.checkpoint('season 1: trades');

-- Season 1: IR, lineups, and the rollover -----------------------------------------
DO $$
DECLARE i ids%ROWTYPE; v_old_a uuid; v_old_b uuid; v_new_a uuid; v_new_b uuid; v_rows int; v_state record;
BEGIN
  SELECT * INTO i FROM ids;
  PERFORM pg_temp.act_as(i.u1);
  PERFORM public.toggle_ir_atomic(pg_temp.row_of(i.a1, pg_temp.vet(13)), true, i.u1);
  PERFORM pg_temp.act_as(i.u2);
  PERFORM pg_temp.rejected('IR a healthy player', pg_temp.try(format('SELECT public.toggle_ir_atomic(%L, true, %L)', pg_temp.row_of(i.a2, pg_temp.vet(8)), i.u2)), '%Out or IR%');
  PERFORM pg_temp.act_as(i.u3);
  PERFORM pg_temp.rejected('taxi a veteran', pg_temp.try(format('SELECT public.toggle_taxi_atomic(%L, true, %L)', pg_temp.row_of(i.a3, pg_temp.vet(7)), i.u3)), '%rookie%');
  INSERT INTO public.weekly_lineups (league_id, league_season_id, member_id, player_id, slot_type, game_date)
  VALUES (i.a, pg_temp.season(i.a), i.a3, pg_temp.vet(7), 'UTIL', (now() AT TIME ZONE 'America/New_York')::date + 2);
  PERFORM pg_temp.checkpoint('season 1: IR and lineups');

  v_old_a := pg_temp.season(i.a); v_old_b := pg_temp.season(i.b);
  PERFORM pg_temp.act_as(NULL);
  PERFORM pg_temp.rejected('advance before playoffs', pg_temp.try(format('SELECT * FROM public.advance_season_atomic(%L)', i.a)), '%playoffs%');
  UPDATE public.leagues SET status = 'playoffs' WHERE id IN (i.a, i.b);
  PERFORM pg_temp.rejected('advance with open waivers', pg_temp.try(format('SELECT * FROM public.advance_season_atomic(%L)', i.a)), '%waiver%');
  PERFORM pg_temp.close_out(i.a);
  PERFORM pg_temp.close_out(i.b);
  PERFORM public.advance_season_atomic(i.a);
  PERFORM public.advance_season_atomic(i.b);
  PERFORM pg_temp.rejected('advance retry', pg_temp.try(format('SELECT * FROM public.advance_season_atomic(%L)', i.a)), '%playoffs%');
  v_new_a := pg_temp.season(i.a); v_new_b := pg_temp.season(i.b);
  PERFORM pg_temp.assert(v_new_a <> v_old_a AND (SELECT season_year FROM public.league_seasons WHERE id = v_new_a) = 2099, 'A did not roll to 2099');
  PERFORM pg_temp.assert((SELECT status::text FROM public.leagues WHERE id = i.a) = 'offseason', 'A is not in the offseason');
  SELECT count(*) INTO v_rows FROM public.roster_players WHERE league_season_id = v_new_a;
  PERFORM pg_temp.assert(v_rows = (SELECT count(*) FROM public.roster_players WHERE league_season_id = v_old_a), 'rollover changed the roster count');
  PERFORM pg_temp.assert((SELECT is_on_ir FROM public.roster_players WHERE league_season_id = v_new_a AND player_id = pg_temp.vet(13)), 'IR flag did not carry over');
  PERFORM pg_temp.assert((SELECT count(*) FROM public.roster_transactions WHERE league_season_id = v_new_a AND transaction_type = 'carry_over') = v_rows, 'carry-over history incomplete');
  PERFORM pg_temp.assert((SELECT count(*) FROM public.waiver_priorities WHERE league_season_id = v_new_a) = 3, 'waiver priorities not reseeded');
  PERFORM pg_temp.assert((SELECT count(*) FROM public.draft_picks WHERE league_id = i.a AND season_year = 2104) = 9, 'future picks not created');
  PERFORM pg_temp.act_as(i.u3);
  SELECT * INTO v_state FROM public.get_member_transaction_state(i.a3, i.a);
  PERFORM pg_temp.act_as(NULL);
  PERFORM pg_temp.assert(v_state.weekly_add_count = 0 AND v_state.faab_balance = 100, 'new season did not reset adds and FAAB');
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM public.weekly_lineups WHERE league_season_id = v_new_a), 'lineups leaked into the new season');
  PERFORM pg_temp.freeze_season(v_old_a);
  PERFORM pg_temp.freeze_season(v_old_b);
END $$;
SELECT pg_temp.checkpoint('season 1: rollover');

-- Rookie draft helper used by seasons 2 and 3 --------------------------------------
CREATE FUNCTION pg_temp.run_rookie_draft(p_league uuid, p_commissioner uuid, p_first_rookie int, p_listed_pick uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_draft uuid; v_member uuid; v_rookie int := p_first_rookie; v_status text; v_overall int := 0; v_total int;
BEGIN
  PERFORM pg_temp.act_as(NULL);
  PERFORM public.start_rookie_draft_atomic(p_league, 2, false, 30, 'commissioner_pick');
  SELECT id INTO v_draft FROM public.drafts WHERE league_id = p_league AND draft_type = 'snake' AND status = 'in_progress';
  PERFORM pg_temp.assert(v_draft IS NOT NULL, 'rookie draft did not start');
  SELECT count(*) INTO v_total FROM public.snake_draft_picks WHERE draft_id = v_draft;
  PERFORM pg_temp.assert(v_total = 6, 'rookie draft should have six slots, has ' || v_total);
  LOOP
    v_member := pg_temp.snake_clock(v_draft);
    EXIT WHEN v_member IS NULL;
    v_overall := v_overall + 1;
    PERFORM pg_temp.act_as(pg_temp.user_of(v_member));
    IF v_overall = 1 THEN
      PERFORM pg_temp.rejected('veteran in the rookie draft', pg_temp.try(format('SELECT public.make_snake_pick_atomic(%L, %L, %L)', v_draft, v_member, pg_temp.vet(31))), '%rookie%');
    END IF;
    IF v_overall = 2 THEN
      -- The commissioner pauses and resumes, then the manager's clock runs out
      -- and the draft waits for a commissioner pick.
      PERFORM pg_temp.act_as(p_commissioner);
      PERFORM public.pause_draft_atomic(v_draft, p_commissioner);
      PERFORM pg_temp.rejected('pick while paused', pg_temp.try(format('SELECT public.make_snake_pick_atomic(%L, %L, %L)', v_draft, v_member, pg_temp.rookie(v_rookie))), '%not in progress%');
      PERFORM public.resume_draft_atomic(v_draft, p_commissioner);
      PERFORM pg_temp.act_as(NULL);
      UPDATE public.snake_draft_picks SET timer_expires_at = now() - interval '1 second' WHERE draft_id = v_draft AND player_id IS NULL AND overall_pick = v_overall;
      PERFORM public.process_expired_snake_pick_atomic(v_draft);
      PERFORM pg_temp.assert((SELECT status::text FROM public.drafts WHERE id = v_draft) = 'paused', 'expired clock did not hand the draft to the commissioner');
      PERFORM pg_temp.act_as(p_commissioner);
      PERFORM public.commissioner_snake_pick_atomic(v_draft, v_member, pg_temp.rookie(v_rookie), p_commissioner);
      IF (SELECT status::text FROM public.drafts WHERE id = v_draft) = 'paused' THEN
        PERFORM public.resume_draft_atomic(v_draft, p_commissioner);
      END IF;
    ELSE
      PERFORM public.make_snake_pick_atomic(v_draft, v_member, pg_temp.rookie(v_rookie));
    END IF;
    PERFORM pg_temp.rejected('pick retry', pg_temp.try(format('SELECT public.make_snake_pick_atomic(%L, %L, %L)', v_draft, v_member, pg_temp.rookie(v_rookie))), 'not your pick|already|complete|not in progress');
    PERFORM pg_temp.assert(pg_temp.owner_of(p_league, pg_temp.rookie(v_rookie)) = v_member, 'rookie ' || v_rookie || ' did not land on the picking roster');
    v_rookie := v_rookie + 1;
  END LOOP;
  SELECT status::text INTO v_status FROM public.drafts WHERE id = v_draft;
  PERFORM pg_temp.assert(v_status = 'completed', 'rookie draft did not complete: ' || v_status);
  PERFORM pg_temp.assert((SELECT bool_and(is_used) FROM public.draft_picks p JOIN public.snake_draft_picks s ON s.draft_pick_id = p.id WHERE s.draft_id = v_draft), 'used picks not marked used');
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM public.trade_block_items WHERE pick_id = p_listed_pick), 'pick listing survived the pick being used');
  -- Rookies land on full rosters; the league stays in the draft until every
  -- manager trims back to size, then the commissioner activates it.
  PERFORM pg_temp.act_as(p_commissioner);
  PERFORM pg_temp.assert(NOT public.activate_rookie_draft_league_atomic(v_draft), 'league activated while rosters were over size');
  FOR v_member IN SELECT id FROM public.league_members WHERE league_id = p_league LOOP
    PERFORM pg_temp.act_as(pg_temp.user_of(v_member));
    WHILE pg_temp.active_count(v_member) > (SELECT roster_size FROM public.leagues WHERE id = p_league) LOOP
      PERFORM public.drop_player_atomic((
        SELECT r.id FROM public.roster_players r JOIN public.players p ON p.id = r.player_id
         WHERE r.member_id = v_member AND r.league_season_id = pg_temp.season(p_league) AND r.is_on_ir = false AND r.is_on_taxi = false AND p.years_exp > 0
         ORDER BY r.acquired_at DESC, r.id LIMIT 1));
    END LOOP;
  END LOOP;
  -- Trimming the last over-size roster activates the league on its own; an
  -- explicit activation afterwards is a no-op and never an error.
  PERFORM pg_temp.act_as(p_commissioner);
  IF (SELECT status::text FROM public.leagues WHERE id = p_league) <> 'active' THEN
    PERFORM pg_temp.assert(public.activate_rookie_draft_league_atomic(v_draft), 'league did not activate after the rookie draft');
  END IF;
  PERFORM pg_temp.ok('activation retry', pg_temp.try(format('SELECT public.activate_rookie_draft_league_atomic(%L)', v_draft)));
  PERFORM pg_temp.assert((SELECT status::text FROM public.leagues WHERE id = p_league) = 'active', 'league is not active after the rookie draft');
  PERFORM pg_temp.act_as(NULL);
  RETURN v_draft;
END $$;

-- Season 2: rookie drafts, taxi squads, tighter limits, claims that hit the limit ------
DO $$
DECLARE i ids%ROWTYPE; v_draft uuid; v_claim uuid; v_n int; v_state record; v_dropped uuid;
BEGIN
  SELECT * INTO i FROM ids;
  -- A2's listed pick is used in the draft; A3 picks twice in round one through the traded pick.
  v_draft := pg_temp.run_rookie_draft(i.a, i.u1, 1, pg_temp.pick('A2', 2099, 2));
  PERFORM pg_temp.assert((SELECT count(*) FROM public.snake_draft_picks WHERE draft_id = v_draft AND round = 1 AND member_id = i.a3) = 2, 'the traded pick did not move the slot');
  PERFORM pg_temp.act_as(NULL);
  PERFORM public.add_trade_block_item_atomic(i.b2, i.b, NULL, pg_temp.pick('B2', 2099, 1), NULL, i.u3);
  PERFORM pg_temp.run_rookie_draft(i.b, i.u2, 7, pg_temp.pick('B2', 2099, 1));
  PERFORM pg_temp.checkpoint('season 2: rookie drafts');

  -- Taxi squads: rookies only, within the slot count.
  PERFORM pg_temp.act_as(i.u3);
  PERFORM public.toggle_taxi_atomic(pg_temp.row_of(i.b2, pg_temp.any_player(i.b2, true)), true, i.u3);
  PERFORM pg_temp.assert((SELECT count(*) FROM public.roster_players WHERE member_id = i.b2 AND league_season_id = pg_temp.season(i.b) AND is_on_taxi) = 1, 'taxi move did not take');
  -- Settings change between seasons: A tightens to 2 adds a week, B gains a limit of 1.
  UPDATE public.leagues SET weekly_add_limit = 2 WHERE id = i.a;
  UPDATE public.leagues SET weekly_add_limit = 1 WHERE id = i.b;
  PERFORM pg_temp.act_as(i.u3);
  PERFORM public.drop_player_atomic(pg_temp.row_of(i.a3, pg_temp.any_player(i.a3, false)));
  PERFORM public.drop_player_atomic(pg_temp.row_of(i.a3, pg_temp.any_player(i.a3, false)));
  PERFORM pg_temp.ok('A3 add under new limit', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.a3, i.a, pg_temp.vet(32))));
  PERFORM pg_temp.ok('A3 second add', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.a3, i.a, pg_temp.vet(33))));
  PERFORM pg_temp.rejected('A3 third add', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.a3, i.a, pg_temp.vet(34))), 'PA001: Weekly add limit reached (2/2%');
  -- B2 spends its one add, then a claim past the limit fails at submission for B2
  -- and at processing for B3, who spends the add after claiming.
  v_dropped := pg_temp.any_player(i.b2, false);
  PERFORM public.drop_player_atomic(pg_temp.row_of(i.b2, v_dropped));
  PERFORM pg_temp.ok('B2 one add', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.b2, i.b, pg_temp.vet(35))));
  PERFORM pg_temp.act_as(NULL);
  PERFORM pg_temp.rejected('claim past the limit at submission', pg_temp.try(format('SELECT public.create_waiver_claim_atomic(%L, %L, %L, NULL, %L, 0)', i.b, i.b2, v_dropped, i.u3)), 'PA001:%');
  v_claim := public.create_waiver_claim_atomic(i.b, i.b3, v_dropped, NULL, i.u4, 0);
  PERFORM pg_temp.act_as(i.u4);
  PERFORM public.drop_player_atomic(pg_temp.row_of(i.b3, pg_temp.any_player(i.b3, false)));
  PERFORM public.drop_player_atomic(pg_temp.row_of(i.b3, pg_temp.any_player(i.b3, false)));
  PERFORM pg_temp.ok('B3 one add', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.b3, i.b, pg_temp.vet(36))));
  PERFORM pg_temp.make_claims_due(i.b);
  v_n := pg_temp.process_claims();
  PERFORM pg_temp.assert((SELECT failure_reason FROM public.waiver_claims WHERE id = v_claim) LIKE 'Weekly add limit reached%', 'claim past the limit did not record the limit as its reason');
  PERFORM pg_temp.assert(pg_temp.owner_of(i.b, v_dropped) IS NULL, 'a failed claim rostered the player');
  PERFORM pg_temp.next_week(2099);
  PERFORM pg_temp.act_as(i.u4);
  SELECT * INTO v_state FROM public.get_member_transaction_state(i.b3, i.b);
  PERFORM pg_temp.act_as(NULL);
  PERFORM pg_temp.assert(v_state.weekly_add_count = 0, 'B week did not reset');
  -- The run also expired the entry nobody could claim, so next week the player is a free agent.
  PERFORM pg_temp.assert(NOT EXISTS (SELECT 1 FROM public.waiver_wire_log WHERE player_id = v_dropped AND cleared_at IS NULL), 'the run left an unclaimed entry open');
  PERFORM pg_temp.act_as(i.u4);
  PERFORM pg_temp.ok('B3 adds next week', pg_temp.try(format('SELECT public.add_free_agent_atomic(%L, %L, %L)', i.b3, i.b, v_dropped)));
  PERFORM pg_temp.assert(pg_temp.owner_of(i.b, v_dropped) = i.b3, 'the next-week add did not land');
  PERFORM pg_temp.checkpoint('season 2: activity');

  PERFORM pg_temp.act_as(NULL);
  PERFORM pg_temp.close_out(i.a);
  PERFORM pg_temp.close_out(i.b);
  UPDATE public.leagues SET status = 'playoffs' WHERE id IN (i.a, i.b);
  PERFORM pg_temp.freeze_season(pg_temp.season(i.a));
  PERFORM pg_temp.freeze_season(pg_temp.season(i.b));
  PERFORM public.advance_season_atomic(i.a);
  PERFORM public.advance_season_atomic(i.b);
  PERFORM pg_temp.assert((SELECT season_year FROM public.league_seasons WHERE id = pg_temp.season(i.a)) = 2100, 'A did not roll to 2100');
  PERFORM pg_temp.assert((SELECT bool_and(is_on_taxi) FROM public.roster_players WHERE league_season_id = pg_temp.season(i.b) AND member_id = i.b2 AND player_id IN (SELECT player_id FROM public.roster_players WHERE league_season_id = (SELECT id FROM public.league_seasons WHERE league_id = i.b AND season_year = 2099) AND is_on_taxi)), 'taxi flag did not carry over');
END $$;
SELECT pg_temp.checkpoint('season 2: rollover');

-- Season 3: second rookie class, more churn, and the third rollover ------------------
DO $$
DECLARE i ids%ROWTYPE; v_t uuid; v_n int; v_old_a uuid; v_old_b uuid; v_vet uuid;
BEGIN
  SELECT * INTO i FROM ids;
  PERFORM pg_temp.act_as(NULL);
  PERFORM public.add_trade_block_item_atomic(i.a1, i.a, NULL, pg_temp.pick('A1', 2100, 2), NULL, i.u1);
  -- A pick of the class sits in an accepted, uncompleted trade: the draft waits.
  v_t := public.propose_trade_atomic(i.a, pg_temp.season(i.a), i.a2, i.a3, '{}', '{}', ARRAY[pg_temp.pick('A2', 2100, 1)], ARRAY[pg_temp.pick('A3', 2100, 2)]);
  PERFORM public.accept_trade_atomic(v_t, i.a3);
  PERFORM pg_temp.rejected('rookie draft with a reserved pick', pg_temp.try(format('SELECT public.start_rookie_draft_atomic(%L, 2, false, 30, %L)', i.a, 'commissioner_pick')), '%reserved%');
  v_n := pg_temp.complete_due_trades();
  PERFORM pg_temp.assert(pg_temp.trade_status(v_t) = 'completed', 'the pick trade did not complete');
  PERFORM pg_temp.run_rookie_draft(i.a, i.u1, 7, pg_temp.pick('A1', 2100, 2));
  PERFORM pg_temp.run_rookie_draft(i.b, i.u2, 1, pg_temp.pick('B1', 2100, 1));
  PERFORM pg_temp.checkpoint('season 3: rookie drafts');
  -- A trade of a rookie for a veteran, completed; the veteran is then listed, slotted, and dropped.
  v_vet := pg_temp.any_player(i.a2, false);
  v_t := public.propose_trade_atomic(i.a, pg_temp.season(i.a), i.a1, i.a2, ARRAY[pg_temp.any_player(i.a1, true)], ARRAY[v_vet], '{}', '{}');
  PERFORM public.accept_trade_atomic(v_t, i.a2);
  v_n := pg_temp.complete_due_trades();
  PERFORM pg_temp.assert(pg_temp.trade_status(v_t) = 'completed', 'season 3 trade did not complete');
  PERFORM pg_temp.assert(pg_temp.owner_of(i.a, v_vet) = i.a1, 'season 3 trade did not move the veteran');
  PERFORM public.add_trade_block_item_atomic(i.a1, i.a, v_vet, NULL, NULL, i.u1);
  INSERT INTO public.weekly_lineups (league_id, league_season_id, member_id, player_id, slot_type, game_date)
  VALUES (i.a, pg_temp.season(i.a), i.a1, v_vet, 'UTIL', (now() AT TIME ZONE 'America/New_York')::date + 1);
  PERFORM pg_temp.act_as(i.u1);
  PERFORM public.drop_player_atomic(pg_temp.row_of(i.a1, v_vet));
  PERFORM pg_temp.assert(NOT pg_temp.listed(i.a1, v_vet), 'season 3 listing survived the drop');
  PERFORM pg_temp.checkpoint('season 3: activity');

  PERFORM pg_temp.act_as(NULL);
  PERFORM pg_temp.close_out(i.a);
  PERFORM pg_temp.close_out(i.b);
  v_old_a := pg_temp.season(i.a); v_old_b := pg_temp.season(i.b);
  UPDATE public.leagues SET status = 'playoffs' WHERE id IN (i.a, i.b);
  PERFORM pg_temp.freeze_season(v_old_a);
  PERFORM pg_temp.freeze_season(v_old_b);
  PERFORM public.advance_season_atomic(i.a);
  PERFORM public.advance_season_atomic(i.b);
  PERFORM pg_temp.assert((SELECT season_year FROM public.league_seasons WHERE id = pg_temp.season(i.a)) = 2101, 'A did not roll to 2101');
  PERFORM pg_temp.assert((SELECT count(*) FROM public.roster_players WHERE league_season_id = pg_temp.season(i.a)) = (SELECT count(*) FROM public.roster_players WHERE league_season_id = v_old_a), 'third rollover changed the roster count');
END $$;
SELECT pg_temp.checkpoint('season 3: rollover');

DO $$
DECLARE v_row record;
BEGIN
  FOR v_row IN SELECT * FROM sim_history ORDER BY checked_at LOOP
    RAISE NOTICE '% | transactions % | wire % | trades % | activity %', rpad(v_row.label, 28), v_row.transactions, v_row.wire, v_row.trades, v_row.activity;
  END LOOP;
  RAISE NOTICE 'three-season simulation: every phase held';
END $$;

ROLLBACK;
