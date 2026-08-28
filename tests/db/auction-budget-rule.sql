-- Auction budget rule: a manager may spend the full remaining budget and finish
-- the draft with open roster slots (filled later through waivers or free
-- agency). There is no $1-per-unfilled-slot reserve in live or mock drafts.
-- Covers exact-budget bids, zero budget, ties, retries, commissioner actions
-- (bidding, pause/resume), different roster sizes, auto-award when nobody can
-- outbid, draft completion, and the free-agent fill afterwards.
-- Runs inside one transaction and rolls back.
BEGIN;

INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-0000000e0001', 'authenticated', 'authenticated', 'auction-a@example.test', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-0000000e0002', 'authenticated', 'authenticated', 'auction-b@example.test', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-0000000e0003', 'authenticated', 'authenticated', 'auction-c@example.test', 'x', now(), '{}', '{}', now(), now());
INSERT INTO public.profiles (id, username, display_name)
VALUES
  ('00000000-0000-0000-0000-0000000e0001', 'auction_a', 'Auction A'),
  ('00000000-0000-0000-0000-0000000e0002', 'auction_b', 'Auction B'),
  ('00000000-0000-0000-0000-0000000e0003', 'auction_c', 'Auction C')
ON CONFLICT (id) DO NOTHING;

-- League L: 5 roster slots, $10 budgets. League L2: 13 slots, $3 budgets.
INSERT INTO public.leagues (id, name, slug, commissioner_id, status, roster_size, auction_budget, weekly_add_limit)
VALUES
  ('00000000-0000-0000-0000-0000000e0101', 'Auction Budget Rule', 'auction-budget-rule', '00000000-0000-0000-0000-0000000e0001', 'drafting', 5, 10, NULL),
  ('00000000-0000-0000-0000-0000000e0102', 'Auction Budget Rule Wide', 'auction-budget-rule-wide', '00000000-0000-0000-0000-0000000e0001', 'drafting', 13, 3, NULL);
INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES
  ('00000000-0000-0000-0000-0000000e0201', '00000000-0000-0000-0000-0000000e0101', '00000000-0000-0000-0000-0000000e0001', 'commissioner', 'Team A'),
  ('00000000-0000-0000-0000-0000000e0202', '00000000-0000-0000-0000-0000000e0101', '00000000-0000-0000-0000-0000000e0002', 'manager', 'Team B'),
  ('00000000-0000-0000-0000-0000000e0203', '00000000-0000-0000-0000-0000000e0101', '00000000-0000-0000-0000-0000000e0003', 'manager', 'Team C'),
  ('00000000-0000-0000-0000-0000000e0211', '00000000-0000-0000-0000-0000000e0102', '00000000-0000-0000-0000-0000000e0001', 'commissioner', 'Wide A'),
  ('00000000-0000-0000-0000-0000000e0212', '00000000-0000-0000-0000-0000000e0102', '00000000-0000-0000-0000-0000000e0002', 'manager', 'Wide B');
INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES
  ('00000000-0000-0000-0000-0000000e0301', '00000000-0000-0000-0000-0000000e0101', 2099, true),
  ('00000000-0000-0000-0000-0000000e0302', '00000000-0000-0000-0000-0000000e0102', 2099, true);
INSERT INTO public.players (id, first_name, last_name, nba_team, position, years_exp, eligible_positions)
SELECT ('00000000-0000-0000-0000-0000000e04' || lpad(n::text, 2, '0'))::uuid, 'Auction', 'Player ' || n, 'DAL', 'SF', 2, ARRAY['SF']
  FROM generate_series(1, 8) AS n;

INSERT INTO public.drafts (id, league_id, league_season_id, draft_type, status, budget_per_team, started_at, pick_timer_seconds, rounds, current_nomination_order)
VALUES
  ('00000000-0000-0000-0000-0000000e0601', '00000000-0000-0000-0000-0000000e0101', '00000000-0000-0000-0000-0000000e0301', 'auction', 'in_progress', 10, now(), 30, NULL, 1),
  ('00000000-0000-0000-0000-0000000e0602', '00000000-0000-0000-0000-0000000e0102', '00000000-0000-0000-0000-0000000e0302', 'auction', 'in_progress', 3, now(), 30, NULL, 1);
INSERT INTO public.drafts (id, league_id, league_season_id, draft_type, status, budget_per_team, started_at, pick_timer_seconds, rounds, current_nomination_order, is_mock)
VALUES ('00000000-0000-0000-0000-0000000e0603', '00000000-0000-0000-0000-0000000e0101', '00000000-0000-0000-0000-0000000e0301', 'auction', 'in_progress', 10, now(), 30, NULL, 1, true);
INSERT INTO public.draft_orders (draft_id, member_id, position)
VALUES
  ('00000000-0000-0000-0000-0000000e0601', '00000000-0000-0000-0000-0000000e0201', 1),
  ('00000000-0000-0000-0000-0000000e0601', '00000000-0000-0000-0000-0000000e0202', 2),
  ('00000000-0000-0000-0000-0000000e0601', '00000000-0000-0000-0000-0000000e0203', 3);
INSERT INTO public.draft_budgets (draft_id, member_id, initial_budget, remaining)
VALUES
  ('00000000-0000-0000-0000-0000000e0601', '00000000-0000-0000-0000-0000000e0201', 10, 10),
  ('00000000-0000-0000-0000-0000000e0601', '00000000-0000-0000-0000-0000000e0202', 10, 10),
  ('00000000-0000-0000-0000-0000000e0601', '00000000-0000-0000-0000-0000000e0203', 10, 10),
  ('00000000-0000-0000-0000-0000000e0602', '00000000-0000-0000-0000-0000000e0211', 3, 3),
  ('00000000-0000-0000-0000-0000000e0602', '00000000-0000-0000-0000-0000000e0212', 3, 3),
  ('00000000-0000-0000-0000-0000000e0603', '00000000-0000-0000-0000-0000000e0201', 10, 10),
  ('00000000-0000-0000-0000-0000000e0603', '00000000-0000-0000-0000-0000000e0203', 10, 10);

CREATE TEMP TABLE auction_ids AS
SELECT
  '00000000-0000-0000-0000-0000000e0601'::uuid AS draft_id,
  '00000000-0000-0000-0000-0000000e0602'::uuid AS wide_draft_id,
  '00000000-0000-0000-0000-0000000e0603'::uuid AS mock_draft_id,
  '00000000-0000-0000-0000-0000000e0101'::uuid AS league_id,
  '00000000-0000-0000-0000-0000000e0001'::uuid AS user_a,
  '00000000-0000-0000-0000-0000000e0002'::uuid AS user_b,
  '00000000-0000-0000-0000-0000000e0003'::uuid AS user_c,
  '00000000-0000-0000-0000-0000000e0201'::uuid AS member_a,
  '00000000-0000-0000-0000-0000000e0202'::uuid AS member_b,
  '00000000-0000-0000-0000-0000000e0203'::uuid AS member_c,
  '00000000-0000-0000-0000-0000000e0211'::uuid AS wide_a,
  '00000000-0000-0000-0000-0000000e0212'::uuid AS wide_b;

CREATE OR REPLACE FUNCTION pg_temp.nominate(p_draft uuid, p_member uuid, p_player uuid, p_order int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.nominations (id, draft_id, nominating_member_id, player_id, nomination_order, status, current_bid_amount, current_bidder_id, countdown_expires_at)
  VALUES (v_id, p_draft, p_member, p_player, p_order, 'open', 0, NULL, now() + interval '60 seconds');
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.bid(p_draft uuid, p_member uuid, p_user uuid, p_nomination uuid, p_amount int) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.place_auction_bid_atomic(p_draft, p_member, p_nomination, p_amount, p_user);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.expect_ok(p_case text, p_result text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_result IS NOT NULL THEN RAISE EXCEPTION '%: unexpected rejection: %', p_case, p_result; END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.expect_rejected(p_case text, p_result text, p_like text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_result IS NULL THEN RAISE EXCEPTION '%: bid was accepted', p_case; END IF;
  IF p_result NOT LIKE p_like THEN RAISE EXCEPTION '%: unexpected rejection: %', p_case, p_result; END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.remaining(p_draft uuid, p_member uuid) RETURNS int LANGUAGE sql AS $$
  SELECT remaining FROM public.draft_budgets WHERE draft_id = p_draft AND member_id = p_member
$$;

-- One nomination may be open per draft, so each scenario opens its own.
CREATE TEMP TABLE auction_noms (n1 uuid, n2 uuid, n3 uuid, n4 uuid, n5 uuid);
INSERT INTO auction_noms (n1, n4, n5) VALUES (
  pg_temp.nominate('00000000-0000-0000-0000-0000000e0601', '00000000-0000-0000-0000-0000000e0201', '00000000-0000-0000-0000-0000000e0401', 1),
  pg_temp.nominate('00000000-0000-0000-0000-0000000e0602', '00000000-0000-0000-0000-0000000e0211', '00000000-0000-0000-0000-0000000e0405', 1),
  pg_temp.nominate('00000000-0000-0000-0000-0000000e0603', '00000000-0000-0000-0000-0000000e0201', '00000000-0000-0000-0000-0000000e0406', 1)
);

-- T1: exact remaining budget on an empty five-slot roster is a legal bid, and
-- it auto-awards because nobody can outbid.
DO $$
DECLARE ids auction_ids%ROWTYPE; noms auction_noms%ROWTYPE; v_nom public.nominations%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM auction_ids; SELECT * INTO noms FROM auction_noms;
  PERFORM pg_temp.expect_ok('T1 exact budget', pg_temp.bid(ids.draft_id, ids.member_b, ids.user_b, noms.n1, 10));
  SELECT * INTO v_nom FROM public.nominations WHERE id = noms.n1;
  IF v_nom.status <> 'sold' OR v_nom.winning_member_id <> ids.member_b OR v_nom.final_price <> 10 THEN
    RAISE EXCEPTION 'T1: expected auto-award to B at $10, got % / % / %', v_nom.status, v_nom.winning_member_id, v_nom.final_price;
  END IF;
  IF pg_temp.remaining(ids.draft_id, ids.member_b) <> 0 THEN RAISE EXCEPTION 'T1: B should have $0 left'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.roster_players WHERE member_id = ids.member_b AND player_id = '00000000-0000-0000-0000-0000000e0401') THEN
    RAISE EXCEPTION 'T1: won player was not rostered';
  END IF;
END $$;

-- T2: zero budget cannot bid; the manager fills the roster later instead.
UPDATE auction_noms SET n2 = pg_temp.nominate('00000000-0000-0000-0000-0000000e0601', '00000000-0000-0000-0000-0000000e0201', '00000000-0000-0000-0000-0000000e0402', 2);
DO $$
DECLARE ids auction_ids%ROWTYPE; noms auction_noms%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM auction_ids; SELECT * INTO noms FROM auction_noms;
  PERFORM pg_temp.expect_rejected('T2 zero budget', pg_temp.bid(ids.draft_id, ids.member_b, ids.user_b, noms.n2, 1), 'Insufficient budget (you have $0 remaining)%');
END $$;

-- T3: ties are not bids, and a retry of a standing bid is refused without changing anything.
DO $$
DECLARE ids auction_ids%ROWTYPE; noms auction_noms%ROWTYPE; v_nom public.nominations%ROWTYPE; v_bids int;
BEGIN
  SELECT * INTO ids FROM auction_ids; SELECT * INTO noms FROM auction_noms;
  PERFORM pg_temp.expect_ok('T3 first bid', pg_temp.bid(ids.draft_id, ids.member_c, ids.user_c, noms.n2, 5));
  PERFORM pg_temp.expect_rejected('T3 tie', pg_temp.bid(ids.draft_id, ids.member_a, ids.user_a, noms.n2, 5), 'Bid must exceed current bid of $5%');
  PERFORM pg_temp.expect_ok('T3 raise', pg_temp.bid(ids.draft_id, ids.member_a, ids.user_a, noms.n2, 6));
  PERFORM pg_temp.expect_rejected('T3 retry of the same bid', pg_temp.bid(ids.draft_id, ids.member_a, ids.user_a, noms.n2, 6), 'Bid must exceed current bid of $6%');
  PERFORM pg_temp.expect_rejected('T3 raising own bid', pg_temp.bid(ids.draft_id, ids.member_a, ids.user_a, noms.n2, 7), 'You are already the highest bidder%');
  PERFORM pg_temp.expect_rejected('T3 stale tie', pg_temp.bid(ids.draft_id, ids.member_c, ids.user_c, noms.n2, 6), 'Bid must exceed current bid of $6%');
  SELECT * INTO v_nom FROM public.nominations WHERE id = noms.n2;
  SELECT count(*) INTO v_bids FROM public.bids WHERE nomination_id = noms.n2;
  IF v_nom.status <> 'open' OR v_nom.current_bid_amount <> 6 OR v_nom.current_bidder_id <> ids.member_a OR v_bids <> 2 THEN
    RAISE EXCEPTION 'T3: unexpected state % / % / % / % bids', v_nom.status, v_nom.current_bid_amount, v_nom.current_bidder_id, v_bids;
  END IF;
END $$;

-- T4: going all-in beats a standing bid and auto-awards when the rest cannot follow.
DO $$
DECLARE ids auction_ids%ROWTYPE; noms auction_noms%ROWTYPE; v_nom public.nominations%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM auction_ids; SELECT * INTO noms FROM auction_noms;
  PERFORM pg_temp.expect_ok('T4 all-in', pg_temp.bid(ids.draft_id, ids.member_c, ids.user_c, noms.n2, 10));
  SELECT * INTO v_nom FROM public.nominations WHERE id = noms.n2;
  IF v_nom.status <> 'sold' OR v_nom.winning_member_id <> ids.member_c OR pg_temp.remaining(ids.draft_id, ids.member_c) <> 0 THEN
    RAISE EXCEPTION 'T4: expected C to win at $10 with $0 left (% / %)', v_nom.status, pg_temp.remaining(ids.draft_id, ids.member_c);
  END IF;
END $$;

-- T5: the commissioner pauses and resumes, then spends the full budget; the
-- draft completes when nobody can bid, and the league goes active with open slots.
UPDATE auction_noms SET n3 = pg_temp.nominate('00000000-0000-0000-0000-0000000e0601', '00000000-0000-0000-0000-0000000e0201', '00000000-0000-0000-0000-0000000e0403', 3);
DO $$
DECLARE ids auction_ids%ROWTYPE; noms auction_noms%ROWTYPE; v_nom public.nominations%ROWTYPE; v_draft public.drafts%ROWTYPE; v_league_status text;
BEGIN
  SELECT * INTO ids FROM auction_ids; SELECT * INTO noms FROM auction_noms;
  PERFORM public.pause_draft_atomic(ids.draft_id, ids.user_a);
  PERFORM pg_temp.expect_rejected('T5 paused', pg_temp.bid(ids.draft_id, ids.member_a, ids.user_a, noms.n3, 10), 'Draft is not in progress%');
  PERFORM public.resume_draft_atomic(ids.draft_id, ids.user_a);
  PERFORM pg_temp.expect_ok('T5 commissioner all-in', pg_temp.bid(ids.draft_id, ids.member_a, ids.user_a, noms.n3, 10));
  SELECT * INTO v_nom FROM public.nominations WHERE id = noms.n3;
  SELECT * INTO v_draft FROM public.drafts WHERE id = ids.draft_id;
  SELECT status::text INTO v_league_status FROM public.leagues WHERE id = ids.league_id;
  IF v_nom.status <> 'sold' OR pg_temp.remaining(ids.draft_id, ids.member_a) <> 0 THEN
    RAISE EXCEPTION 'T5: commissioner bid did not award (% / %)', v_nom.status, pg_temp.remaining(ids.draft_id, ids.member_a);
  END IF;
  IF v_draft.status <> 'completed' OR v_league_status <> 'active' THEN
    RAISE EXCEPTION 'T5: draft should complete once every budget is spent (% / %)', v_draft.status, v_league_status;
  END IF;
  IF (SELECT count(*) FROM public.roster_players WHERE league_id = ids.league_id) <> 3 THEN
    RAISE EXCEPTION 'T5: expected three rostered players and open slots everywhere';
  END IF;
END $$;

-- T6: a wider roster changes nothing: an exact $3 bid on an empty 13-slot roster is legal.
DO $$
DECLARE ids auction_ids%ROWTYPE; noms auction_noms%ROWTYPE; v_nom public.nominations%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM auction_ids; SELECT * INTO noms FROM auction_noms;
  PERFORM pg_temp.expect_ok('T6 wide roster', pg_temp.bid(ids.wide_draft_id, ids.wide_a, ids.user_a, noms.n4, 3));
  SELECT * INTO v_nom FROM public.nominations WHERE id = noms.n4;
  IF v_nom.status <> 'sold' OR v_nom.winning_member_id <> ids.wide_a THEN
    RAISE EXCEPTION 'T6: expected auto-award on the wide roster, got %', v_nom.status;
  END IF;
END $$;

-- T7: open slots are filled through free agency after the draft.
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0002', true);
SELECT public.add_free_agent_atomic('00000000-0000-0000-0000-0000000e0202', '00000000-0000-0000-0000-0000000e0101', '00000000-0000-0000-0000-0000000e0407');
DO $$
DECLARE ids auction_ids%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM auction_ids;
  IF (SELECT count(*) FROM public.roster_players WHERE member_id = ids.member_b) <> 2 THEN
    RAISE EXCEPTION 'T7: free-agent add after an all-in draft did not land';
  END IF;
END $$;
SELECT set_config('request.jwt.claim.sub', '', true);

-- T8: mock rooms accept the full remaining budget too and never auto-award.
DO $$
DECLARE ids auction_ids%ROWTYPE; noms auction_noms%ROWTYPE; v_nom public.nominations%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM auction_ids; SELECT * INTO noms FROM auction_noms;
  PERFORM pg_temp.expect_ok('T8 mock all-in', pg_temp.bid(ids.mock_draft_id, ids.member_c, ids.user_c, noms.n5, 10));
  SELECT * INTO v_nom FROM public.nominations WHERE id = noms.n5;
  IF v_nom.status <> 'open' OR v_nom.current_bid_amount <> 10 THEN
    RAISE EXCEPTION 'T8: mock nomination should stay open at $10, got % / %', v_nom.status, v_nom.current_bid_amount;
  END IF;
  RAISE NOTICE 'auction budget rule holds';
END $$;

ROLLBACK;
