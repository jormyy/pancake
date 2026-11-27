BEGIN;
CREATE TEMP TABLE rookie_fixture (key text PRIMARY KEY, id uuid NOT NULL);
DO $$
DECLARE
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid();
  l uuid := gen_random_uuid(); a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
  prior uuid := gen_random_uuid(); s uuid := gen_random_uuid();
  player_ids uuid[] := ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 14));
  i int;
BEGIN
  INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (ua, 'authenticated', 'authenticated', ua || '@example.test', 'x', now(), '{}', '{}', now(), now()),
         (ub, 'authenticated', 'authenticated', ub || '@example.test', 'x', now(), '{}', '{}', now(), now());
  INSERT INTO leagues(id, name, slug, commissioner_id, status, roster_size, taxi_slots, rookie_draft_order)
  VALUES (l, 'Rookie selection', l::text, ua, 'offseason', 3, 1, 'linear');
  INSERT INTO league_members(id, league_id, user_id, role, team_name)
  VALUES (a, l, ua, 'commissioner', 'Alpha'), (b, l, ub, 'manager', 'Beta');
  INSERT INTO league_seasons(id, league_id, season_year, is_current) VALUES (prior, l, 2098, false), (s, l, 2099, true);
  INSERT INTO standings(league_id, league_season_id, member_id, week_number, wins, losses, ties, points_for)
  VALUES (l, prior, a, 20, 2, 18, 0, 1000), (l, prior, b, 20, 18, 2, 0, 2000);

  FOR i IN 1..14 LOOP
    INSERT INTO players(id, first_name, last_name, position, eligible_positions, years_exp, nba_id)
    VALUES (player_ids[i], 'Fixture', 'Player' || lpad(i::text, 2, '0'), 'SF', ARRAY['SF'], 0, 'rookie-fixture-' || player_ids[i]);
  END LOOP;
  UPDATE players SET draft_status = 'drafted', draft_year = 2098, draft_round = 1,
         draft_overall_pick = array_position(player_ids, id)
   WHERE id = ANY(player_ids[1:6]);
  UPDATE players SET draft_status = 'drafted', draft_year = 2097, draft_round = 1, draft_overall_pick = 1 WHERE id = player_ids[7];
  UPDATE players SET draft_status = 'undrafted', nba_draft_number = 99 WHERE id = player_ids[8];
  UPDATE players SET draft_status = 'drafted', draft_year = 2098, draft_round = 1, draft_overall_pick = 7 WHERE id IN (player_ids[9], player_ids[10]);
  UPDATE players SET draft_status = 'drafted', draft_year = 2098, draft_round = 1, draft_overall_pick = 8 WHERE id = player_ids[11];
  UPDATE players SET years_exp = 6 WHERE id = ANY(player_ids[12:14]);

  INSERT INTO roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
  VALUES (l, s, a, player_ids[12], 'trade'), (l, s, a, player_ids[13], 'trade'), (l, s, a, player_ids[14], 'trade'),
         (l, s, b, player_ids[11], 'trade');

  INSERT INTO draft_picks(league_id, season_year, round, original_owner_id, current_owner_id)
  SELECT l, 2098, round, owner, CASE WHEN round = 1 AND owner = b THEN a ELSE owner END
    FROM generate_series(1, 3) round CROSS JOIN unnest(ARRAY[a, b]) owner;
  INSERT INTO draft_pick_swaps(league_id, season_year, round, holder_member_id, counterparty_member_id)
  VALUES (l, 2098, 2, a, b), (l, 2098, 3, b, a);

  INSERT INTO rookie_fixture VALUES ('ua', ua), ('ub', ub), ('league', l), ('a', a), ('b', b), ('season', s);
  FOR i IN 1..14 LOOP INSERT INTO rookie_fixture VALUES ('p' || i, player_ids[i]); END LOOP;
END;
$$;

CREATE TEMP TABLE rookie_errors (step text PRIMARY KEY, sqlstate text, message text);
CREATE FUNCTION pg_temp.f(k text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM rookie_fixture WHERE key = k $$;
CREATE FUNCTION pg_temp.as_user(k text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', pg_temp.f(k)::text, false), set_config('request.jwt.claim.role', 'authenticated', false)
$$;
CREATE FUNCTION pg_temp.as_service() RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', 'service_role', false)
$$;
CREATE FUNCTION pg_temp.try_select(step text, member text, player text, destination text, drops uuid[], expected int) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
  result := public.make_rookie_selection_atomic((SELECT id FROM drafts WHERE league_id = pg_temp.f('league') AND NOT is_mock),
    pg_temp.f(member), pg_temp.f(player), destination, drops, expected);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO rookie_errors VALUES (step, SQLSTATE, SQLERRM);
  RETURN NULL;
END;
$$;
CREATE FUNCTION pg_temp.expect_error(step text, pattern text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE message text;
BEGIN
  SELECT e.message INTO message FROM rookie_errors e WHERE e.step = expect_error.step;
  IF message IS NULL OR message !~ pattern THEN
    RAISE EXCEPTION '% should fail with %, got %', step, pattern, COALESCE(message, 'success');
  END IF;
END;
$$;
CREATE FUNCTION pg_temp.state() RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'picks', (SELECT jsonb_agg(jsonb_build_array(overall_pick, member_id, player_id, to_taxi) ORDER BY overall_pick)
      FROM snake_draft_picks WHERE draft_id = (SELECT id FROM drafts WHERE league_id = pg_temp.f('league') AND NOT is_mock)),
    'roster', (SELECT jsonb_agg(jsonb_build_array(member_id, player_id, is_on_taxi) ORDER BY member_id, player_id)
      FROM roster_players WHERE league_id = pg_temp.f('league')),
    'assets', (SELECT jsonb_agg(jsonb_build_array(id, current_owner_id, is_used) ORDER BY id) FROM draft_picks WHERE league_id = pg_temp.f('league')),
    'transactions', (SELECT count(*) FROM roster_transactions WHERE league_id = pg_temp.f('league')),
    'waivers', (SELECT count(*) FROM waiver_wire_log WHERE league_id = pg_temp.f('league')))
$$;

DO $$
DECLARE
  status jsonb;
  outcomes jsonb;
BEGIN
  PERFORM public.record_nba_draft_class_import(2098, 'fixture', NULL, 'NBA.com timed out');
  status := private.rookie_class_status(2098);
  IF status->>'state' <> 'failed' OR (status->>'eligibleCount')::int <> 7 THEN
    RAISE EXCEPTION 'A failed import with no stored board must read as failed, got %', status;
  END IF;
  PERFORM public.record_nba_draft_class_import(2098, 'fixture', (
    SELECT jsonb_agg(jsonb_build_object('overallPick', n, 'round', 1, 'playerName', 'Fixture Player' || lpad(n::text, 2, '0'),
      'personId', CASE WHEN n <= 6 THEN 'rookie-fixture-' || pg_temp.f('p' || n) END))
      FROM generate_series(1, 9) n), NULL);
  BEGIN
    PERFORM public.record_nba_draft_class_import(2098, 'fixture',
      '[{"overallPick":1,"round":1,"playerName":"A"},{"overallPick":1,"round":1,"playerName":"B"}]', NULL);
    RAISE EXCEPTION 'A board listing a pick twice must be refused';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM public.record_nba_draft_class_import(2098, 'fixture', '[{"overallPick":101,"round":1,"playerName":"A"}]', NULL);
    RAISE EXCEPTION 'A board with an impossible pick number must be refused';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  IF (SELECT jsonb_array_length(official_picks) FROM public.nba_draft_class_imports WHERE draft_year = 2098) <> 9 THEN
    RAISE EXCEPTION 'A refused board must keep the stored board';
  END IF;
  PERFORM public.record_nba_draft_class_import(2097, 'fixture',
    '[{"overallPick":1,"round":1,"playerName":"A"},{"overallPick":3,"round":1,"playerName":"C"}]', NULL);
  IF (SELECT jsonb_array_length(official_picks) FROM public.nba_draft_class_imports WHERE draft_year = 2097) <> 2 THEN
    RAISE EXCEPTION 'A board with a forfeited pick must be stored';
  END IF;
  PERFORM public.record_nba_draft_class_import(2098, 'fixture', NULL, 'Second fetch failed');
  status := private.rookie_class_status(2098);
  IF status->>'state' <> 'incomplete' OR (status->>'officialCount')::int <> 9 OR status->>'lastError' <> 'Second fetch failed' THEN
    RAISE EXCEPTION 'A later failure must keep the stored board and report the gap, got %', status;
  END IF;
  SELECT jsonb_object_agg(overall_pick::text || ':' || COALESCE(player_id::text, '-'), outcome) INTO outcomes
    FROM private.rookie_class_reconciliation(2098) WHERE outcome <> 'eligible';
  IF outcomes <> jsonb_build_object(
      '7:' || pg_temp.f('p9'), 'duplicate', '7:' || pg_temp.f('p10'), 'duplicate', '9:-', 'missing') THEN
    RAISE EXCEPTION 'Unexpected reconciliation discrepancies %', outcomes;
  END IF;
  IF (SELECT array_agg(player_id ORDER BY draft_overall_pick) FROM private.rookie_class_players(2098))
     <> ARRAY[pg_temp.f('p1'), pg_temp.f('p2'), pg_temp.f('p3'), pg_temp.f('p4'), pg_temp.f('p5'), pg_temp.f('p6'), pg_temp.f('p11')] THEN
    RAISE EXCEPTION 'Eligible class must exclude wrong-year, undrafted and duplicate players';
  END IF;
END;
$$;

SELECT pg_temp.as_service();
SELECT public.start_rookie_draft_atomic(pg_temp.f('league'), 3, false, 3600, 'pause_draft');

DO $$
DECLARE
  d uuid := (SELECT id FROM drafts WHERE league_id = pg_temp.f('league') AND NOT is_mock);
  first_member uuid;
  swaps jsonb;
  slots jsonb;
BEGIN
  SELECT member_id INTO first_member FROM draft_orders WHERE draft_id = d AND position = 1;
  IF first_member <> pg_temp.f('a') THEN RAISE EXCEPTION 'The worse record must pick first'; END IF;
  SELECT jsonb_object_agg(round::text, status) INTO swaps FROM draft_pick_swaps WHERE league_id = pg_temp.f('league');
  IF swaps <> '{"2":"unused","3":"exercised"}'::jsonb THEN RAISE EXCEPTION 'Swap outcomes wrong: %', swaps; END IF;
  SELECT jsonb_agg(jsonb_build_array(slot.overall_pick, owner.team_name, original.team_name) ORDER BY slot.overall_pick) INTO slots
    FROM snake_draft_picks slot
    JOIN draft_picks asset ON asset.id = slot.draft_pick_id
    JOIN league_members owner ON owner.id = slot.member_id
    JOIN league_members original ON original.id = asset.original_owner_id
   WHERE slot.draft_id = d;
  IF slots <> '[[1,"Alpha","Alpha"],[2,"Alpha","Beta"],[3,"Alpha","Alpha"],[4,"Beta","Beta"],[5,"Beta","Alpha"],[6,"Alpha","Beta"]]'::jsonb THEN
    RAISE EXCEPTION 'Board ownership wrong: %', slots;
  END IF;
END;
$$;

SELECT pg_temp.as_user('ua');
DO $$
DECLARE
  before jsonb := pg_temp.state();
  room_a jsonb;
  room_b jsonb;
  d uuid := (SELECT id FROM drafts WHERE league_id = pg_temp.f('league') AND NOT is_mock);
BEGIN
  room_a := public.view_draft_room(pg_temp.f('league'), pg_temp.f('a'), jsonb_build_object('draftId', d));
  IF (SELECT array_agg((p->>'draft_overall_pick')::int ORDER BY ord) FROM jsonb_array_elements(room_a->'prospects') WITH ORDINALITY x(p, ord)) <> ARRAY[1,2,3,4,5,6] THEN
    RAISE EXCEPTION 'Prospects must be the available class in NBA draft order: %', room_a->'prospects';
  END IF;
  IF room_a->'classStatus'->>'state' <> 'incomplete' OR (room_a->'classStatus'->>'availableCount')::int <> 6 THEN
    RAISE EXCEPTION 'Room must report the class status: %', room_a->'classStatus';
  END IF;
  IF room_a->'picks'->1->>'originalTeamName' <> 'Beta' OR room_a->'picks'->4->'swap'->>'status' <> 'exercised'
     OR room_a->'picks'->2->'swap'->>'status' <> 'unused' THEN
    RAISE EXCEPTION 'Board must show original owners and swaps: %', room_a->'picks';
  END IF;

  PERFORM pg_temp.as_user('ub');
  room_b := public.view_draft_room(pg_temp.f('league'), pg_temp.f('b'), jsonb_build_object('draftId', d));
  IF room_b->'picks' <> room_a->'picks' OR room_b->'nextPick' <> room_a->'nextPick' THEN
    RAISE EXCEPTION 'Both managers must see the same board';
  END IF;
  PERFORM pg_temp.as_service();

  PERFORM pg_temp.try_select('wrong manager', 'b', 'p1', 'active', '{}', 1);
  PERFORM pg_temp.expect_error('wrong manager', 'not your pick');
  PERFORM pg_temp.try_select('wrong year', 'a', 'p7', 'taxi', '{}', 1);
  PERFORM pg_temp.expect_error('wrong year', 'NBA draft');
  PERFORM pg_temp.try_select('duplicate', 'a', 'p9', 'taxi', '{}', 1);
  PERFORM pg_temp.expect_error('duplicate', 'NBA draft');
  PERFORM pg_temp.try_select('rostered', 'a', 'p11', 'taxi', '{}', 1);
  PERFORM pg_temp.expect_error('rostered', 'already on a roster');
  PERFORM pg_temp.try_select('full roster', 'a', 'p1', 'active', '{}', 1);
  PERFORM pg_temp.expect_error('full roster', 'over the limit of 3');
  PERFORM pg_temp.try_select('drop elsewhere', 'a', 'p1', 'active', ARRAY[(SELECT id FROM roster_players WHERE player_id = pg_temp.f('p11'))], 1);
  PERFORM pg_temp.expect_error('drop elsewhere', 'no longer on your roster');
  IF pg_temp.state() <> before THEN RAISE EXCEPTION 'Rejected selections must change nothing'; END IF;
END;
$$;

DO $$
DECLARE
  result jsonb;
  dropped uuid := (SELECT id FROM roster_players WHERE player_id = pg_temp.f('p12'));
  d uuid := (SELECT id FROM drafts WHERE league_id = pg_temp.f('league') AND NOT is_mock);
  before jsonb;
BEGIN
  result := pg_temp.try_select('replace', 'a', 'p1', 'active', ARRAY[dropped], 1);
  IF result IS NULL THEN RAISE EXCEPTION 'Replace failed: %', (SELECT message FROM rookie_errors WHERE step = 'replace'); END IF;
  IF (result->>'active_count')::int <> 3 OR EXISTS (SELECT 1 FROM roster_players WHERE id = dropped)
     OR NOT EXISTS (SELECT 1 FROM roster_players WHERE player_id = pg_temp.f('p1') AND member_id = pg_temp.f('a') AND NOT is_on_taxi)
     OR NOT EXISTS (SELECT 1 FROM waiver_wire_log WHERE player_id = pg_temp.f('p12'))
     OR NOT EXISTS (SELECT 1 FROM roster_transactions WHERE player_id = pg_temp.f('p12') AND transaction_type = 'fa_drop')
     OR NOT EXISTS (SELECT 1 FROM roster_transactions WHERE player_id = pg_temp.f('p1') AND transaction_type = 'draft_won') THEN
    RAISE EXCEPTION 'Replace must draft the rookie and drop the player together: %', result;
  END IF;

  before := pg_temp.state();
  PERFORM pg_temp.try_select('double tap', 'a', 'p2', 'taxi', '{}', 1);
  PERFORM pg_temp.expect_error('double tap', 'Pick 1 was already made');
  IF pg_temp.state() <> before THEN RAISE EXCEPTION 'A repeated tap must change nothing'; END IF;

  result := pg_temp.try_select('taxi', 'a', 'p2', 'taxi', '{}', 2);
  IF result IS NULL OR NOT EXISTS (SELECT 1 FROM roster_players WHERE player_id = pg_temp.f('p2') AND is_on_taxi) THEN
    RAISE EXCEPTION 'Taxi placement failed: %', (SELECT message FROM rookie_errors WHERE step = 'taxi');
  END IF;

  before := pg_temp.state();
  PERFORM pg_temp.try_select('taxi full', 'a', 'p3', 'taxi', '{}', 3);
  IF NOT EXISTS (SELECT 1 FROM rookie_errors WHERE step = 'taxi full') OR pg_temp.state() <> before THEN
    RAISE EXCEPTION 'A full taxi squad must refuse and change nothing';
  END IF;

  result := pg_temp.try_select('drop rookie', 'a', 'p3', 'drop', '{}', 3);
  IF result IS NULL OR EXISTS (SELECT 1 FROM roster_players WHERE player_id = pg_temp.f('p3'))
     OR NOT EXISTS (SELECT 1 FROM waiver_wire_log WHERE player_id = pg_temp.f('p3'))
     OR (SELECT player_id FROM snake_draft_picks WHERE draft_id = d AND overall_pick = 3) <> pg_temp.f('p3')
     OR NOT (SELECT is_used FROM draft_picks WHERE id = (SELECT draft_pick_id FROM snake_draft_picks WHERE draft_id = d AND overall_pick = 3)) THEN
    RAISE EXCEPTION 'Dropping the rookie must still consume the pick: %', COALESCE(result::text, (SELECT message FROM rookie_errors WHERE step = 'drop rookie'));
  END IF;

  result := pg_temp.try_select('beta pick', 'b', 'p4', 'active', '{}', 4);
  IF result IS NULL THEN RAISE EXCEPTION 'Beta pick failed: %', (SELECT message FROM rookie_errors WHERE step = 'beta pick'); END IF;
  result := pg_temp.try_select('swapped pick', 'b', 'p5', 'active', '{}', 5);
  IF result IS NULL THEN RAISE EXCEPTION 'Swapped pick failed: %', (SELECT message FROM rookie_errors WHERE step = 'swapped pick'); END IF;
END;
$$;

DO $$
DECLARE
  request uuid := gen_random_uuid();
  first jsonb;
  second jsonb;
  d uuid := (SELECT id FROM drafts WHERE league_id = pg_temp.f('league') AND NOT is_mock);
  drop_id uuid := (SELECT id FROM roster_players WHERE player_id = pg_temp.f('p13'));
BEGIN
  PERFORM set_config('request.headers', jsonb_build_object('x-request-id', request, 'x-request-actor', pg_temp.f('ua'))::text, false);
  first := pg_temp.try_select('last pick', 'a', 'p6', 'active', ARRAY[drop_id], 6);
  second := pg_temp.try_select('last pick retry', 'a', 'p6', 'active', ARRAY[drop_id], 6);
  PERFORM set_config('request.headers', '', false);
  IF first IS NULL OR second IS DISTINCT FROM first THEN
    RAISE EXCEPTION 'A reconnect retry must replay the stored result: % / % / %', first, second, (SELECT jsonb_agg(e) FROM rookie_errors e);
  END IF;
  IF (SELECT status FROM drafts WHERE id = d) <> 'completed' OR (SELECT status FROM leagues WHERE id = pg_temp.f('league')) <> 'active' THEN
    RAISE EXCEPTION 'The last legal pick must complete the draft and start the season';
  END IF;
  IF (SELECT count(*) FROM roster_players WHERE player_id = pg_temp.f('p6')) <> 1 THEN
    RAISE EXCEPTION 'The retry must not draft twice';
  END IF;
END;
$$;

DO $$
DECLARE
  over int;
BEGIN
  SELECT count(*) INTO over FROM (
    SELECT member.id FROM league_members member
      JOIN leagues league ON league.id = member.league_id
      LEFT JOIN roster_players roster ON roster.member_id = member.id
     WHERE member.league_id = pg_temp.f('league')
     GROUP BY member.id, league.roster_size, league.taxi_slots
    HAVING count(roster.id) FILTER (WHERE NOT roster.is_on_taxi AND NOT roster.is_on_ir) > league.roster_size
        OR count(roster.id) FILTER (WHERE roster.is_on_taxi) > league.taxi_slots) teams;
  IF over <> 0 THEN RAISE EXCEPTION 'Every roster must be legal after the draft'; END IF;
END;
$$;

SELECT 'rookie-draft-selection: ok' AS result;
ROLLBACK;
