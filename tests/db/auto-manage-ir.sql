BEGIN;
\ir rules-support.sql

CREATE FUNCTION pg_temp.auto_ir_league(p_year int, p_roster_size int, p_ir_slots int, p_teams int DEFAULT 1)
RETURNS TABLE (league_id uuid, season_id uuid, user_id uuid, member_id uuid, other_member_id uuid)
LANGUAGE plpgsql AS $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(p_teams, p_year);
  UPDATE leagues SET roster_size=p_roster_size, ir_slots=p_ir_slots WHERE id=f.league_id;
  INSERT INTO lineup_optimizer_settings(league_id, league_season_id, member_id, enabled)
    VALUES(f.league_id, f.season_id, f.member_ids[1], true)
    ON CONFLICT ON CONSTRAINT lineup_optimizer_settings_pkey DO UPDATE SET enabled = true;
  league_id := f.league_id;
  season_id := f.season_id;
  user_id := f.user_ids[1];
  member_id := f.member_ids[1];
  other_member_id := CASE WHEN p_teams > 1 THEN f.member_ids[2] END;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION pg_temp.auto_ir_player(p_league uuid, p_season uuid, p_member uuid, p_name text, p_injury text, p_return text, p_location text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_player uuid := gen_random_uuid(); v_roster uuid;
BEGIN
  INSERT INTO players(id, first_name, last_name, position, eligible_positions, injury_status, injury_expected_return)
    VALUES(v_player, p_name, 'Test', 'PG', ARRAY['PG'], p_injury, COALESCE(p_return, 'unknown'));
  INSERT INTO roster_players(league_id, league_season_id, member_id, player_id, acquired_via, is_on_ir, is_on_taxi)
    VALUES(p_league, p_season, p_member, v_player, 'draft', p_location = 'ir', false)
    RETURNING id INTO v_roster;
  RETURN v_roster;
END;
$$;

CREATE FUNCTION pg_temp.auto_ir_taxi(p_league uuid, p_season uuid, p_member uuid, p_name text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_player uuid := gen_random_uuid(); v_roster uuid;
BEGIN
  INSERT INTO players(id, first_name, last_name, position, eligible_positions, injury_status, years_exp)
    VALUES(v_player, p_name, 'Taxi', 'PG', ARRAY['PG'], 'Healthy', 0);
  INSERT INTO roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES(p_league, p_season, p_member, v_player, 'draft')
    RETURNING id INTO v_roster;
  PERFORM private.authorize_taxi_acquisition(p_league, p_season, p_member, v_player, 'free_agent', v_player);
  UPDATE roster_players SET is_on_taxi = true WHERE id = v_roster;
  RETURN v_roster;
END;
$$;

CREATE FUNCTION pg_temp.auto_ir_game_lock(p_player uuid, p_team text, p_year int)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE players SET nba_team = p_team WHERE id = p_player;
  INSERT INTO nba_games(id, week_number, season_year, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), 1, p_year, (now() AT TIME ZONE 'America/New_York')::date,
      p_team, p_team || 'O', 'InProgress', now() - interval '1 hour');
END;
$$;

CREATE FUNCTION pg_temp.auto_ir_fail_player()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.player_id = current_setting('auto_ir.fail_player')::uuid THEN
    RAISE EXCEPTION 'forced group failure';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION pg_temp.auto_ir_change_incumbent()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.player_id = current_setting('auto_ir.exchange_contender')::uuid THEN
    UPDATE players SET injury_expected_return = ((now() AT TIME ZONE 'America/New_York')::date + 90)::text
     WHERE id = current_setting('auto_ir.exchange_incumbent')::uuid;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION pg_temp.auto_ir_injure_occupant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.member_id = current_setting('auto_ir.injure_member')::uuid THEN
    UPDATE players SET injury_status = 'Out',
      injury_expected_return = ((now() AT TIME ZONE 'America/New_York')::date + 60)::text
     WHERE id = current_setting('auto_ir.injure_target')::uuid;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION pg_temp.auto_ir_set_return()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.member_id = current_setting('auto_ir.set_return_member')::uuid THEN
    UPDATE players SET injury_expected_return = current_setting('auto_ir.set_return_value')
     WHERE id = current_setting('auto_ir.set_return_target')::uuid;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION pg_temp.expect_denied(p_query text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_denied boolean := false;
BEGIN
  BEGIN
    EXECUTE p_query;
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Call was not denied: %', p_query; END IF;
END;
$$;

DO $$
DECLARE
  f record;
  r jsonb;
  c1 uuid;
  c2 uuid;
  h1 uuid;
  h2 uuid;
  h3 uuid;
  t1 uuid;
  v_player uuid;
  v_add uuid;
  v_taxi_before jsonb;
  v_taxi_after jsonb;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  -- Open slot filled by an eligible injured player.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9531, 2, 2);
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Open Slot', 'Out', '2026-12-01', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND r->'moves'->0->>'kind' = 'designate'
    AND (r->'moves'->0->>'designatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c1),
    'open slot designates the eligible injured player');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = c1), 'open slot player is on IR');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_designate') = 1,
    'open slot writes one ir_designate transaction');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_players WHERE member_id = f.member_id AND is_on_ir) <= 2,
    'open slot respects the IR capacity');

  -- Full bench plus a healthy IR occupant swaps atomically with an eligible injured player.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9532, 1, 1);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Healthy IR', 'Healthy', 'unknown', 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Injured Active', 'Out', '2026-12-01', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1 AND r->'moves'->0->>'kind' = 'swap',
    'full bench swaps the healthy occupant');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = c1)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = h1), 'swap moves both players');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_designate') = 1
    AND (SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_return') = 1,
    'swap writes both roster transactions');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_players WHERE member_id = f.member_id AND is_on_ir) = 1
    AND (SELECT count(*) FROM roster_players WHERE member_id = f.member_id AND NOT is_on_ir AND NOT is_on_taxi) = 1,
    'swap preserves both capacities');

  -- No legal swap available: no writes and a healthy_ir_bench_full notice.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9533, 1, 1);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Stuck Healthy', 'Healthy', 'unknown', 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Healthy Active', 'Healthy', 'unknown', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'no legal swap makes no moves');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'notices') n
     WHERE n->>'reason' = 'healthy_ir_bench_full'
       AND (n->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1)
       AND n->>'action' = 'Drop a player, then activate ' || (SELECT display_name FROM players WHERE id = (SELECT player_id FROM roster_players WHERE id = h1))),
    'healthy_ir_bench_full names the occupant');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id) = 0,
    'no legal swap writes nothing');

  -- Later reliable return wins over an earlier reliable return.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9534, 2, 1);
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Later Return', 'Out', '2026-12-01', 'active');
  c2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Earlier Return', 'Out', '2026-11-25', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND (r->'moves'->0->>'designatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c1),
    'later reliable return is chosen');

  -- Tied returns at the boundary: no move and an ir_choice_uncertain notice.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9535, 2, 1);
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Tie One', 'Out', '2026-12-01', 'active');
  c2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Tie Two', 'Out', '2026-12-01', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'tied returns make no move');
  PERFORM pg_temp.check_rules(EXISTS (SELECT 1 FROM jsonb_array_elements(r->'notices') n WHERE n->>'reason' = 'ir_choice_uncertain'),
    'tied returns produce ir_choice_uncertain');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id) = 0,
    'tied returns write nothing');

  -- Unknown return at the boundary: no move and an ir_choice_uncertain notice.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9536, 2, 1);
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Known Return', 'Out', '2026-12-01', 'active');
  c2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Unknown Return', 'Out', 'unknown', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'unknown return makes no move');
  PERFORM pg_temp.check_rules(EXISTS (SELECT 1 FROM jsonb_array_elements(r->'notices') n WHERE n->>'reason' = 'ir_choice_uncertain'),
    'unknown return produces ir_choice_uncertain');

  -- Malformed return at the boundary: no move and an ir_choice_uncertain notice.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9537, 2, 1);
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Valid Return', 'Out', '2026-12-01', 'active');
  c2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Malformed Return', 'Out', '2026-13-45', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'malformed return makes no move');
  PERFORM pg_temp.check_rules(EXISTS (SELECT 1 FROM jsonb_array_elements(r->'notices') n WHERE n->>'reason' = 'ir_choice_uncertain'),
    'malformed return produces ir_choice_uncertain');

  -- Past return at the boundary: no move and an ir_choice_uncertain notice.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9538, 2, 1);
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Future Return', 'Out', '2026-12-01', 'active');
  c2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Past Return', 'Out', '2026-01-01', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'past return makes no move');
  PERFORM pg_temp.check_rules(EXISTS (SELECT 1 FROM jsonb_array_elements(r->'notices') n WHERE n->>'reason' = 'ir_choice_uncertain'),
    'past return produces ir_choice_uncertain');

  -- Game-locked candidate is skipped and nothing is written for it.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9539, 2, 2);
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Locked Candidate', 'Out', '2026-12-01', 'active');
  c2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Open Candidate', 'Out', '2026-12-01', 'active');
  PERFORM pg_temp.auto_ir_game_lock((SELECT player_id FROM roster_players WHERE id = c1), 'LCK1', 9539);
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND (r->'moves'->0->>'designatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c2),
    'game-locked candidate is not moved');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE s->>'reason' = 'game_locked'
       AND (s->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c1)),
    'game-locked candidate is reported as skipped');
  PERFORM pg_temp.check_rules(NOT (SELECT is_on_ir FROM roster_players WHERE id = c1)
    AND (SELECT is_on_ir FROM roster_players WHERE id = c2), 'game-locked candidate keeps its place');

  -- Game-locked occupant is skipped and nothing is written for it.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9540, 1, 1);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Locked Occupant', 'Healthy', 'unknown', 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Injured Active', 'Out', '2026-12-01', 'active');
  PERFORM pg_temp.auto_ir_game_lock((SELECT player_id FROM roster_players WHERE id = h1), 'LCK2', 9540);
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'game-locked occupant blocks the swap');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE s->>'reason' = 'game_locked'
       AND (s->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1)),
    'game-locked occupant is reported as skipped');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = h1)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = c1), 'game-locked occupant keeps its place');

  -- Reserved candidate (pending claim drop) is skipped.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9541, 2, 2);
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Reserved Candidate', 'Out', '2026-12-01', 'active');
  INSERT INTO players(id, first_name, last_name, position, eligible_positions)
    VALUES(gen_random_uuid(), 'Claim', 'Target', 'PG', ARRAY['PG']) RETURNING id INTO v_add;
  INSERT INTO waiver_claims(league_id, league_season_id, member_id, player_id, drop_player_id, priority_at_submission, status, process_date)
    VALUES(f.league_id, f.season_id, f.member_id, v_add, (SELECT player_id FROM roster_players WHERE id = c1), 1, 'pending', current_date);
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'reserved candidate is not moved');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE s->>'reason' = 'reserved'
       AND (s->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c1)),
    'reserved candidate is reported as skipped');
  PERFORM pg_temp.check_rules(NOT (SELECT is_on_ir FROM roster_players WHERE id = c1), 'reserved candidate keeps its place');

  -- Reserved occupant (pending trade) is skipped.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9542, 1, 1, 2);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Reserved Occupant', 'Healthy', 'unknown', 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Injured Active', 'Out', '2026-12-01', 'active');
  INSERT INTO trades(id, league_id, league_season_id, proposer_member_id, recipient_member_id, status)
    VALUES(gen_random_uuid(), f.league_id, f.season_id, f.member_id, f.other_member_id, 'pending')
    RETURNING id INTO v_player;
  INSERT INTO trade_items(trade_id, side, player_id, from_member_id, to_member_id)
    VALUES(v_player, 'proposer', (SELECT player_id FROM roster_players WHERE id = h1), f.member_id, f.other_member_id);
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'reserved occupant blocks the swap');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE s->>'reason' = 'reserved'
       AND (s->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1)),
    'reserved occupant is reported as skipped');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = h1), 'reserved occupant keeps its place');

  -- Ineligible taxi player produces a notice and taxi rows stay byte-identical.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9543, 2, 2);
  UPDATE leagues SET taxi_slots = 2 WHERE id = f.league_id;
  t1 := pg_temp.auto_ir_taxi(f.league_id, f.season_id, f.member_id, 'Veteran Taxi');
  UPDATE players SET years_exp = 3, career_regular_season_games = 100
   WHERE id = (SELECT player_id FROM roster_players WHERE id = t1);
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Taxi Injured', 'Out', '2026-12-01', 'active');
  SELECT COALESCE(jsonb_agg(to_jsonb(rp) ORDER BY rp.id), '[]'::jsonb) INTO v_taxi_before
    FROM roster_players rp WHERE rp.member_id = f.member_id AND rp.is_on_taxi;
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  SELECT COALESCE(jsonb_agg(to_jsonb(rp) ORDER BY rp.id), '[]'::jsonb) INTO v_taxi_after
    FROM roster_players rp WHERE rp.member_id = f.member_id AND rp.is_on_taxi;
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'notices') n
     WHERE n->>'reason' = 'taxi_ineligible'
       AND (n->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = t1)),
    'ineligible taxi player produces taxi_ineligible');
  PERFORM pg_temp.check_rules(v_taxi_after = v_taxi_before, 'taxi rows stay byte-identical');
  PERFORM pg_temp.check_rules((SELECT is_on_taxi FROM roster_players WHERE id = t1), 'taxi player is untouched');

  -- Progressive repair: two healthy occupants, one injured candidate.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9544, 1, 2);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Healthy One', 'Healthy', 'unknown', 'ir');
  h2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Healthy Two', 'Healthy', 'unknown', 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Repair Candidate', 'Out', '2026-12-01', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1 AND r->'moves'->0->>'kind' = 'swap',
    'progressive repair makes one swap');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_players WHERE member_id = f.member_id AND is_on_ir) = 2,
    'progressive repair keeps the IR capacity');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM private.roster_problems(f.league_id, f.season_id, f.member_id) WHERE kind = 'ir') = 1,
    'progressive repair keeps the remaining existing violation');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'notices') n
     WHERE n->>'reason' = 'healthy_ir_bench_full'),
    'progressive repair reports the remaining healthy occupant');

  -- A forced failure inside one group leaves that group unchanged and continues.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9545, 2, 2);
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Forced Fail', 'Out', '2026-12-01', 'active');
  c2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Forced Pass', 'Out', '2026-12-01', 'active');
  PERFORM set_config('auto_ir.fail_player', (SELECT player_id FROM roster_players WHERE id = c1)::text, true);
  CREATE TRIGGER auto_ir_fail BEFORE UPDATE ON roster_players
    FOR EACH ROW EXECUTE FUNCTION pg_temp.auto_ir_fail_player();
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  DROP TRIGGER auto_ir_fail ON roster_players;
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND (r->'moves'->0->>'designatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c2),
    'a failed group does not stop the other group');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE s->>'reason' LIKE '%forced group failure%'
       AND (s->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c1)),
    'the failed group is reported');
  PERFORM pg_temp.check_rules(NOT (SELECT is_on_ir FROM roster_players WHERE id = c1)
    AND (SELECT is_on_ir FROM roster_players WHERE id = c2), 'the failed group leaves its roster unchanged');

  -- Reviewer fixture: two eligible incumbents returning in 7 and 30 days, a contender returning in 60.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9546, 1, 2);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Incumbent Seven', 'Out', (v_today + 7)::text, 'ir');
  h2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Incumbent Thirty', 'Out', (v_today + 30)::text, 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Contender Sixty', 'Out', (v_today + 60)::text, 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND r->'moves'->0->>'kind' = 'swap'
    AND (r->'moves'->0->>'designatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c1)
    AND (r->'moves'->0->>'activatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1),
    'incumbent fixture exchanges the earliest-returning incumbent');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = c1)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = h1)
    AND (SELECT is_on_ir FROM roster_players WHERE id = h2),
    'incumbent fixture keeps the later incumbent');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_designate') = 1
    AND (SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_return') = 1,
    'incumbent fixture writes both roster transactions');

  -- Tied contender and incumbent preserve both incumbents.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9547, 1, 2);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Tie Incumbent Seven', 'Out', (v_today + 7)::text, 'ir');
  h2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Tie Incumbent Thirty', 'Out', (v_today + 30)::text, 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Tie Contender Seven', 'Out', (v_today + 7)::text, 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'tied incumbent makes no move');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = h1)
    AND (SELECT is_on_ir FROM roster_players WHERE id = h2)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = c1),
    'tied incumbent preserves both incumbents');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id) = 0,
    'tied incumbent writes nothing');

  -- Unknown contender return preserves both incumbents.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9548, 1, 2);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Unknown Incumbent Seven', 'Out', (v_today + 7)::text, 'ir');
  h2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Unknown Incumbent Thirty', 'Out', (v_today + 30)::text, 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Unknown Contender', 'Out', 'unknown', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'unknown incumbent contender makes no move');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = h1)
    AND (SELECT is_on_ir FROM roster_players WHERE id = h2)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = c1),
    'unknown incumbent contender preserves both incumbents');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id) = 0,
    'unknown incumbent contender writes nothing');

  -- An incumbent that changes between plan and write is not exchanged.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9549, 2, 3);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Changing Incumbent Seven', 'Out', (v_today + 7)::text, 'ir');
  h2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Changing Incumbent Thirty', 'Out', (v_today + 30)::text, 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Changing Contender Sixty', 'Out', (v_today + 60)::text, 'active');
  c2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Changing Contender Fifty', 'Out', (v_today + 50)::text, 'active');
  PERFORM set_config('auto_ir.exchange_contender', (SELECT player_id FROM roster_players WHERE id = c1)::text, true);
  PERFORM set_config('auto_ir.exchange_incumbent', (SELECT player_id FROM roster_players WHERE id = h1)::text, true);
  CREATE TRIGGER auto_ir_change_incumbent BEFORE UPDATE ON roster_players
    FOR EACH ROW EXECUTE FUNCTION pg_temp.auto_ir_change_incumbent();
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  DROP TRIGGER auto_ir_change_incumbent ON roster_players;
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND r->'moves'->0->>'kind' = 'designate'
    AND (r->'moves'->0->>'designatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c1),
    'changed incumbent still writes the designate');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE s->>'reason' LIKE '%Incumbent exchange no longer valid%'
       AND (s->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c2)),
    'changed incumbent is reported as skipped');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = h1)
    AND (SELECT is_on_ir FROM roster_players WHERE id = h2)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = c2),
    'changed incumbent leaves the exchange players unchanged');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_designate') = 1
    AND (SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_return') = 0,
    'changed incumbent writes only the designate transaction');

  -- A healthy occupant with an unplaced injured active player gets swap advice.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9550, 2, 1);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Healthy Swap', 'Healthy', 'unknown', 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Tied Contender One', 'Out', (v_today + 60)::text, 'active');
  c2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Tied Contender Two', 'Out', (v_today + 60)::text, 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'swap advice makes no move');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'notices') n
     WHERE n->>'reason' = 'healthy_ir_swap_available'
       AND (n->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1)
       AND n->>'action' = 'Swap ' || (SELECT display_name FROM players WHERE id = (SELECT player_id FROM roster_players WHERE id = h1)) || ' with an injured player'),
    'healthy occupant with an unplaced injured player gets swap advice');

  -- A healthy occupant with no injured active player gets cut advice.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9551, 1, 1);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Healthy Bench', 'Healthy', 'unknown', 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Healthy Active', 'Healthy', 'unknown', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'cut advice makes no move');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'notices') n
     WHERE n->>'reason' = 'healthy_ir_bench_full'
       AND (n->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1)
       AND n->>'action' = 'Drop a player, then activate ' || (SELECT display_name FROM players WHERE id = (SELECT player_id FROM roster_players WHERE id = h1))),
    'healthy occupant with no injured active player gets cut advice');

  -- A disabled setting returns empty and writes nothing.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9552, 2, 2);
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Disabled Candidate', 'Out', (v_today + 60)::text, 'active');
  UPDATE lineup_optimizer_settings SET enabled = false
   WHERE league_id = f.league_id AND league_season_id = f.season_id AND member_id = f.member_id;
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0
    AND jsonb_array_length(r->'skipped') = 0
    AND jsonb_array_length(r->'notices') = 0,
    'disabled setting returns empty');
  PERFORM pg_temp.check_rules(NOT (SELECT is_on_ir FROM roster_players WHERE id = c1), 'disabled setting writes nothing');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id) = 0,
    'disabled setting writes no transactions');

  -- The notices reader returns the caller's own notices and respects the setting.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9553, 1, 1);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Notice Bench', 'Healthy', 'unknown', 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Notice Healthy', 'Healthy', 'unknown', 'active');
  PERFORM set_config('request.jwt.claim.sub', f.user_id::text, true);
  r := public.get_auto_ir_notices(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules((r->>'enabled')::boolean
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(r->'notices') n
       WHERE n->>'reason' = 'healthy_ir_bench_full'
         AND (n->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1)),
    'notices reader returns the healthy bench notice');
  PERFORM public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  r := public.get_auto_ir_notices(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'notices') n
     WHERE n->>'reason' = 'healthy_ir_bench_full'
       AND (n->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1)),
    'notices reader keeps the healthy bench notice after a service run');

  SELECT * INTO f FROM pg_temp.auto_ir_league(9554, 2, 2);
  UPDATE leagues SET taxi_slots = 2 WHERE id = f.league_id;
  t1 := pg_temp.auto_ir_taxi(f.league_id, f.season_id, f.member_id, 'Notice Taxi');
  UPDATE players SET years_exp = 3, career_regular_season_games = 100
   WHERE id = (SELECT player_id FROM roster_players WHERE id = t1);
  PERFORM set_config('request.jwt.claim.sub', f.user_id::text, true);
  r := public.get_auto_ir_notices(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'notices') n
     WHERE n->>'reason' = 'taxi_ineligible'
       AND (n->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = t1)),
    'notices reader returns the taxi notice');
  PERFORM public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  r := public.get_auto_ir_notices(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'notices') n
     WHERE n->>'reason' = 'taxi_ineligible'
       AND (n->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = t1)),
    'notices reader keeps the taxi notice after a service run');
  UPDATE lineup_optimizer_settings SET enabled = false
   WHERE league_id = f.league_id AND league_season_id = f.season_id AND member_id = f.member_id;
  r := public.get_auto_ir_notices(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(NOT (r->>'enabled')::boolean AND jsonb_array_length(r->'notices') = 0,
    'notices reader returns nothing when disabled');
  PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  r := public.get_auto_ir_notices(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(NOT (r->>'enabled')::boolean AND jsonb_array_length(r->'notices') = 0,
    'notices reader returns nothing for a non-member');

  -- A healthy swap is skipped when the occupant becomes IR-eligible before the write.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9555, 2, 2);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Swap Injured Occupant', 'Healthy', 'unknown', 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Swap Designate Sixty', 'Out', (v_today + 60)::text, 'active');
  c2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Swap Exchange Fifty', 'Out', (v_today + 50)::text, 'active');
  PERFORM set_config('auto_ir.injure_member', f.member_id::text, true);
  PERFORM set_config('auto_ir.injure_target', (SELECT player_id FROM roster_players WHERE id = h1)::text, true);
  CREATE TRIGGER auto_ir_injure_occupant BEFORE UPDATE ON roster_players
    FOR EACH ROW EXECUTE FUNCTION pg_temp.auto_ir_injure_occupant();
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  DROP TRIGGER auto_ir_injure_occupant ON roster_players;
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND r->'moves'->0->>'kind' = 'designate'
    AND (r->'moves'->0->>'designatePlayerId')::uuid IN (
      (SELECT player_id FROM roster_players WHERE id = c1),
      (SELECT player_id FROM roster_players WHERE id = c2)),
    'injured occupant still writes the designate');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE s->>'reason' LIKE '%Healthy occupant is no longer activatable%'
       AND (s->>'playerId')::uuid IN (
         (SELECT player_id FROM roster_players WHERE id = c1),
         (SELECT player_id FROM roster_players WHERE id = c2))),
    'injured occupant skips the healthy swap');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = h1)
    AND (SELECT count(*) FROM roster_players WHERE id IN (c1, c2) AND is_on_ir) = 1
    AND (SELECT count(*) FROM roster_players WHERE id IN (c1, c2) AND NOT is_on_ir) = 1,
    'injured occupant stays on IR and one contender stays active');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_designate') = 1
    AND (SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_return') = 0,
    'injured occupant writes only the designate transaction for activation');

  -- A standalone activation is skipped when the occupant becomes IR-eligible before the write.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9556, 2, 2);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Activate Injured Occupant', 'Healthy', 'unknown', 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Activate Designate Sixty', 'Out', (v_today + 60)::text, 'active');
  PERFORM set_config('auto_ir.injure_member', f.member_id::text, true);
  PERFORM set_config('auto_ir.injure_target', (SELECT player_id FROM roster_players WHERE id = h1)::text, true);
  CREATE TRIGGER auto_ir_injure_occupant BEFORE UPDATE ON roster_players
    FOR EACH ROW EXECUTE FUNCTION pg_temp.auto_ir_injure_occupant();
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  DROP TRIGGER auto_ir_injure_occupant ON roster_players;
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND r->'moves'->0->>'kind' = 'designate'
    AND (r->'moves'->0->>'designatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c1),
    'injured occupant still writes the designate before activation');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE s->>'reason' LIKE '%Healthy occupant is no longer activatable%'
       AND (s->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1)),
    'injured occupant skips the standalone activation');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = h1),
    'injured occupant stays on IR after the skipped activation');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_designate') = 1
    AND (SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_return') = 0,
    'injured occupant writes only the designate transaction');

  -- A game-locked injured partner produces locked swap advice.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9557, 1, 1);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Locked Swap Occupant', 'Healthy', 'unknown', 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Locked Swap Partner', 'Out', (v_today + 60)::text, 'active');
  PERFORM pg_temp.auto_ir_game_lock((SELECT player_id FROM roster_players WHERE id = c1), 'LCK3', 9557);
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'locked swap partner makes no move');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'notices') n
     WHERE n->>'reason' = 'healthy_ir_swap_locked'
       AND (n->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1)
       AND n->>'action' = 'Swap ' || (SELECT display_name FROM players WHERE id = (SELECT player_id FROM roster_players WHERE id = h1)) || ' with an injured player after their game or pending move clears'),
    'locked swap partner gets locked swap advice');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id) = 0,
    'locked swap partner writes nothing');

  -- A reserved injured partner produces locked swap advice.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9558, 1, 1, 2);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Reserved Swap Occupant', 'Healthy', 'unknown', 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Reserved Swap Partner', 'Out', (v_today + 60)::text, 'active');
  INSERT INTO trades(id, league_id, league_season_id, proposer_member_id, recipient_member_id, status)
    VALUES(gen_random_uuid(), f.league_id, f.season_id, f.member_id, f.other_member_id, 'pending')
    RETURNING id INTO v_player;
  INSERT INTO trade_items(trade_id, side, player_id, from_member_id, to_member_id)
    VALUES(v_player, 'proposer', (SELECT player_id FROM roster_players WHERE id = c1), f.member_id, f.other_member_id);
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'reserved swap partner makes no move');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'notices') n
     WHERE n->>'reason' = 'healthy_ir_swap_locked'
       AND (n->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1)),
    'reserved swap partner gets locked swap advice');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id) = 0,
    'reserved swap partner writes nothing');

  -- Tied incumbents at the eviction boundary are not evicted by UUID.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9560, 1, 2);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Boundary Tie One', 'Out', (v_today + 7)::text, 'ir');
  h2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Boundary Tie Two', 'Out', (v_today + 7)::text, 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Boundary Tie Contender', 'Out', (v_today + 60)::text, 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'boundary tie makes no move');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = h1)
    AND (SELECT is_on_ir FROM roster_players WHERE id = h2)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = c1),
    'boundary tie keeps both incumbents and the contender active');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id) = 0,
    'boundary tie writes nothing');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'notices') n
     WHERE n->>'reason' = 'ir_choice_uncertain'),
    'boundary tie produces an uncertainty notice');
  PERFORM set_config('request.jwt.claim.sub', f.user_id::text, true);
  r := public.get_auto_ir_notices(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'notices') n
     WHERE n->>'reason' = 'ir_choice_uncertain'),
    'notices reader returns the boundary tie notice');

  -- A tie away from the eviction boundary still exchanges the earliest incumbent.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9561, 1, 3);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Nonboundary Tie One', 'Out', (v_today + 30)::text, 'ir');
  h2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Nonboundary Tie Two', 'Out', (v_today + 30)::text, 'ir');
  h3 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Nonboundary Seven', 'Out', (v_today + 7)::text, 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Nonboundary Contender', 'Out', (v_today + 60)::text, 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND r->'moves'->0->>'kind' = 'swap'
    AND (r->'moves'->0->>'activatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h3),
    'non-boundary tie exchanges the earliest incumbent');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = h1)
    AND (SELECT is_on_ir FROM roster_players WHERE id = h2)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = h3)
    AND (SELECT is_on_ir FROM roster_players WHERE id = c1),
    'non-boundary tie keeps the tied incumbents');

  -- A changed exchanged-incumbent return skips the pair.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9562, 2, 3);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Stale Incumbent Seven', 'Out', (v_today + 7)::text, 'ir');
  h2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Stale Incumbent Thirty', 'Out', (v_today + 30)::text, 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Stale Designate Sixty', 'Out', (v_today + 60)::text, 'active');
  c2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Stale Exchange Fifty', 'Out', (v_today + 50)::text, 'active');
  PERFORM set_config('auto_ir.set_return_member', f.member_id::text, true);
  PERFORM set_config('auto_ir.set_return_target', (SELECT player_id FROM roster_players WHERE id = h1)::text, true);
  PERFORM set_config('auto_ir.set_return_value', (v_today + 45)::text, true);
  CREATE TRIGGER auto_ir_set_return BEFORE UPDATE ON roster_players
    FOR EACH ROW EXECUTE FUNCTION pg_temp.auto_ir_set_return();
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  DROP TRIGGER auto_ir_set_return ON roster_players;
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND r->'moves'->0->>'kind' = 'designate'
    AND (r->'moves'->0->>'designatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c1),
    'changed incumbent return still writes the designate');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE s->>'reason' LIKE '%Incumbent exchange no longer valid%'
       AND (s->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c2)),
    'changed incumbent return skips the exchange');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = h1)
    AND (SELECT is_on_ir FROM roster_players WHERE id = h2)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = c2),
    'changed incumbent return leaves the pair unchanged');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_designate') = 1
    AND (SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_return') = 0,
    'changed incumbent return writes only the designate transaction');

  -- A changed contender return skips the pair.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9563, 2, 3);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Stale Contender Incumbent Seven', 'Out', (v_today + 7)::text, 'ir');
  h2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Stale Contender Incumbent Thirty', 'Out', (v_today + 30)::text, 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Stale Contender Designate Sixty', 'Out', (v_today + 60)::text, 'active');
  c2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Stale Contender Exchange Fifty', 'Out', (v_today + 50)::text, 'active');
  PERFORM set_config('auto_ir.set_return_member', f.member_id::text, true);
  PERFORM set_config('auto_ir.set_return_target', (SELECT player_id FROM roster_players WHERE id = c2)::text, true);
  PERFORM set_config('auto_ir.set_return_value', (v_today + 40)::text, true);
  CREATE TRIGGER auto_ir_set_return BEFORE UPDATE ON roster_players
    FOR EACH ROW EXECUTE FUNCTION pg_temp.auto_ir_set_return();
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  DROP TRIGGER auto_ir_set_return ON roster_players;
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND r->'moves'->0->>'kind' = 'designate'
    AND (r->'moves'->0->>'designatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c1),
    'changed contender return still writes the designate');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE s->>'reason' LIKE '%Incumbent exchange no longer valid%'
       AND (s->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c2)),
    'changed contender return skips the exchange');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = h1)
    AND (SELECT is_on_ir FROM roster_players WHERE id = h2)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = c2),
    'changed contender return leaves the pair unchanged');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_designate') = 1
    AND (SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_return') = 0,
    'changed contender return writes only the designate transaction');

  -- A changed other-incumbent return that now outranks skips the pair.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9564, 2, 3);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Outrank Incumbent Seven', 'Out', (v_today + 7)::text, 'ir');
  h2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Outrank Incumbent Thirty', 'Out', (v_today + 30)::text, 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Outrank Designate Sixty', 'Out', (v_today + 60)::text, 'active');
  c2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Outrank Exchange Fifty', 'Out', (v_today + 50)::text, 'active');
  PERFORM set_config('auto_ir.set_return_member', f.member_id::text, true);
  PERFORM set_config('auto_ir.set_return_target', (SELECT player_id FROM roster_players WHERE id = h2)::text, true);
  PERFORM set_config('auto_ir.set_return_value', (v_today + 3)::text, true);
  CREATE TRIGGER auto_ir_set_return BEFORE UPDATE ON roster_players
    FOR EACH ROW EXECUTE FUNCTION pg_temp.auto_ir_set_return();
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  DROP TRIGGER auto_ir_set_return ON roster_players;
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND r->'moves'->0->>'kind' = 'designate'
    AND (r->'moves'->0->>'designatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c1),
    'outranking incumbent still writes the designate');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE s->>'reason' LIKE '%Incumbent exchange no longer valid%'
       AND (s->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c2)),
    'outranking incumbent skips the exchange');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = h1)
    AND (SELECT is_on_ir FROM roster_players WHERE id = h2)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = c2),
    'outranking incumbent leaves the pair unchanged');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_designate') = 1
    AND (SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_return') = 0,
    'outranking incumbent writes only the designate transaction');

  -- Zero IR slots with active room activates the healthy occupant alone.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9565, 2, 0);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Zero Slot Occupant', 'Healthy', 'unknown', 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Zero Slot Contender', 'Out', (v_today + 60)::text, 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND r->'moves'->0->>'kind' = 'activate'
    AND (r->'moves'->0->>'activatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1),
    'zero slots activates the healthy occupant alone');
  PERFORM pg_temp.check_rules(NOT (SELECT is_on_ir FROM roster_players WHERE id = h1)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = c1),
    'zero slots leaves the contender active');
  PERFORM pg_temp.check_rules(NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE s->>'reason' LIKE '%IR slots%'),
    'zero slots produces no raw capacity error');

  -- Zero IR slots with a full active roster produces a notice and no writes.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9566, 1, 0);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Zero Slot Full Occupant', 'Healthy', 'unknown', 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Zero Slot Full Contender', 'Out', (v_today + 60)::text, 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'zero slots with a full bench makes no move');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'notices') n
     WHERE n->>'reason' = 'healthy_ir_bench_full'
       AND (n->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1)),
    'zero slots with a full bench produces the cut notice');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id) = 0,
    'zero slots with a full bench writes nothing');
  PERFORM pg_temp.check_rules(NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE s->>'reason' LIKE '%IR slots%'),
    'zero slots with a full bench produces no raw capacity error');

  -- An unchanged multi-exchange plan writes every pair.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9570, 2, 2);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Multi Exchange Seven', 'Out', (v_today + 7)::text, 'ir');
  h2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Multi Exchange Ten', 'Out', (v_today + 10)::text, 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Multi Exchange Sixty', 'Out', (v_today + 60)::text, 'active');
  c2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Multi Exchange Fifty', 'Out', (v_today + 50)::text, 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 2, 'multi exchange writes both pairs');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = c1)
    AND (SELECT is_on_ir FROM roster_players WHERE id = c2)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = h1)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = h2),
    'multi exchange moves both contenders to IR and both incumbents active');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_designate') = 2
    AND (SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_return') = 2,
    'multi exchange writes both designate and return transactions');

  -- A compared incumbent that ties the exchanged incumbent skips the pair.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9571, 2, 3);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Tie Incumbent Seven', 'Out', (v_today + 7)::text, 'ir');
  h2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Tie Incumbent Thirty', 'Out', (v_today + 30)::text, 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Tie Designate Sixty', 'Out', (v_today + 60)::text, 'active');
  c2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Tie Exchange Fifty', 'Out', (v_today + 50)::text, 'active');
  PERFORM set_config('auto_ir.set_return_member', f.member_id::text, true);
  PERFORM set_config('auto_ir.set_return_target', (SELECT player_id FROM roster_players WHERE id = h2)::text, true);
  PERFORM set_config('auto_ir.set_return_value', (v_today + 7)::text, true);
  CREATE TRIGGER auto_ir_set_return BEFORE UPDATE ON roster_players
    FOR EACH ROW EXECUTE FUNCTION pg_temp.auto_ir_set_return();
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  DROP TRIGGER auto_ir_set_return ON roster_players;
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND r->'moves'->0->>'kind' = 'designate'
    AND (r->'moves'->0->>'designatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c1),
    'tied compared incumbent still writes the designate');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE s->>'reason' LIKE '%Incumbent exchange no longer valid%'
       AND (s->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c2)),
    'tied compared incumbent skips the exchange');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = h1)
    AND (SELECT is_on_ir FROM roster_players WHERE id = h2)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = c2),
    'tied compared incumbent leaves the pair unchanged');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_designate') = 1
    AND (SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_return') = 0,
    'tied compared incumbent writes only the designate transaction');

  -- Tied incumbents that are both exchanged still write both pairs.
  SELECT * INTO f FROM pg_temp.auto_ir_league(9572, 2, 3);
  h1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Both Tie Seven One', 'Out', (v_today + 7)::text, 'ir');
  h2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Both Tie Seven Two', 'Out', (v_today + 7)::text, 'ir');
  h3 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Both Tie Thirty', 'Out', (v_today + 30)::text, 'ir');
  c1 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Both Tie Sixty', 'Out', (v_today + 60)::text, 'active');
  c2 := pg_temp.auto_ir_player(f.league_id, f.season_id, f.member_id, 'Both Tie Fifty', 'Out', (v_today + 50)::text, 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 2, 'both tied incumbents write both pairs');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = c1)
    AND (SELECT is_on_ir FROM roster_players WHERE id = c2)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = h1)
    AND NOT (SELECT is_on_ir FROM roster_players WHERE id = h2)
    AND (SELECT is_on_ir FROM roster_players WHERE id = h3),
    'both tied incumbents move both contenders to IR and keep the 30-day incumbent');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_designate') = 2
    AND (SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_return') = 2,
    'both tied incumbents write both designate and return transactions');
END;
$$;

CREATE TEMP TABLE auto_ir_role_fixture AS SELECT * FROM pg_temp.rules_fixture(1, 9599);
GRANT SELECT ON auto_ir_role_fixture TO authenticated, anon;
SET LOCAL ROLE authenticated;
SELECT pg_temp.expect_denied(format('SELECT public.auto_manage_ir_service(%L, %L, %L)',
  (SELECT league_id FROM auto_ir_role_fixture), (SELECT season_id FROM auto_ir_role_fixture),
  (SELECT member_ids[1] FROM auto_ir_role_fixture)));
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.expect_denied(format('SELECT public.auto_manage_ir_service(%L, %L, %L)',
  (SELECT league_id FROM auto_ir_role_fixture), (SELECT season_id FROM auto_ir_role_fixture),
  (SELECT member_ids[1] FROM auto_ir_role_fixture)));
SELECT pg_temp.expect_denied(format('SELECT public.get_auto_ir_notices(%L, %L)',
  (SELECT league_id FROM auto_ir_role_fixture), (SELECT season_id FROM auto_ir_role_fixture)));
RESET ROLE;

SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
