-- Roster lifecycle invariants: every path that removes a player from a roster
-- (or makes the player inactive) must leave no stale roster-linked state behind,
-- while history rows (transactions, waiver log, succeeded claims) survive.
-- Runs inside one transaction and rolls back.
BEGIN;

INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-0000000a0001', 'authenticated', 'authenticated', 'lifecycle-a@example.test', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-0000000a0002', 'authenticated', 'authenticated', 'lifecycle-b@example.test', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-0000000a0003', 'authenticated', 'authenticated', 'lifecycle-c@example.test', 'x', now(), '{}', '{}', now(), now());

INSERT INTO public.profiles (id, username, display_name)
VALUES
  ('00000000-0000-0000-0000-0000000a0001', 'lifecycle_a', 'Lifecycle A'),
  ('00000000-0000-0000-0000-0000000a0002', 'lifecycle_b', 'Lifecycle B'),
  ('00000000-0000-0000-0000-0000000a0003', 'lifecycle_c', 'Lifecycle C')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.leagues (id, name, slug, commissioner_id, status, waiver_mode, weekly_add_limit, taxi_slots)
VALUES ('00000000-0000-0000-0000-0000000a0101', 'Roster Lifecycle', 'roster-lifecycle', '00000000-0000-0000-0000-0000000a0001', 'active', 'faab', NULL, 2);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES
  ('00000000-0000-0000-0000-0000000a0201', '00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0001', 'commissioner', 'Team A'),
  ('00000000-0000-0000-0000-0000000a0202', '00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0002', 'manager', 'Team B'),
  ('00000000-0000-0000-0000-0000000a0203', '00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0003', 'manager', 'Team C');

INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES
  ('00000000-0000-0000-0000-0000000a0300', '00000000-0000-0000-0000-0000000a0101', 2098, false),
  ('00000000-0000-0000-0000-0000000a0301', '00000000-0000-0000-0000-0000000a0101', 2099, true);

INSERT INTO public.season_weeks (season_year, week_number, week_start, week_end)
VALUES (2099, 1, current_date - 30, current_date + 400);

INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
VALUES
  ('00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0301', '00000000-0000-0000-0000-0000000a0201', 1),
  ('00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0301', '00000000-0000-0000-0000-0000000a0202', 2),
  ('00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0301', '00000000-0000-0000-0000-0000000a0203', 3);

INSERT INTO public.players (id, first_name, last_name, nba_team, position, years_exp, eligible_positions, injury_status, nba_draft_number)
VALUES
  ('00000000-0000-0000-0000-0000000a0401', 'Cooper', 'Flagg', 'DAL', 'SF', 0, ARRAY['SF', 'PF'], NULL, 1),
  ('00000000-0000-0000-0000-0000000a0402', 'Injured', 'Wing', 'BOS', 'SG', 3, ARRAY['SG'], 'Out', 20),
  ('00000000-0000-0000-0000-0000000a0403', 'Taxi', 'Rookie', 'MIA', 'PG', 0, ARRAY['PG'], NULL, 30),
  ('00000000-0000-0000-0000-0000000a0404', 'Waiver', 'Drop', 'LAL', 'C', 4, ARRAY['C'], NULL, 40),
  ('00000000-0000-0000-0000-0000000a0405', 'Trade', 'Piece', 'DEN', 'PF', 5, ARRAY['PF'], NULL, 50),
  ('00000000-0000-0000-0000-0000000a0406', 'Offer', 'Asset', 'GSW', 'SG', 2, ARRAY['SG'], NULL, 60),
  ('00000000-0000-0000-0000-0000000a0407', 'Carry', 'Over', 'NYK', 'PG', 6, ARRAY['PG'], NULL, 70),
  ('00000000-0000-0000-0000-0000000a0408', 'Waiver', 'Target', 'FA', 'SF', 1, ARRAY['SF'], NULL, 80),
  ('00000000-0000-0000-0000-0000000a0409', 'Second', 'Target', 'FA', 'C', 1, ARRAY['C'], NULL, 90),
  ('00000000-0000-0000-0000-0000000a0410', 'Dup', 'Loser', 'CHI', 'F', 2, ARRAY['F'], NULL, 100),
  ('00000000-0000-0000-0000-0000000a0411', 'Dup', 'Winner', 'CHI', 'F', 2, ARRAY['F'], NULL, 101);

INSERT INTO public.roster_players (id, league_id, league_season_id, member_id, player_id, acquired_via)
VALUES
  ('00000000-0000-0000-0000-0000000a0501', '00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0301', '00000000-0000-0000-0000-0000000a0201', '00000000-0000-0000-0000-0000000a0401', 'draft'),
  ('00000000-0000-0000-0000-0000000a0502', '00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0301', '00000000-0000-0000-0000-0000000a0201', '00000000-0000-0000-0000-0000000a0402', 'draft'),
  ('00000000-0000-0000-0000-0000000a0503', '00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0301', '00000000-0000-0000-0000-0000000a0201', '00000000-0000-0000-0000-0000000a0403', 'draft'),
  ('00000000-0000-0000-0000-0000000a0504', '00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0301', '00000000-0000-0000-0000-0000000a0202', '00000000-0000-0000-0000-0000000a0404', 'draft'),
  ('00000000-0000-0000-0000-0000000a0505', '00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0301', '00000000-0000-0000-0000-0000000a0202', '00000000-0000-0000-0000-0000000a0405', 'draft'),
  ('00000000-0000-0000-0000-0000000a0506', '00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0301', '00000000-0000-0000-0000-0000000a0203', '00000000-0000-0000-0000-0000000a0406', 'draft'),
  ('00000000-0000-0000-0000-0000000a0507', '00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0301', '00000000-0000-0000-0000-0000000a0203', '00000000-0000-0000-0000-0000000a0407', 'draft'),
  ('00000000-0000-0000-0000-0000000a0510', '00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0301', '00000000-0000-0000-0000-0000000a0202', '00000000-0000-0000-0000-0000000a0410', 'draft'),
  ('00000000-0000-0000-0000-0000000a0517', '00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0300', '00000000-0000-0000-0000-0000000a0203', '00000000-0000-0000-0000-0000000a0407', 'draft');

INSERT INTO public.draft_picks (id, league_id, season_year, round, original_owner_id, current_owner_id)
VALUES
  ('00000000-0000-0000-0000-0000000a0601', '00000000-0000-0000-0000-0000000a0101', 2100, 1, '00000000-0000-0000-0000-0000000a0201', '00000000-0000-0000-0000-0000000a0201'),
  ('00000000-0000-0000-0000-0000000a0602', '00000000-0000-0000-0000-0000000a0101', 2100, 1, '00000000-0000-0000-0000-0000000a0202', '00000000-0000-0000-0000-0000000a0202');

INSERT INTO public.waiver_wire_log (league_id, league_season_id, player_id, dropped_by_member_id, placed_on_waivers_at, clears_at)
VALUES
  ('00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0301', '00000000-0000-0000-0000-0000000a0408', '00000000-0000-0000-0000-0000000a0203', now() - interval '3 days', now() - interval '1 minute'),
  ('00000000-0000-0000-0000-0000000a0101', '00000000-0000-0000-0000-0000000a0301', '00000000-0000-0000-0000-0000000a0409', '00000000-0000-0000-0000-0000000a0203', now() - interval '3 days', now() - interval '1 minute');

CREATE TEMP TABLE lifecycle_ids AS
SELECT
  '00000000-0000-0000-0000-0000000a0101'::uuid AS league_id,
  '00000000-0000-0000-0000-0000000a0301'::uuid AS season_id,
  '00000000-0000-0000-0000-0000000a0300'::uuid AS old_season_id,
  '00000000-0000-0000-0000-0000000a0001'::uuid AS user_a,
  '00000000-0000-0000-0000-0000000a0002'::uuid AS user_b,
  '00000000-0000-0000-0000-0000000a0003'::uuid AS user_c,
  '00000000-0000-0000-0000-0000000a0201'::uuid AS member_a,
  '00000000-0000-0000-0000-0000000a0202'::uuid AS member_b,
  '00000000-0000-0000-0000-0000000a0203'::uuid AS member_c,
  '00000000-0000-0000-0000-0000000a0401'::uuid AS flagg,
  '00000000-0000-0000-0000-0000000a0402'::uuid AS injured,
  '00000000-0000-0000-0000-0000000a0403'::uuid AS rookie,
  '00000000-0000-0000-0000-0000000a0404'::uuid AS waiver_drop,
  '00000000-0000-0000-0000-0000000a0405'::uuid AS trade_piece,
  '00000000-0000-0000-0000-0000000a0406'::uuid AS offer_asset,
  '00000000-0000-0000-0000-0000000a0407'::uuid AS carry_over,
  '00000000-0000-0000-0000-0000000a0408'::uuid AS waiver_target,
  '00000000-0000-0000-0000-0000000a0409'::uuid AS second_target,
  '00000000-0000-0000-0000-0000000a0410'::uuid AS dup_loser,
  '00000000-0000-0000-0000-0000000a0411'::uuid AS dup_winner,
  '00000000-0000-0000-0000-0000000a0601'::uuid AS pick_a,
  '00000000-0000-0000-0000-0000000a0602'::uuid AS pick_b;

CREATE OR REPLACE FUNCTION pg_temp.listing_count(p_member uuid, p_player uuid DEFAULT NULL, p_pick uuid DEFAULT NULL)
RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int
    FROM public.trade_block_items
   WHERE member_id = p_member
     AND (p_player IS NULL OR player_id = p_player)
     AND (p_pick IS NULL OR pick_id = p_pick)
$$;

-- T1: a direct drop clears the listing and future lineup, and records history.
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0001', true);
SELECT public.add_trade_block_item_atomic(ids.member_a, ids.league_id, ids.flagg, NULL, 'Flagg available', ids.user_a) FROM lifecycle_ids AS ids;
INSERT INTO public.weekly_lineups (league_id, league_season_id, member_id, player_id, slot_type, game_date)
SELECT ids.league_id, ids.season_id, ids.member_a, ids.flagg, 'SF', current_date + 1 FROM lifecycle_ids AS ids;
SELECT public.drop_player_atomic('00000000-0000-0000-0000-0000000a0501');

DO $$
DECLARE ids lifecycle_ids%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM lifecycle_ids;
  IF pg_temp.listing_count(ids.member_a, ids.flagg) <> 0 THEN
    RAISE EXCEPTION 'T1: trade block listing survived a direct drop';
  END IF;
  IF EXISTS (SELECT 1 FROM public.weekly_lineups WHERE member_id = ids.member_a AND player_id = ids.flagg) THEN
    RAISE EXCEPTION 'T1: future lineup slot survived a direct drop';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.roster_transactions WHERE member_id = ids.member_a AND player_id = ids.flagg AND transaction_type = 'fa_drop') THEN
    RAISE EXCEPTION 'T1: drop transaction history missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.waiver_wire_log WHERE player_id = ids.flagg AND dropped_by_member_id = ids.member_a AND cleared_at IS NULL) THEN
    RAISE EXCEPTION 'T1: waiver wire history missing';
  END IF;
END $$;

-- T2: retrying the same drop fails cleanly and changes nothing.
DO $$
DECLARE ids lifecycle_ids%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM lifecycle_ids;
  BEGIN
    PERFORM public.drop_player_atomic('00000000-0000-0000-0000-0000000a0501');
    RAISE EXCEPTION 'T2: repeated drop did not fail';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN NULL;
  END;
  IF (SELECT count(*) FROM public.waiver_wire_log WHERE player_id = ids.flagg) <> 1 THEN
    RAISE EXCEPTION 'T2: retry duplicated waiver history';
  END IF;
END $$;

-- T3: an IR move clears the listing; returning to the active roster does not restore it.
SELECT public.add_trade_block_item_atomic(ids.member_a, ids.league_id, ids.injured, NULL, NULL, ids.user_a) FROM lifecycle_ids AS ids;
INSERT INTO public.weekly_lineups (league_id, league_season_id, member_id, player_id, slot_type, game_date)
SELECT ids.league_id, ids.season_id, ids.member_a, ids.injured, 'SG', current_date + 2 FROM lifecycle_ids AS ids;
SELECT public.toggle_ir_atomic('00000000-0000-0000-0000-0000000a0502', true, ids.user_a) FROM lifecycle_ids AS ids;
DO $$
DECLARE ids lifecycle_ids%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM lifecycle_ids;
  IF pg_temp.listing_count(ids.member_a, ids.injured) <> 0 THEN
    RAISE EXCEPTION 'T3: listing survived an IR move';
  END IF;
  IF EXISTS (SELECT 1 FROM public.weekly_lineups WHERE member_id = ids.member_a AND player_id = ids.injured) THEN
    RAISE EXCEPTION 'T3: future lineup slot survived an IR move';
  END IF;
END $$;
SELECT public.toggle_ir_atomic('00000000-0000-0000-0000-0000000a0502', false, ids.user_a) FROM lifecycle_ids AS ids;
DO $$
DECLARE ids lifecycle_ids%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM lifecycle_ids;
  IF pg_temp.listing_count(ids.member_a, ids.injured) <> 0 THEN
    RAISE EXCEPTION 'T3: activation resurrected a listing';
  END IF;
END $$;

-- T4: a taxi move clears the listing.
SELECT public.add_trade_block_item_atomic(ids.member_a, ids.league_id, ids.rookie, NULL, NULL, ids.user_a) FROM lifecycle_ids AS ids;
SELECT public.toggle_taxi_atomic('00000000-0000-0000-0000-0000000a0503', true, ids.user_a) FROM lifecycle_ids AS ids;
DO $$
DECLARE ids lifecycle_ids%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM lifecycle_ids;
  IF pg_temp.listing_count(ids.member_a, ids.rookie) <> 0 THEN
    RAISE EXCEPTION 'T4: listing survived a taxi move';
  END IF;
END $$;

-- T5: a processed waiver drop clears the listing but the succeeded claim keeps its drop as history.
SELECT public.add_trade_block_item_atomic(ids.member_b, ids.league_id, ids.waiver_drop, NULL, NULL, ids.user_b) FROM lifecycle_ids AS ids;
INSERT INTO public.waiver_claims (id, league_id, league_season_id, member_id, player_id, drop_player_id, priority_at_submission, process_date, bid_amount, claim_order)
SELECT '00000000-0000-0000-0000-0000000a0701', ids.league_id, ids.season_id, ids.member_b, ids.waiver_target, ids.waiver_drop, 2, current_date - 1, 0, 1
  FROM lifecycle_ids AS ids;
SELECT set_config('request.jwt.claim.sub', '', true);
CREATE TEMP TABLE lifecycle_waiver_result AS
SELECT * FROM public.process_next_waiver_claim_atomic(current_date);
DO $$
DECLARE ids lifecycle_ids%ROWTYPE; v_claim public.waiver_claims%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM lifecycle_ids;
  SELECT * INTO v_claim FROM public.waiver_claims WHERE id = '00000000-0000-0000-0000-0000000a0701';
  IF v_claim.status <> 'succeeded' THEN
    RAISE EXCEPTION 'T5: waiver claim did not succeed: % (%)', v_claim.status, v_claim.failure_reason;
  END IF;
  IF v_claim.drop_player_id IS DISTINCT FROM ids.waiver_drop THEN
    RAISE EXCEPTION 'T5: succeeded claim lost its drop player history';
  END IF;
  IF pg_temp.listing_count(ids.member_b, ids.waiver_drop) <> 0 THEN
    RAISE EXCEPTION 'T5: listing survived a waiver drop';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.roster_players WHERE member_id = ids.member_b AND player_id = ids.waiver_target) THEN
    RAISE EXCEPTION 'T5: waiver target was not rostered';
  END IF;
END $$;

-- T6: completing a trade clears both sides' listings for the moved player and pick.
SELECT public.add_trade_block_item_atomic(ids.member_a, ids.league_id, NULL, ids.pick_a, NULL, ids.user_a) FROM lifecycle_ids AS ids;
SELECT public.add_trade_block_item_atomic(ids.member_b, ids.league_id, ids.trade_piece, NULL, NULL, ids.user_b) FROM lifecycle_ids AS ids;
INSERT INTO public.trades (id, league_id, league_season_id, proposer_member_id, recipient_member_id, status, accepted_at, veto_window_expires_at)
SELECT '00000000-0000-0000-0000-0000000a0801', ids.league_id, ids.season_id, ids.member_a, ids.member_b, 'accepted', now() - interval '2 days', now() - interval '1 day'
  FROM lifecycle_ids AS ids;
INSERT INTO public.trade_items (trade_id, side, pick_id, from_member_id, to_member_id)
SELECT '00000000-0000-0000-0000-0000000a0801', 'proposer', ids.pick_a, ids.member_a, ids.member_b FROM lifecycle_ids AS ids;
INSERT INTO public.trade_items (trade_id, side, player_id, from_member_id, to_member_id)
SELECT '00000000-0000-0000-0000-0000000a0801', 'recipient', ids.trade_piece, ids.member_b, ids.member_a FROM lifecycle_ids AS ids;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT public.complete_accepted_trade_atomic('00000000-0000-0000-0000-0000000a0801');
DO $$
DECLARE ids lifecycle_ids%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM lifecycle_ids;
  IF (SELECT status FROM public.trades WHERE id = '00000000-0000-0000-0000-0000000a0801') <> 'completed' THEN
    RAISE EXCEPTION 'T6: trade did not complete';
  END IF;
  IF pg_temp.listing_count(ids.member_a, NULL, ids.pick_a) <> 0 THEN
    RAISE EXCEPTION 'T6: pick listing survived the trade';
  END IF;
  IF pg_temp.listing_count(ids.member_b, ids.trade_piece) <> 0 THEN
    RAISE EXCEPTION 'T6: player listing survived the trade';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.roster_players WHERE member_id = ids.member_a AND player_id = ids.trade_piece) THEN
    RAISE EXCEPTION 'T6: traded player did not move';
  END IF;
END $$;

-- T7: a pending offer expires with a reason when the offered player is dropped.
INSERT INTO public.trades (id, league_id, league_season_id, proposer_member_id, recipient_member_id)
SELECT '00000000-0000-0000-0000-0000000a0802', ids.league_id, ids.season_id, ids.member_c, ids.member_a FROM lifecycle_ids AS ids;
INSERT INTO public.trade_items (trade_id, side, player_id, from_member_id, to_member_id)
SELECT '00000000-0000-0000-0000-0000000a0802', 'proposer', ids.offer_asset, ids.member_c, ids.member_a FROM lifecycle_ids AS ids;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0003', true);
SELECT public.drop_player_atomic('00000000-0000-0000-0000-0000000a0506');
DO $$
DECLARE v_trade public.trades%ROWTYPE;
BEGIN
  SELECT * INTO v_trade FROM public.trades WHERE id = '00000000-0000-0000-0000-0000000a0802';
  IF v_trade.status <> 'expired' THEN
    RAISE EXCEPTION 'T7: pending offer with a dropped asset stayed %', v_trade.status;
  END IF;
  IF v_trade.completion_failure_reason NOT LIKE '%no longer on%' THEN
    RAISE EXCEPTION 'T7: expiry reason missing: %', v_trade.completion_failure_reason;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.league_activity WHERE related_trade_id = v_trade.id AND event_type = 'trade_expired') THEN
    RAISE EXCEPTION 'T7: expiry activity missing';
  END IF;
END $$;

-- T8: a pending claim loses a drop selection that left the roster, but stays pending.
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0001', true);
INSERT INTO public.waiver_claims (id, league_id, league_season_id, member_id, player_id, drop_player_id, priority_at_submission, process_date, bid_amount, claim_order)
SELECT '00000000-0000-0000-0000-0000000a0702', ids.league_id, ids.season_id, ids.member_a, ids.second_target, ids.injured, 1, current_date + 1, 0, 1
  FROM lifecycle_ids AS ids;
SELECT public.drop_player_atomic('00000000-0000-0000-0000-0000000a0502');
DO $$
DECLARE v_claim public.waiver_claims%ROWTYPE;
BEGIN
  SELECT * INTO v_claim FROM public.waiver_claims WHERE id = '00000000-0000-0000-0000-0000000a0702';
  IF v_claim.status <> 'pending' THEN
    RAISE EXCEPTION 'T8: claim status changed to %', v_claim.status;
  END IF;
  IF v_claim.drop_player_id IS NOT NULL THEN
    RAISE EXCEPTION 'T8: pending claim kept a drop player who left the roster';
  END IF;
END $$;

-- T9: a used pick and a pick that changed owner drop their listings and expire offers.
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0002', true);
SELECT public.add_trade_block_item_atomic(ids.member_b, ids.league_id, NULL, ids.pick_a, NULL, ids.user_b) FROM lifecycle_ids AS ids;
SELECT public.add_trade_block_item_atomic(ids.member_b, ids.league_id, NULL, ids.pick_b, NULL, ids.user_b) FROM lifecycle_ids AS ids;
INSERT INTO public.trades (id, league_id, league_season_id, proposer_member_id, recipient_member_id)
SELECT '00000000-0000-0000-0000-0000000a0803', ids.league_id, ids.season_id, ids.member_b, ids.member_a FROM lifecycle_ids AS ids;
INSERT INTO public.trade_items (trade_id, side, pick_id, from_member_id, to_member_id)
SELECT '00000000-0000-0000-0000-0000000a0803', 'proposer', ids.pick_b, ids.member_b, ids.member_a FROM lifecycle_ids AS ids;
UPDATE public.draft_picks SET is_used = true, used_at = now() WHERE id = '00000000-0000-0000-0000-0000000a0601';
UPDATE public.draft_picks SET current_owner_id = '00000000-0000-0000-0000-0000000a0203' WHERE id = '00000000-0000-0000-0000-0000000a0602';
DO $$
DECLARE ids lifecycle_ids%ROWTYPE; v_trade public.trades%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM lifecycle_ids;
  IF pg_temp.listing_count(ids.member_b, NULL, ids.pick_a) <> 0 THEN
    RAISE EXCEPTION 'T9: listing survived pick consumption';
  END IF;
  IF pg_temp.listing_count(ids.member_b, NULL, ids.pick_b) <> 0 THEN
    RAISE EXCEPTION 'T9: listing survived pick ownership change';
  END IF;
  SELECT * INTO v_trade FROM public.trades WHERE id = '00000000-0000-0000-0000-0000000a0803';
  IF v_trade.status <> 'expired' OR v_trade.completion_failure_reason NOT LIKE '%pick is no longer owned%' THEN
    RAISE EXCEPTION 'T9: pick offer did not expire: % / %', v_trade.status, v_trade.completion_failure_reason;
  END IF;
END $$;

-- T10: merging duplicate players carries the listing to the surviving player.
SELECT public.add_trade_block_item_atomic(ids.member_b, ids.league_id, ids.dup_loser, NULL, 'dup', ids.user_b) FROM lifecycle_ids AS ids;
SELECT public.merge_players(ids.dup_winner, ids.dup_loser) FROM lifecycle_ids AS ids;
DO $$
DECLARE ids lifecycle_ids%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM lifecycle_ids;
  IF pg_temp.listing_count(ids.member_b, ids.dup_winner) <> 1 THEN
    RAISE EXCEPTION 'T10: listing did not follow the merged player';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.roster_players WHERE member_id = ids.member_b AND player_id = ids.dup_winner) THEN
    RAISE EXCEPTION 'T10: roster row did not follow the merged player';
  END IF;
END $$;

-- T11: deleting an old-season roster row leaves the current listing alone.
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0003', true);
SELECT public.add_trade_block_item_atomic(ids.member_c, ids.league_id, ids.carry_over, NULL, NULL, ids.user_c) FROM lifecycle_ids AS ids;
DELETE FROM public.roster_players WHERE id = '00000000-0000-0000-0000-0000000a0517';
DO $$
DECLARE ids lifecycle_ids%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM lifecycle_ids;
  IF pg_temp.listing_count(ids.member_c, ids.carry_over) <> 1 THEN
    RAISE EXCEPTION 'T11: an old-season row removal cleared a live listing';
  END IF;
END $$;

-- T12: any direct removal of the current row (reset, commissioner, service role) clears it.
DELETE FROM public.roster_players WHERE id = '00000000-0000-0000-0000-0000000a0507';
DO $$
DECLARE ids lifecycle_ids%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM lifecycle_ids;
  IF pg_temp.listing_count(ids.member_c, ids.carry_over) <> 0 THEN
    RAISE EXCEPTION 'T12: listing survived a direct roster delete';
  END IF;
END $$;

-- T13: stale-client removals and listings of players you do not roster stay safe.
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0001', true);
SELECT public.remove_trade_block_item_atomic(gen_random_uuid(), ids.member_a, ids.user_a) FROM lifecycle_ids AS ids;
DO $$
DECLARE ids lifecycle_ids%ROWTYPE;
BEGIN
  SELECT * INTO ids FROM lifecycle_ids;
  BEGIN
    PERFORM public.add_trade_block_item_atomic(ids.member_a, ids.league_id, ids.flagg, NULL, NULL, ids.user_a);
    RAISE EXCEPTION 'T13: listed a player who is not on the roster';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN NULL;
  END;
END $$;

-- T14: the global invariant holds at the end of every path exercised above.
DO $$
DECLARE v_stale int;
BEGIN
  SELECT count(*) INTO v_stale
    FROM public.trade_block_items AS item
   WHERE item.player_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.roster_players AS roster
         JOIN public.league_seasons AS season ON season.id = roster.league_season_id AND season.is_current
        WHERE roster.league_id = item.league_id
          AND roster.member_id = item.member_id
          AND roster.player_id = item.player_id
          AND roster.is_on_ir = false
          AND roster.is_on_taxi = false
     );
  IF v_stale <> 0 THEN
    RAISE EXCEPTION 'T14: % stale player listing(s) remain', v_stale;
  END IF;
  SELECT count(*) INTO v_stale
    FROM public.trade_block_items AS item
   WHERE item.pick_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.draft_picks AS pick
        WHERE pick.id = item.pick_id AND pick.current_owner_id = item.member_id AND pick.is_used = false
     );
  IF v_stale <> 0 THEN
    RAISE EXCEPTION 'T14: % stale pick listing(s) remain', v_stale;
  END IF;
  RAISE NOTICE 'roster lifecycle invariants hold';
END $$;

ROLLBACK;
