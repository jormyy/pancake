\getenv identity_test_db SUPABASE_DB_URL
\getenv identity_test_port PANCAKE_TEST_DB_PORT
\if :{?identity_test_db}
\else
  \echo SUPABASE_DB_URL is required
  \quit 3
\endif
\if :{?identity_test_port}
\else
  \set identity_test_port 54322
\endif
\if :{?identity_watch_path}
\else
  \set identity_watch_path all
\endif
SELECT set_config('identity.test_db', :'identity_test_db', false) \gset
SELECT set_config('identity.test_port', :'identity_test_port', false) \gset
DO $$ BEGIN
  IF current_setting('identity.test_port') !~ '^[0-9]+$' OR current_setting('identity.test_db') !~
    format('^postgres(ql)?://[^/@]+@(127[.]0[.]0[.]1|localhost):%s/[^?]+([?].*)?$', current_setting('identity.test_port')) THEN
    RAISE EXCEPTION 'Only the expected loopback database port is allowed';
  END IF;
END $$;
BEGIN;
SELECT set_config('identity.watch_path', :'identity_watch_path', true) \gset
CREATE TEMP TABLE identity_expected_watches(league_id uuid, member_id uuid, player_id uuid);
DO $$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_opponent uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_league uuid := gen_random_uuid();
  v_other_league uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
  v_other_member uuid := gen_random_uuid();
  v_foreign_member uuid := gen_random_uuid();
  v_same_user_member uuid := gen_random_uuid();
  v_unrelated uuid := gen_random_uuid();
  v_winner uuid;
  v_loser uuid;
  v_provider text;
  v_name text;
  v_path text;
  v_receipt jsonb;
  v_outbox bigint;
  v_waivers bigint;
BEGIN
  IF current_setting('identity.watch_path') NOT IN ('all', 'direct', 'import') THEN
    RAISE EXCEPTION 'Unknown watch merge path';
  END IF;
  INSERT INTO auth.users(id, email, raw_user_meta_data)
    SELECT id, id::text || '@example.test', jsonb_build_object('username', id::text)
    FROM unnest(ARRAY[v_owner, v_opponent, v_outsider]) AS id;
  INSERT INTO leagues(id, name, slug, commissioner_id, status)
    VALUES(v_league, 'Synthetic identity watch merge', v_league::text, v_owner, 'offseason'),
      (v_other_league, 'Other watch league', v_other_league::text, v_outsider, 'offseason');
  INSERT INTO league_members(id, league_id, user_id, role, team_name)
    VALUES(v_member, v_league, v_owner, 'commissioner', 'Owner'),
      (v_other_member, v_league, v_opponent, 'manager', 'Opponent'),
      (v_foreign_member, v_other_league, v_outsider, 'commissioner', 'Outside'),
      (v_same_user_member, v_other_league, v_owner, 'manager', 'Same user, other league');
  INSERT INTO players(id, first_name, last_name) VALUES(v_unrelated, 'Synthetic', v_unrelated::text);
  PERFORM set_config('request.jwt.claim.sub', v_outsider::text, true);
  PERFORM notif_set_player_watch_atomic(v_other_league, v_unrelated, true);

  FOR v_path IN SELECT unnest(CASE current_setting('identity.watch_path')
      WHEN 'all' THEN ARRAY['direct', 'import'] ELSE ARRAY[current_setting('identity.watch_path')] END)
  LOOP
    v_winner := gen_random_uuid();
    v_loser := gen_random_uuid();
    v_provider := 'identity-watch-' || v_winner::text;
    INSERT INTO players(id, first_name, last_name, nba_id, nba_draft_number)
      VALUES(v_winner, 'Synthetic', v_winner::text, v_provider, NULL),
        (v_loser, 'Synthetic', v_loser::text, NULL, 8);
    SELECT display_name INTO v_name FROM players WHERE id = v_loser;
    PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
    PERFORM notif_set_player_watch_atomic(v_league, v_loser, true);
    PERFORM notif_set_player_watch_atomic(v_other_league, v_loser, true);
    PERFORM set_config('request.jwt.claim.sub', v_opponent::text, true);
    PERFORM notif_set_player_watch_atomic(v_league, v_loser, true);
    PERFORM notif_set_player_watch_atomic(v_league, v_winner, true);

    TRUNCATE identity_expected_watches;
    INSERT INTO identity_expected_watches
      SELECT DISTINCT league_id, member_id, CASE WHEN player_id = v_loser THEN v_winner ELSE player_id END
      FROM player_watches WHERE league_id IN (v_league, v_other_league);
    SELECT count(*) INTO v_outbox FROM notification_outbox WHERE member_id IN (v_member, v_other_member, v_foreign_member, v_same_user_member);
    SELECT count(*) INTO v_waivers FROM waiver_wire_log WHERE league_id IN (v_league, v_other_league);
    IF v_path = 'direct' THEN
      PERFORM merge_players(v_winner, v_loser);
    ELSE
      v_receipt := resolve_player_imports_atomic('nba_index', jsonb_build_array(jsonb_build_object(
        'provider_id', v_provider, 'player_id', v_loser, 'expected_display_name', v_name, 'name_match', 'exact')));
      IF v_receipt->'results'->0->>'player_id' IS DISTINCT FROM v_winner::text
        OR v_receipt->'results'->0->>'action' IS DISTINCT FROM 'updated' THEN
        RAISE EXCEPTION 'Real index import does not merge the watched placeholder: %', v_receipt;
      END IF;
    END IF;
    IF EXISTS(SELECT FROM players WHERE id = v_loser)
      OR (SELECT nba_draft_number FROM players WHERE id = v_winner) IS DISTINCT FROM 8 THEN
      RAISE EXCEPTION '% merge must keep one canonical player and draft history', v_path;
    END IF;
    IF EXISTS(
      (SELECT * FROM identity_expected_watches EXCEPT
        SELECT league_id, member_id, player_id FROM player_watches WHERE league_id IN (v_league, v_other_league))
      UNION ALL
      (SELECT league_id, member_id, player_id FROM player_watches WHERE league_id IN (v_league, v_other_league)
        EXCEPT SELECT * FROM identity_expected_watches)
    ) OR (SELECT count(*) FROM player_watches WHERE player_id = v_winner) <> 3 THEN
      RAISE EXCEPTION '% merge loses watches, duplicates a watch, or changes league membership', v_path;
    END IF;
    IF (SELECT count(*) FROM notification_outbox WHERE member_id IN (v_member, v_other_member, v_foreign_member, v_same_user_member)) <> v_outbox
      OR (SELECT count(*) FROM waiver_wire_log WHERE league_id IN (v_league, v_other_league)) <> v_waivers THEN
      RAISE EXCEPTION '% identity merge emits a drop event or waiver log', v_path;
    END IF;
    PERFORM merge_players(v_winner, v_loser);
    IF (SELECT count(*) FROM player_watches WHERE player_id = v_winner) <> 3 THEN
      RAISE EXCEPTION '% repeated merge changes watches', v_path;
    END IF;
    RAISE NOTICE 'PASS SYNTHETIC % merge preserves loser-only and overlapping watches, league scope, and silent identity repair', v_path;
  END LOOP;
END $$;
ROLLBACK;
