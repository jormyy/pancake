BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES
  (
    '00000000-0000-0000-0000-0000000d1001', 'authenticated', 'authenticated',
    'dynasty-input-a@example.test', 'x', now(), '{}'::jsonb,
    '{"username":"dynasty_input_a","display_name":"Dynasty Input A"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-0000000d1002', 'authenticated', 'authenticated',
    'dynasty-input-b@example.test', 'x', now(), '{}'::jsonb,
    '{"username":"dynasty_input_b","display_name":"Dynasty Input B"}'::jsonb, now(), now()
  );

INSERT INTO public.leagues (id, name, slug, commissioner_id, scoring_settings)
VALUES (
  '00000000-0000-0000-0000-0000000d1100',
  'Dynasty Decision Input Test',
  'dynasty-decision-input-test',
  '00000000-0000-0000-0000-0000000d1001',
  '{"points":1,"rebounds":1.2,"assists":1.5,"turnovers":-1}'::jsonb
);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES (
  '00000000-0000-0000-0000-0000000d1200',
  '00000000-0000-0000-0000-0000000d1100',
  '00000000-0000-0000-0000-0000000d1001',
  'commissioner',
  'Decision Team'
);

INSERT INTO public.players (id, sportsdata_id, first_name, last_name, nba_team, position)
VALUES (
  '00000000-0000-0000-0000-0000000d1300',
  'dynasty-decision-input-player',
  'Decision',
  'Player',
  'SEA',
  'PG'
);

INSERT INTO public.dynasty_rankings (
  source, source_rank, source_player_id, source_player_name, source_team,
  source_positions, player_id, age, rank_change, points, rebounds, assists,
  steals, blocks, turnovers, scoring_format
)
VALUES (
  'hashtagbasketball.com', 9999, 'dynasty-decision-input-player', 'Decision Player', 'SEA',
  ARRAY['PG'], '00000000-0000-0000-0000-0000000d1300', 22.5, 3, 20, 5, 6,
  1, 0.5, 2, 'points'
);

SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d1001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_count int;
  v_started timestamptz;
  v_elapsed interval;
BEGIN
  v_started := clock_timestamp();
  SELECT count(*)
    INTO v_count
    FROM public.get_dynasty_decision_inputs(
      '00000000-0000-0000-0000-0000000d1100',
      '00000000-0000-0000-0000-0000000d1200',
      2026,
      ARRAY['00000000-0000-0000-0000-0000000d1300'::uuid],
      'Decision',
      20,
      0
    );
  v_elapsed := clock_timestamp() - v_started;

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Expected one authorized dynasty input row, got %', v_count;
  END IF;
  IF v_elapsed >= interval '100 milliseconds' THEN
    RAISE EXCEPTION 'Dynasty input hot query exceeded 100 ms: %', v_elapsed;
  END IF;
END $$;

SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d1002', true);

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*)
    INTO v_count
    FROM public.get_dynasty_decision_inputs(
      '00000000-0000-0000-0000-0000000d1100',
      '00000000-0000-0000-0000-0000000d1200',
      2026,
      ARRAY['00000000-0000-0000-0000-0000000d1300'::uuid],
      '',
      20,
      0
    );

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Another user read % private dynasty input rows', v_count;
  END IF;
END $$;

RESET ROLE;
SET LOCAL ROLE anon;

DO $$
BEGIN
  PERFORM public.get_dynasty_decision_inputs(
    '00000000-0000-0000-0000-0000000d1100',
    '00000000-0000-0000-0000-0000000d1200'
  );
  RAISE EXCEPTION 'Expected anon execution to fail';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
END $$;

ROLLBACK;
