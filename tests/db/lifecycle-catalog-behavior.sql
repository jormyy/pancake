BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000030001', 'authenticated', 'authenticated',
  'lifecycle-catalog@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name)
VALUES ('00000000-0000-0000-0000-000000030001', 'lifecycle_catalog_user', 'Lifecycle Catalog User')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.leagues (id, name, slug, commissioner_id, status)
VALUES (
  '00000000-0000-0000-0000-000000030101', 'Lifecycle Catalog Test',
  'lifecycle-catalog-test', '00000000-0000-0000-0000-000000030001', 'active'
);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES (
  '00000000-0000-0000-0000-000000030201',
  '00000000-0000-0000-0000-000000030101',
  '00000000-0000-0000-0000-000000030001', 'commissioner', 'Catalog Team'
);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES
  ('00000000-0000-0000-0000-000000030002', 'authenticated', 'authenticated', 'trade-b@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000030003', 'authenticated', 'authenticated', 'trade-c@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name)
VALUES
  ('00000000-0000-0000-0000-000000030002', 'lifecycle_trade_b', 'Trade B'),
  ('00000000-0000-0000-0000-000000030003', 'lifecycle_trade_c', 'Trade C')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES
  ('00000000-0000-0000-0000-000000030202', '00000000-0000-0000-0000-000000030101', '00000000-0000-0000-0000-000000030002', 'manager', 'Trade B'),
  ('00000000-0000-0000-0000-000000030203', '00000000-0000-0000-0000-000000030101', '00000000-0000-0000-0000-000000030003', 'manager', 'Trade C');

INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES (
  '00000000-0000-0000-0000-000000030301',
  '00000000-0000-0000-0000-000000030101', 2099, true
);

INSERT INTO public.players (id, first_name, last_name, nba_team, position, years_exp, eligible_positions)
VALUES (
  '00000000-0000-0000-0000-000000030401', 'Due', 'Waiver', 'FA', 'PG', 1, ARRAY['PG']
);

INSERT INTO public.waiver_wire_log (
  id, league_id, league_season_id, player_id, dropped_by_member_id, clears_at
)
VALUES (
  '00000000-0000-0000-0000-000000030501',
  '00000000-0000-0000-0000-000000030101',
  '00000000-0000-0000-0000-000000030301',
  '00000000-0000-0000-0000-000000030401',
  '00000000-0000-0000-0000-000000030201', now() - interval '1 minute'
);

INSERT INTO public.trades (
  league_id, league_season_id, proposer_member_id, recipient_member_id,
  status, proposed_at, accepted_at, veto_window_expires_at
)
SELECT
  '00000000-0000-0000-0000-000000030101',
  '00000000-0000-0000-0000-000000030301',
  '00000000-0000-0000-0000-000000030202',
  '00000000-0000-0000-0000-000000030203',
  'accepted', now() + make_interval(secs => series), now(), now() + interval '1 day'
FROM generate_series(1, 41) AS series;

WITH personal_trade AS (
  INSERT INTO public.trades (
    league_id, league_season_id, proposer_member_id, recipient_member_id,
    status, proposed_at
  ) VALUES (
    '00000000-0000-0000-0000-000000030101',
    '00000000-0000-0000-0000-000000030301',
    '00000000-0000-0000-0000-000000030202',
    '00000000-0000-0000-0000-000000030201',
    'pending', now() - interval '1 day'
  )
  RETURNING id
)
INSERT INTO public.trade_participants (trade_id, member_id, sort_order, is_initiator, accepted_at)
SELECT id, '00000000-0000-0000-0000-000000030202'::uuid, 0, true, now() FROM personal_trade
UNION ALL
SELECT id, '00000000-0000-0000-0000-000000030201'::uuid, 1, false, NULL FROM personal_trade;

DO $$
DECLARE
  v_visible_count int;
  v_personal_count int;
  v_pending_count bigint;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000030001', true);
  SET LOCAL ROLE authenticated;

  SELECT count(*), count(*) FILTER (WHERE recipient_member_id = '00000000-0000-0000-0000-000000030201')
    INTO v_visible_count, v_personal_count
    FROM public.get_trades_for_member(
      '00000000-0000-0000-0000-000000030201',
      '00000000-0000-0000-0000-000000030101', 40, 0
    );
  SELECT public.get_pending_trade_count(
    '00000000-0000-0000-0000-000000030201',
    '00000000-0000-0000-0000-000000030101'
  ) INTO v_pending_count;

  IF v_visible_count <> 40 OR v_personal_count <> 1 THEN
    RAISE EXCEPTION 'Visible trade page lost personal trade: total %, personal %', v_visible_count, v_personal_count;
  END IF;
  IF v_pending_count <> 1 THEN
    RAISE EXCEPTION 'Pending trade count expected 1, found %', v_pending_count;
  END IF;
END $$;

RESET ROLE;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.roster_players (
      league_id, league_season_id, member_id, player_id, acquired_via
    ) VALUES (
      '00000000-0000-0000-0000-000000030101',
      '00000000-0000-0000-0000-000000030301',
      '00000000-0000-0000-0000-000000030201',
      '00000000-0000-0000-0000-000000030401', 'free_agent'
    );
    RAISE EXCEPTION 'Due waiver player was acquired as a free agent';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'This player is on waivers%' THEN RAISE; END IF;
  END;

  INSERT INTO public.roster_players (
    league_id, league_season_id, member_id, player_id, acquired_via
  ) VALUES (
    '00000000-0000-0000-0000-000000030101',
    '00000000-0000-0000-0000-000000030301',
    '00000000-0000-0000-0000-000000030201',
    '00000000-0000-0000-0000-000000030401', 'waiver'
  );

  UPDATE public.leagues
     SET status = 'archived', deleted_at = now(), deleted_by = commissioner_id
   WHERE id = '00000000-0000-0000-0000-000000030101';

  BEGIN
    INSERT INTO public.league_seasons (league_id, season_year, is_current)
    VALUES ('00000000-0000-0000-0000-000000030101', 2100, false);
    RAISE EXCEPTION 'Deleted league accepted a new season';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Deleted leagues cannot be advanced.' THEN RAISE; END IF;
  END;
END $$;

DO $$
DECLARE
  v_avatar_policies int;
BEGIN
  SELECT count(*) INTO v_avatar_policies
    FROM pg_policies
   WHERE schemaname = 'storage'
     AND tablename = 'objects'
     AND policyname IN (
       'avatars_read_public', 'avatars_insert_own',
       'avatars_update_own', 'avatars_delete_own'
     );
  IF v_avatar_policies <> 4 THEN
    RAISE EXCEPTION 'Expected four avatar policies, found %', v_avatar_policies;
  END IF;

  IF to_regclass('public.idx_trades_due_accepted_queue') IS NULL THEN
    RAISE EXCEPTION 'Due accepted-trade queue index is missing';
  END IF;
  IF to_regclass('public.idx_trade_vetos_trade_member') IS NOT NULL THEN
    RAISE EXCEPTION 'Duplicate trade veto index still exists';
  END IF;
END $$;

ROLLBACK;
