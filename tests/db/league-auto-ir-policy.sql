BEGIN;
\ir rules-support.sql

CREATE FUNCTION pg_temp.policy_league(p_year int, p_roster_size int, p_ir_slots int, p_teams int DEFAULT 1)
RETURNS TABLE (league_id uuid, season_id uuid, user_id uuid, member_id uuid, other_member_id uuid)
LANGUAGE plpgsql AS $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(p_teams, p_year);
  UPDATE leagues SET roster_size=p_roster_size, ir_slots=p_ir_slots WHERE id=f.league_id;
  INSERT INTO lineup_optimizer_settings(league_id, league_season_id, member_id, enabled)
    VALUES(f.league_id, f.season_id, f.member_ids[1], false)
    ON CONFLICT ON CONSTRAINT lineup_optimizer_settings_pkey DO UPDATE SET enabled = false;
  league_id := f.league_id;
  season_id := f.season_id;
  user_id := f.user_ids[1];
  member_id := f.member_ids[1];
  other_member_id := CASE WHEN p_teams > 1 THEN f.member_ids[2] END;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION pg_temp.policy_player(p_league uuid, p_season uuid, p_member uuid, p_name text, p_injury text, p_return text, p_location text)
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

CREATE FUNCTION pg_temp.policy_game_lock(p_player uuid, p_team text, p_year int)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE players SET nba_team = p_team WHERE id = p_player;
  INSERT INTO nba_games(id, week_number, season_year, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), 1, p_year, (now() AT TIME ZONE 'America/New_York')::date,
      p_team, p_team || 'O', 'InProgress', now() - interval '1 hour');
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
BEGIN
  PERFORM pg_temp.check_rules((SELECT count(*) FROM private.league_roster_policies) = 0,
    'migration inserts no policy rows');

  SELECT * INTO f FROM pg_temp.policy_league(9601, 2, 2);
  PERFORM pg_temp.check_rules(NOT private.league_auto_ir_all_members(f.league_id),
    'helper is false without a policy row');
  INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members, ir_activated_at) VALUES(f.league_id, true, now());
  PERFORM pg_temp.check_rules(private.league_auto_ir_all_members(f.league_id),
    'helper is true when the policy enables it');
  UPDATE private.league_roster_policies SET auto_ir_all_members = false WHERE league_id = f.league_id;
  PERFORM pg_temp.check_rules(NOT private.league_auto_ir_all_members(f.league_id),
    'helper is false when the policy disables it');
  DELETE FROM private.league_roster_policies WHERE league_id = f.league_id;
  PERFORM pg_temp.check_rules(NOT private.league_auto_ir_all_members(f.league_id),
    'helper is false after the policy row is removed');

  PERFORM pg_temp.reject_rules(
    format('INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor) VALUES(%L, 0)', f.league_id),
    '%weekly_roster_floor%', 'weekly roster floor rejects zero');
  PERFORM pg_temp.reject_rules(
    format('INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor) VALUES(%L, 31)', f.league_id),
    '%weekly_roster_floor%', 'weekly roster floor rejects thirty-one');
  INSERT INTO private.league_roster_policies(league_id) VALUES(f.league_id);
  PERFORM pg_temp.check_rules(
    (SELECT weekly_roster_floor IS NULL AND NOT auto_ir_all_members
       FROM private.league_roster_policies WHERE league_id = f.league_id),
    'policy defaults to no floor and no league-wide auto IR');
  DELETE FROM private.league_roster_policies WHERE league_id = f.league_id;

  SELECT * INTO f FROM pg_temp.policy_league(9602, 2, 2);
  INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members, ir_activated_at) VALUES(f.league_id, true, now());
  c1 := pg_temp.policy_player(f.league_id, f.season_id, f.member_id, 'Policy Open Slot', 'Out', '2026-12-01', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND r->'moves'->0->>'kind' = 'designate'
    AND (r->'moves'->0->>'designatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c1),
    'policy league designates with Auto Lineup off');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = c1),
    'policy league player is on IR');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id AND transaction_type = 'ir_designate') = 1,
    'policy league writes one ir_designate transaction');

  SELECT * INTO f FROM pg_temp.policy_league(9603, 2, 1);
  INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members, ir_activated_at) VALUES(f.league_id, true, now());
  h1 := pg_temp.policy_player(f.league_id, f.season_id, f.member_id, 'Policy Healthy IR', 'Healthy', 'unknown', 'ir');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND r->'moves'->0->>'kind' = 'activate'
    AND (r->'moves'->0->>'activatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1),
    'policy league activates a healthy IR player when capacity allows');
  PERFORM pg_temp.check_rules(NOT (SELECT is_on_ir FROM roster_players WHERE id = h1),
    'policy league healthy IR player returns');

  SELECT * INTO f FROM pg_temp.policy_league(9604, 1, 1);
  INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members, ir_activated_at) VALUES(f.league_id, true, now());
  h1 := pg_temp.policy_player(f.league_id, f.season_id, f.member_id, 'Policy Stuck IR', 'Healthy', 'unknown', 'ir');
  c1 := pg_temp.policy_player(f.league_id, f.season_id, f.member_id, 'Policy Healthy Active', 'Healthy', 'unknown', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'policy league full IR makes no move');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'notices') n
     WHERE n->>'reason' = 'healthy_ir_bench_full'
       AND (n->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1)),
    'policy league full IR keeps the notice');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id) = 0,
    'policy league full IR writes nothing');
  PERFORM set_config('request.jwt.claim.sub', f.user_id::text, true);
  r := public.get_auto_ir_notices(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules((r->>'enabled')::boolean
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(r->'notices') n
       WHERE n->>'reason' = 'healthy_ir_bench_full'
         AND (n->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1)),
    'policy league notices reader returns notices with Auto Lineup off');

  SELECT * INTO f FROM pg_temp.policy_league(9605, 2, 2);
  INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members, ir_activated_at) VALUES(f.league_id, true, now());
  c1 := pg_temp.policy_player(f.league_id, f.season_id, f.member_id, 'Policy Locked', 'Out', '2026-12-01', 'active');
  c2 := pg_temp.policy_player(f.league_id, f.season_id, f.member_id, 'Policy Open', 'Out', '2026-12-01', 'active');
  PERFORM pg_temp.policy_game_lock((SELECT player_id FROM roster_players WHERE id = c1), 'PLCK', 9605);
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND (r->'moves'->0->>'designatePlayerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c2),
    'policy league skips the game-locked player');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE s->>'reason' = 'game_locked'
       AND (s->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = c1)),
    'policy league reports the game-locked player as skipped');
  PERFORM pg_temp.check_rules(NOT (SELECT is_on_ir FROM roster_players WHERE id = c1)
    AND (SELECT is_on_ir FROM roster_players WHERE id = c2),
    'policy league leaves the game-locked player active');

  SELECT * INTO f FROM pg_temp.policy_league(9606, 2, 2);
  c1 := pg_temp.policy_player(f.league_id, f.season_id, f.member_id, 'Control Disabled', 'Out', '2026-12-01', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0
    AND jsonb_array_length(r->'skipped') = 0
    AND jsonb_array_length(r->'notices') = 0,
    'control league with Auto Lineup off returns empty');
  PERFORM pg_temp.check_rules(NOT (SELECT is_on_ir FROM roster_players WHERE id = c1),
    'control league with Auto Lineup off writes nothing');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM roster_transactions WHERE member_id = f.member_id) = 0,
    'control league with Auto Lineup off writes no transactions');
  PERFORM set_config('request.jwt.claim.sub', f.user_id::text, true);
  r := public.get_auto_ir_notices(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(NOT (r->>'enabled')::boolean AND jsonb_array_length(r->'notices') = 0,
    'control league notices reader returns nothing');

  SELECT * INTO f FROM pg_temp.policy_league(9607, 2, 2);
  UPDATE lineup_optimizer_settings SET enabled = true
   WHERE league_id = f.league_id AND league_season_id = f.season_id AND member_id = f.member_id;
  c1 := pg_temp.policy_player(f.league_id, f.season_id, f.member_id, 'Control Enabled', 'Out', '2026-12-01', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND r->'moves'->0->>'kind' = 'designate',
    'control league with Auto Lineup on still designates');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = c1),
    'control league with Auto Lineup on moves the player');

  SELECT * INTO f FROM pg_temp.policy_league(9608, 2, 2);
  INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members, ir_activated_at) VALUES(f.league_id, false, now());
  c1 := pg_temp.policy_player(f.league_id, f.season_id, f.member_id, 'Policy Disabled', 'Out', '2026-12-01', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0
    AND jsonb_array_length(r->'notices') = 0,
    'policy row with auto IR off keeps the opt-in gate');
  PERFORM pg_temp.check_rules(NOT (SELECT is_on_ir FROM roster_players WHERE id = c1),
    'policy row with auto IR off writes nothing');

  SELECT * INTO f FROM pg_temp.policy_league(9609, 2, 2);
  DELETE FROM lineup_optimizer_settings
   WHERE league_id = f.league_id AND league_season_id = f.season_id AND member_id = f.member_id;
  INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members, ir_activated_at) VALUES(f.league_id, true, now());
  c1 := pg_temp.policy_player(f.league_id, f.season_id, f.member_id, 'Policy No Settings', 'Out', '2026-12-01', 'active');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND r->'moves'->0->>'kind' = 'designate',
    'policy league admits a member with no settings row');

  SELECT * INTO f FROM pg_temp.policy_league(9611, 2, 2, 2);
  INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members, ir_activated_at) VALUES(f.league_id, true, now());
  c1 := pg_temp.policy_player(f.league_id, f.season_id, f.member_id, 'Held Active', 'Healthy', 'unknown', 'active');
  h1 := pg_temp.policy_player(f.league_id, f.season_id, f.member_id, 'Held Healthy IR', 'Healthy', 'unknown', 'ir');
  c2 := pg_temp.policy_player(f.league_id, f.season_id, f.other_member_id, 'Control Active', 'Healthy', 'unknown', 'active');
  h2 := pg_temp.policy_player(f.league_id, f.season_id, f.other_member_id, 'Control Healthy IR', 'Healthy', 'unknown', 'ir');
  INSERT INTO trades(id, league_id, league_season_id, proposer_member_id, recipient_member_id, status, accepted_at)
    VALUES('00000000-0000-0000-0000-000000009611', f.league_id, f.season_id, f.other_member_id, f.member_id, 'accepted', now());
  INSERT INTO trade_participants(trade_id, member_id, sort_order, is_initiator, accepted_at)
    VALUES('00000000-0000-0000-0000-000000009611', f.other_member_id, 0, true, now()),
           ('00000000-0000-0000-0000-000000009611', f.member_id, 1, false, now());
  INSERT INTO trade_items(trade_id, side, player_id, from_member_id, to_member_id, to_ir, to_taxi)
    VALUES('00000000-0000-0000-0000-000000009611', 'proposer', (SELECT player_id FROM roster_players WHERE id = c2), f.other_member_id, f.member_id, false, false);
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0,
    'held team IR return is skipped');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE (s->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = h1)
       AND s->>'sqlstate' = 'PT409'),
    'held team reports the trade-held IR return as skipped');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = h1),
    'held team healthy IR player stays on IR');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.other_member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 1
    AND r->'moves'->0->>'kind' = 'activate',
    'control team IR return still applies');
  PERFORM pg_temp.check_rules(NOT (SELECT is_on_ir FROM roster_players WHERE id = h2),
    'control team healthy IR player returns');
  r := public.process_roster_floor_service(f.league_id, f.season_id);
  PERFORM pg_temp.check_rules(r IS NOT NULL, 'floor run completes with a held trade');
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = h1),
    'held team healthy IR player stays on IR after commit-time checks');
  PERFORM pg_temp.check_rules((SELECT status FROM trades WHERE id = '00000000-0000-0000-0000-000000009611') = 'accepted',
    'accepted trade is unchanged');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM trade_participants WHERE trade_id = '00000000-0000-0000-0000-000000009611') = 2,
    'trade participants are unchanged');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM trade_items WHERE trade_id = '00000000-0000-0000-0000-000000009611') = 1,
    'trade items are unchanged');
END;
$$;

DO $$
DECLARE
  f record;
  g record;
  r jsonb;
  y1 uuid;
  y2 uuid;
  x1 uuid;
BEGIN
  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';
  INSERT INTO season_weeks(season_year, week_number, week_start, week_end)
    SELECT year, 1, (now() AT TIME ZONE 'America/New_York')::date - 3, (now() AT TIME ZONE 'America/New_York')::date + 3
      FROM unnest(ARRAY[9612, 9613]) year
    ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key DO NOTHING;
  SELECT * INTO f FROM pg_temp.policy_league(9612, 2, 1, 2);
  INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members, ir_activated_at) VALUES(f.league_id, true, now());
  PERFORM pg_temp.policy_player(f.league_id, f.season_id, f.member_id, 'Held Healthy', 'Healthy', 'unknown', 'active');
  y1 := pg_temp.policy_player(f.league_id, f.season_id, f.member_id, 'Held Injured Starter', 'Out', ((now() AT TIME ZONE 'America/New_York')::date + 14)::text, 'active');
  x1 := pg_temp.policy_player(f.league_id, f.season_id, f.other_member_id, 'Incoming To IR', 'Out', ((now() AT TIME ZONE 'America/New_York')::date + 30)::text, 'active');
  INSERT INTO weekly_lineups(league_id, league_season_id, member_id, player_id, week_number, game_date, slot_type, is_auto_set)
    VALUES(f.league_id, f.season_id, f.member_id, (SELECT player_id FROM roster_players WHERE id = y1), 1, (now() AT TIME ZONE 'America/New_York')::date, 'PG', false);
  INSERT INTO trades(id, league_id, league_season_id, proposer_member_id, recipient_member_id, status, accepted_at)
    VALUES('00000000-0000-0000-0000-000000009612', f.league_id, f.season_id, f.other_member_id, f.member_id, 'accepted', now());
  INSERT INTO trade_participants(trade_id, member_id, sort_order, is_initiator, accepted_at)
    VALUES('00000000-0000-0000-0000-000000009612', f.other_member_id, 0, true, now()),
           ('00000000-0000-0000-0000-000000009612', f.member_id, 1, false, now());
  INSERT INTO trade_items(trade_id, side, player_id, from_member_id, to_member_id, to_ir, to_taxi)
    VALUES('00000000-0000-0000-0000-000000009612', 'proposer', (SELECT player_id FROM roster_players WHERE id = x1), f.other_member_id, f.member_id, true, false);

  SELECT * INTO g FROM pg_temp.policy_league(9613, 2, 1, 1);
  INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members, ir_activated_at) VALUES(g.league_id, true, now());
  PERFORM pg_temp.policy_player(g.league_id, g.season_id, g.member_id, 'Control Healthy', 'Healthy', 'unknown', 'active');
  y2 := pg_temp.policy_player(g.league_id, g.season_id, g.member_id, 'Control Injured Starter', 'Out', ((now() AT TIME ZONE 'America/New_York')::date + 14)::text, 'active');
  INSERT INTO weekly_lineups(league_id, league_season_id, member_id, player_id, week_number, game_date, slot_type, is_auto_set)
    VALUES(g.league_id, g.season_id, g.member_id, (SELECT player_id FROM roster_players WHERE id = y2), 1, (now() AT TIME ZONE 'America/New_York')::date, 'PG', false);

  r := public.auto_manage_ir_service(g.league_id, g.season_id, g.member_id);
  PERFORM pg_temp.check_rules(r->'moves' @> jsonb_build_array(jsonb_build_object('kind', 'designate', 'designatePlayerId', (SELECT player_id FROM roster_players WHERE id = y2)::text)),
    'control designation fills the open IR slot without a trade');
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_id);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0,
    'held team designation into the reserved IR slot is skipped');
  PERFORM pg_temp.check_rules(EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'skipped') s
     WHERE (s->>'playerId')::uuid = (SELECT player_id FROM roster_players WHERE id = y1)
       AND s->>'sqlstate' = 'PT409'),
    'held team reports the trade-held IR designation as skipped');
  r := public.process_roster_floor_service(f.league_id, f.season_id);
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  PERFORM pg_temp.check_rules(NOT (SELECT is_on_ir FROM roster_players WHERE id = y1),
    'held injured starter stays active after commit-time checks');
  PERFORM pg_temp.check_rules(EXISTS (SELECT 1 FROM weekly_lineups WHERE league_id = f.league_id AND player_id = (SELECT player_id FROM roster_players WHERE id = y1) AND slot_type = 'PG' AND NOT is_auto_set),
    'held manual starter stays in its slot');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE id = y2),
    'control injured starter is on IR after commit-time checks');
  PERFORM pg_temp.check_rules(NOT EXISTS (SELECT 1 FROM weekly_lineups WHERE league_id = g.league_id AND player_id = (SELECT player_id FROM roster_players WHERE id = y2)),
    'control IR-moved starter leaves the lineup');
  PERFORM pg_temp.check_rules((SELECT status FROM trades WHERE id = '00000000-0000-0000-0000-000000009612') = 'accepted'
    AND (SELECT to_ir FROM trade_items WHERE trade_id = '00000000-0000-0000-0000-000000009612'),
    'the IR-reserving trade is unchanged');
END;
$$;

CREATE TEMP TABLE policy_role_fixture AS SELECT * FROM pg_temp.rules_fixture(1, 9610);
GRANT SELECT ON policy_role_fixture TO authenticated, anon;
SET LOCAL ROLE authenticated;
SELECT pg_temp.expect_denied('SELECT count(*) FROM private.league_roster_policies');
SELECT pg_temp.expect_denied(format('SELECT private.league_auto_ir_all_members(%L)',
  (SELECT league_id FROM policy_role_fixture)));
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.expect_denied('SELECT count(*) FROM private.league_roster_policies');
SELECT pg_temp.expect_denied(format('SELECT private.league_auto_ir_all_members(%L)',
  (SELECT league_id FROM policy_role_fixture)));
RESET ROLE;

SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
