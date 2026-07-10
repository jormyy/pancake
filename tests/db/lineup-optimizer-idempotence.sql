BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000091001',
  'authenticated',
  'authenticated',
  'lineup-idempotence@example.test',
  'x',
  now(),
  '{}'::jsonb,
  '{"username":"lineup_idempotence"}'::jsonb,
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name)
VALUES (
  '00000000-0000-0000-0000-000000091001',
  'lineup_idempotence',
  'Lineup Idempotence'
)
ON CONFLICT (id) DO UPDATE
SET username = EXCLUDED.username,
    display_name = EXCLUDED.display_name;

INSERT INTO public.players (
  id, sportsdata_id, first_name, last_name, nba_team, position, eligible_positions
)
VALUES (
  '00000000-0000-0000-0000-000000091101',
  'lineup-idempotence-player',
  'Lineup',
  'Idempotence',
  'ATL',
  'PG',
  ARRAY['PG']
);

INSERT INTO public.leagues (
  id, name, slug, commissioner_id, status, roster_size, auction_budget
)
VALUES (
  '00000000-0000-0000-0000-000000091201',
  'Lineup Idempotence League',
  'lineup-idempotence-league',
  '00000000-0000-0000-0000-000000091001',
  'active',
  12,
  200
);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES (
  '00000000-0000-0000-0000-000000091301',
  '00000000-0000-0000-0000-000000091201',
  '00000000-0000-0000-0000-000000091001',
  'commissioner',
  'Idempotent Team'
);

INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES (
  '00000000-0000-0000-0000-000000091401',
  '00000000-0000-0000-0000-000000091201',
  2099,
  true
);

INSERT INTO public.season_weeks (id, season_year, week_number, week_start, week_end)
VALUES (
  '00000000-0000-0000-0000-000000091451',
  2099,
  1,
  '2098-12-29',
  '2099-01-04'
);

INSERT INTO public.roster_players (
  id, league_id, league_season_id, member_id, player_id, acquired_via
)
VALUES (
  '00000000-0000-0000-0000-000000091501',
  '00000000-0000-0000-0000-000000091201',
  '00000000-0000-0000-0000-000000091401',
  '00000000-0000-0000-0000-000000091301',
  '00000000-0000-0000-0000-000000091101',
  'draft'
);

INSERT INTO public.lineup_slot_templates (league_id, slot_type, slot_count)
VALUES ('00000000-0000-0000-0000-000000091201', 'PG', 1)
ON CONFLICT (league_id, slot_type) DO UPDATE SET slot_count = EXCLUDED.slot_count;

SELECT public.auto_set_lineup_service_atomic(
  '00000000-0000-0000-0000-000000091301',
  '00000000-0000-0000-0000-000000091201',
  '00000000-0000-0000-0000-000000091401',
  '2099-01-02',
  jsonb_build_array(jsonb_build_object(
    'player_id', '00000000-0000-0000-0000-000000091101',
    'slot_type', 'PG',
    'is_auto_set', true,
    'week_number', 1
  ))
);

CREATE TEMP TABLE first_lineup_state AS
SELECT player_id, slot_type, is_auto_set, week_number, game_date
  FROM public.weekly_lineups
 WHERE member_id = '00000000-0000-0000-0000-000000091301'
   AND game_date = '2099-01-02';

SELECT public.auto_set_lineup_service_atomic(
  '00000000-0000-0000-0000-000000091301',
  '00000000-0000-0000-0000-000000091201',
  '00000000-0000-0000-0000-000000091401',
  '2099-01-02',
  jsonb_build_array(jsonb_build_object(
    'player_id', '00000000-0000-0000-0000-000000091101',
    'slot_type', 'PG',
    'is_auto_set', true,
    'week_number', 1
  ))
);

DO $$
BEGIN
  IF (SELECT count(*) FROM first_lineup_state) <> 1 OR
     (SELECT count(*) FROM public.weekly_lineups
       WHERE member_id = '00000000-0000-0000-0000-000000091301'
         AND game_date = '2099-01-02') <> 1 THEN
    RAISE EXCEPTION 'Repeated auto-set changed lineup cardinality.';
  END IF;

  IF EXISTS (
    (SELECT player_id, slot_type, is_auto_set, week_number, game_date
       FROM first_lineup_state
     EXCEPT
     SELECT player_id, slot_type, is_auto_set, week_number, game_date
       FROM public.weekly_lineups
      WHERE member_id = '00000000-0000-0000-0000-000000091301'
        AND game_date = '2099-01-02')
    UNION ALL
    (SELECT player_id, slot_type, is_auto_set, week_number, game_date
       FROM public.weekly_lineups
      WHERE member_id = '00000000-0000-0000-0000-000000091301'
        AND game_date = '2099-01-02'
     EXCEPT
     SELECT player_id, slot_type, is_auto_set, week_number, game_date
       FROM first_lineup_state)
  ) THEN
    RAISE EXCEPTION 'Repeated auto-set did not converge to the same lineup state.';
  END IF;
END;
$$;

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.auto_set_lineup_service_atomic(
      '00000000-0000-0000-0000-000000091301',
      '00000000-0000-0000-0000-000000091201',
      '00000000-0000-0000-0000-000000091401',
      '2099-01-02',
      '[]'::jsonb
    );
    RAISE EXCEPTION 'authenticated unexpectedly executed the service optimizer RPC';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
RESET ROLE;
ROLLBACK;
