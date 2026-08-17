BEGIN;

DO $$
DECLARE
  v_cron_definition text;
BEGIN
  IF to_regprocedure('public.get_dynasty_decision_inputs(uuid,uuid,integer,uuid[],text,integer,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'Legacy dynasty RPC still exists';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.dynasty_rankings
     WHERE source IN ('hashtagbasketball.com/contend', 'hashtagbasketball.com/rebuild')
  ) THEN
    RAISE EXCEPTION 'Legacy dynasty ranking rows still exist';
  END IF;
  SELECT pg_get_functiondef('public.invoke_dynasty_ranking_views_at_et_time(integer,integer)'::regprocedure)
    INTO v_cron_definition;
  IF v_cron_definition LIKE '%"CONTEND"%'
     OR v_cron_definition LIKE '%"REBUILD"%'
     OR v_cron_definition LIKE '%"POINT"%' THEN
    RAISE EXCEPTION 'Legacy dynasty ranking cron calls still exist';
  END IF;
END $$;

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
VALUES
  (
    '00000000-0000-0000-0000-0000000d1300',
    'dynasty-decision-input-player',
    'Decision',
    'Player',
    'SEA',
    'PG'
  ),
  (
    '00000000-0000-0000-0000-0000000d1301',
    'three-year-only-player',
    'Three Year',
    'Only',
    'SEA',
    'SG'
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

INSERT INTO public.dynasty_rankings (
  source, source_rank, source_player_id, source_player_name, source_team,
  source_positions, player_id, age, rank_change, scoring_format
)
VALUES
  (
    'hashtagbasketball.com/points-3', 9001, 'dynasty-decision-input-player', 'Decision Player', 'SEA',
    ARRAY['PG'], '00000000-0000-0000-0000-0000000d1300', 22.5, 0, 'points'
  ),
  (
    'hashtagbasketball.com/rookie', 9003, 'dynasty-decision-input-player', 'Decision Player', 'SEA',
    ARRAY['PG'], '00000000-0000-0000-0000-0000000d1300', 22.5, 0, 'overall'
  );

DO $$
DECLARE
  v_player_rank int;
BEGIN
  PERFORM public.replace_dynasty_rankings(
    'hashtagbasketball.com/points-3',
    now(),
    jsonb_build_array(jsonb_build_object(
      'source_rank', 9001,
      'source_player_name', 'Decision Player',
      'source_player_id', 'dynasty-decision-input-player',
      'source_team', 'SEA',
      'source_positions', jsonb_build_array('PG'),
      'player_id', '00000000-0000-0000-0000-0000000d1300',
      'age', 22.5,
      'rank_change', 0
    )),
    1,
    'points',
    'https://hashtagbasketball.com/fantasy-basketball-dynasty-rankings',
    '{"selectedRankingType":"POINT","forecastSeasons":3}'::jsonb
  );

  SELECT dynasty_rank INTO v_player_rank
    FROM public.players
   WHERE id = '00000000-0000-0000-0000-0000000d1300';
  IF v_player_rank IS NOT NULL THEN
    RAISE EXCEPTION '3-year view replaced canonical player rank with %', v_player_rank;
  END IF;
END $$;

INSERT INTO public.dynasty_rankings (
  source, source_rank, source_player_id, source_player_name, source_team,
  source_positions, player_id, age, rank_change, scoring_format
)
VALUES (
  'hashtagbasketball.com/points-3', 9000, 'three-year-only-player', 'Three Year Only', 'SEA',
  ARRAY['SG'], '00000000-0000-0000-0000-0000000d1301', 21, 0, 'points'
);

SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d1001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_count int;
  v_started timestamptz;
  v_elapsed interval;
  v_five_year_rank int;
  v_three_year_rank int;
  v_rookie_rank int;
BEGIN
  v_started := clock_timestamp();
  SELECT count(*)
    INTO v_count
    FROM public.get_dynasty_forecast_inputs(
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
  SELECT five_year_rank, three_year_rank, rookie_rank
    INTO v_five_year_rank, v_three_year_rank, v_rookie_rank
    FROM public.get_dynasty_forecast_inputs(
      '00000000-0000-0000-0000-0000000d1100',
      '00000000-0000-0000-0000-0000000d1200',
      2026,
      ARRAY['00000000-0000-0000-0000-0000000d1300'::uuid],
      'Decision',
      20,
      0
    );
  IF (v_five_year_rank, v_three_year_rank, v_rookie_rank) IS DISTINCT FROM (9999, 9001, 9003) THEN
    RAISE EXCEPTION 'Unexpected forecast ranks: %, %, %',
      v_five_year_rank, v_three_year_rank, v_rookie_rank;
  END IF;
  IF v_elapsed >= interval '100 milliseconds' THEN
    RAISE EXCEPTION 'Dynasty input hot query exceeded 100 ms: %', v_elapsed;
  END IF;

  SELECT count(*)
    INTO v_count
    FROM public.get_dynasty_forecast_inputs(
      '00000000-0000-0000-0000-0000000d1100',
      '00000000-0000-0000-0000-0000000d1200',
      2026,
      NULL,
      'Three Year Only',
      20,
      0
    )
   WHERE player_id = '00000000-0000-0000-0000-0000000d1301';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Three-year-only matched player was omitted';
  END IF;
END $$;

SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d1002', true);

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*)
    INTO v_count
    FROM public.get_dynasty_forecast_inputs(
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
  PERFORM public.get_dynasty_forecast_inputs(
    '00000000-0000-0000-0000-0000000d1100',
    '00000000-0000-0000-0000-0000000d1200'
  );
  RAISE EXCEPTION 'Expected anon execution to fail';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
END $$;

ROLLBACK;
