BEGIN;

INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000020001', 'authenticated', 'authenticated', 'fantasypros-projections@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name)
VALUES ('00000000-0000-0000-0000-000000020001', 'fantasypros_projection_user', 'FantasyPros Projection User')
ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, display_name = EXCLUDED.display_name;

INSERT INTO public.leagues (id, name, slug, commissioner_id, status, roster_size, auction_budget, scoring_settings)
VALUES
  (
    '00000000-0000-0000-0000-000000020101',
    'FantasyPros Standard Test',
    'fantasypros-standard-test',
    '00000000-0000-0000-0000-000000020001',
    'active',
    12,
    200,
    '{"points": 1, "rebounds": 1, "assists": 1, "double_double": 1.5, "triple_double": 3}'::jsonb
  ),
  (
    '00000000-0000-0000-0000-000000020102',
    'FantasyPros Unsupported Test',
    'fantasypros-unsupported-test',
    '00000000-0000-0000-0000-000000020001',
    'active',
    12,
    200,
    '{"points": 1, "field_goals_made": 10}'::jsonb
  );

INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES
  ('00000000-0000-0000-0000-000000020201', '00000000-0000-0000-0000-000000020101', 2099, true),
  ('00000000-0000-0000-0000-000000020202', '00000000-0000-0000-0000-000000020102', 2099, true);

INSERT INTO public.players (id, first_name, last_name, nba_team, position, years_exp, nba_id, eligible_positions)
VALUES
  ('00000000-0000-0000-0000-000000020301', 'Projection', 'Leader', 'ATL', 'PG', 3, '209901', ARRAY['PG']),
  ('00000000-0000-0000-0000-000000020302', 'Average', 'Leader', 'BOS', 'SG', 4, '209902', ARRAY['SG']),
  ('00000000-0000-0000-0000-000000020303', 'Season', 'Fallback', 'CHI', 'SF', 5, '209903', ARRAY['SF']);

INSERT INTO public.season_weeks (id, season_year, week_number, week_start, week_end)
VALUES (
  '00000000-0000-0000-0000-000000020401',
  2099,
  1,
  (timezone('America/New_York', now()))::date - 1,
  (timezone('America/New_York', now()))::date + 5
);

INSERT INTO public.nba_games (id, sportsdata_game_id, nba_game_id, season_year, game_date, game_time, week_number, home_team, away_team, status)
VALUES
  ('00000000-0000-0000-0000-000000020501', 'fp-proj-game-1', '0029900001', 2099, (timezone('America/New_York', now()))::date, now() + interval '1 hour', 1, 'ATL', 'BOS', 'Scheduled'),
  ('00000000-0000-0000-0000-000000020502', 'fp-proj-game-2', '0029900002', 2099, (timezone('America/New_York', now()))::date, now() + interval '1 hour', 1, 'CHI', 'DAL', 'Scheduled'),
  ('00000000-0000-0000-0000-000000020503', 'fp-proj-game-3', '0029900003', 2099, (timezone('America/New_York', now()))::date + 1, now() + interval '25 hours', 1, 'ATL', 'NYK', 'Scheduled'),
  ('00000000-0000-0000-0000-000000020504', 'fp-proj-game-4', '0029900004', 2099, (timezone('America/New_York', now()))::date + 2, now() + interval '49 hours', 1, 'MIA', 'CHI', 'Scheduled');

INSERT INTO public.player_game_stats (
  id,
  player_id,
  game_id,
  season_year,
  week_number,
  points,
  rebounds,
  assists,
  steals,
  blocks,
  turnovers,
  three_pointers_made,
  field_goals_made,
  field_goals_attempted,
  free_throws_made,
  free_throws_attempted,
  double_double,
  triple_double,
  did_not_play
)
VALUES
  (
    '00000000-0000-0000-0000-000000020601',
    '00000000-0000-0000-0000-000000020301',
    '00000000-0000-0000-0000-000000020501',
    2099,
    1,
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    4,
    8,
    0,
    0,
    false,
    false,
    false
  ),
  (
    '00000000-0000-0000-0000-000000020602',
    '00000000-0000-0000-0000-000000020302',
    '00000000-0000-0000-0000-000000020501',
    2099,
    1,
    30,
    0,
    0,
    0,
    0,
    0,
    0,
    12,
    20,
    0,
    0,
    false,
    false,
    false
  ),
  (
    '00000000-0000-0000-0000-000000020603',
    '00000000-0000-0000-0000-000000020303',
    '00000000-0000-0000-0000-000000020502',
    2099,
    1,
    15,
    0,
    0,
    0,
    0,
    0,
    0,
    6,
    12,
    0,
    0,
    false,
    false,
    false
  );

REFRESH MATERIALIZED VIEW analytics.mv_player_season_averages;

INSERT INTO public.player_projections (
  id,
  player_id,
  season_year,
  week_number,
  projected_points,
  projected_minutes,
  projected_stat_points,
  projected_rebounds,
  projected_assists,
  projected_steals,
  projected_blocks,
  projected_three_pointers_made,
  projected_turnovers,
  projected_field_goals_made,
  projected_field_goals_attempted,
  projected_free_throws_made,
  projected_free_throws_attempted,
  projected_double_doubles,
  projected_triple_doubles,
  fetched_at
)
VALUES (
  '00000000-0000-0000-0000-000000020701',
  '00000000-0000-0000-0000-000000020301',
  2099,
  1,
  40,
  30,
  40,
  0,
  0,
  0,
  0,
  0,
  0,
  5,
  10,
  0,
  0,
  0,
  0,
  now()
);

INSERT INTO public.projection_sync_runs (
  id,
  source,
  projection_type,
  source_url,
  season_year,
  week_number,
  projection_date,
  completed_at,
  status,
  http_status,
  row_count,
  matched_count,
  unmatched_count
)
VALUES
  (
    '00000000-0000-0000-0000-000000020801',
    'fantasypros',
    'daily',
    'https://www.fantasypros.com/nba/projections/daily-overall.php',
    2099,
    1,
    (timezone('America/New_York', now()))::date,
    now(),
    'success',
    200,
    2,
    2,
    0
  ),
  (
    '00000000-0000-0000-0000-000000020802',
    'fantasypros',
    'daily',
    'https://www.fantasypros.com/nba/projections/daily-overall.php',
    2099,
    1,
    (timezone('America/New_York', now()))::date,
    now(),
    'failed',
    500,
    1,
    1,
    0
  ),
  (
    '00000000-0000-0000-0000-000000020803',
    'fantasypros',
    'weekly_total',
    'https://www.fantasypros.com/nba/projections/weekly-overall.php',
    2099,
    1,
    NULL,
    now(),
    'success',
    200,
    1,
    1,
    0
  ),
  (
    '00000000-0000-0000-0000-000000020804',
    'fantasypros',
    'weekly_avg',
    'https://www.fantasypros.com/nba/projections/avg-weekly-overall.php',
    2099,
    1,
    NULL,
    now(),
    'success',
    200,
    1,
    1,
    0
  );

INSERT INTO public.fantasypros_projection_rows (
  run_id,
  projection_type,
  source_url,
  source_row_number,
  season_year,
  week_number,
  projection_date,
  fetched_at,
  source_player_name,
  normalized_player_name,
  source_team,
  source_positions,
  player_id,
  match_status,
  points,
  rebounds,
  assists,
  steals,
  blocks,
  three_pointers_made,
  turnovers,
  minutes,
  games_played,
  raw_player_cell
)
VALUES
  (
    '00000000-0000-0000-0000-000000020801',
    'daily',
    'https://www.fantasypros.com/nba/projections/daily-overall.php',
    1,
    2099,
    1,
    (timezone('America/New_York', now()))::date,
    now(),
    'Projection Leader',
    'projectionleader',
    'ATL',
    ARRAY['PG'],
    '00000000-0000-0000-0000-000000020301',
    'matched',
    100,
    10,
    10,
    0,
    0,
    0,
    0,
    30,
    NULL,
    'Projection Leader ATL PG'
  ),
  (
    '00000000-0000-0000-0000-000000020801',
    'daily',
    'https://www.fantasypros.com/nba/projections/daily-overall.php',
    2,
    2099,
    1,
    (timezone('America/New_York', now()))::date,
    now(),
    'Average Leader',
    'averageleader',
    'BOS',
    ARRAY['SG'],
    '00000000-0000-0000-0000-000000020302',
    'matched',
    20,
    0,
    0,
    0,
    0,
    0,
    0,
    30,
    NULL,
    'Average Leader BOS SG'
  ),
  (
    '00000000-0000-0000-0000-000000020802',
    'daily',
    'https://www.fantasypros.com/nba/projections/daily-overall.php',
    1,
    2099,
    1,
    (timezone('America/New_York', now()))::date,
    now(),
    'Average Leader',
    'averageleader',
    'BOS',
    ARRAY['SG'],
    '00000000-0000-0000-0000-000000020302',
    'matched',
    999,
    0,
    0,
    0,
    0,
    0,
    0,
    30,
    NULL,
    'Average Leader BOS SG'
  ),
  (
    '00000000-0000-0000-0000-000000020803',
    'weekly_total',
    'https://www.fantasypros.com/nba/projections/weekly-overall.php',
    1,
    2099,
    1,
    NULL,
    now(),
    'Projection Leader',
    'projectionleader',
    'ATL',
    ARRAY['PG'],
    '00000000-0000-0000-0000-000000020301',
    'matched',
    40,
    20,
    0,
    0,
    0,
    0,
    0,
    120,
    4,
    'Projection Leader ATL PG'
  ),
  (
    '00000000-0000-0000-0000-000000020804',
    'weekly_avg',
    'https://www.fantasypros.com/nba/projections/avg-weekly-overall.php',
    1,
    2099,
    1,
    NULL,
    now(),
    'Average Leader',
    'averageleader',
    'BOS',
    ARRAY['SG'],
    '00000000-0000-0000-0000-000000020302',
    'matched',
    20,
    2,
    0,
    0,
    0,
    0,
    0,
    30,
    2,
    'Average Leader BOS SG'
  );

DO $$
DECLARE
  v_row record;
BEGIN
  SELECT *
    INTO v_row
    FROM public.get_league_projection_rows(
      '00000000-0000-0000-0000-000000020101',
      2099,
      (timezone('America/New_York', now()))::date,
      'today',
      ARRAY['00000000-0000-0000-0000-000000020301']::uuid[],
      10,
      0
    );

  IF v_row.projection_source <> 'fantasypros_daily' OR v_row.projection_fantasy_points <> 124.5 THEN
    RAISE EXCEPTION 'Default bonus scoring should prefer successful FantasyPros daily rows, got %', row_to_json(v_row);
  END IF;

  SELECT *
    INTO v_row
    FROM public.get_league_projection_rows(
      '00000000-0000-0000-0000-000000020102',
      2099,
      (timezone('America/New_York', now()))::date,
      'today',
      ARRAY['00000000-0000-0000-0000-000000020301']::uuid[],
      10,
      0
    );

  IF v_row.projection_source <> 'internal' OR v_row.projection_fantasy_points <> 90 THEN
    RAISE EXCEPTION 'Unsupported scoring should fall back from FantasyPros to internal raw-stat projection, got %', row_to_json(v_row);
  END IF;

  SELECT *
    INTO v_row
    FROM public.get_league_projection_rows(
      '00000000-0000-0000-0000-000000020101',
      2099,
      (timezone('America/New_York', now()))::date,
      'today',
      ARRAY['00000000-0000-0000-0000-000000020303']::uuid[],
      10,
      0
    );

  IF v_row.projection_source <> 'season_avg' OR v_row.projection_fantasy_points <> 15 THEN
    RAISE EXCEPTION 'Player without source rows should use season-average fallback, got %', row_to_json(v_row);
  END IF;

  SELECT *
    INTO v_row
    FROM public.get_league_projection_rows(
      '00000000-0000-0000-0000-000000020101',
      2099,
      (timezone('America/New_York', now()))::date,
      'today',
      ARRAY['00000000-0000-0000-0000-000000020302']::uuid[],
      10,
      0
    );

  IF v_row.projection_fantasy_points = 999 THEN
    RAISE EXCEPTION 'Failed FantasyPros sync run row leaked into projection RPC: %', row_to_json(v_row);
  END IF;

  SELECT *
    INTO v_row
    FROM public.get_league_projection_rows(
      '00000000-0000-0000-0000-000000020101',
      2099,
      (timezone('America/New_York', now()))::date,
      'week_total',
      ARRAY['00000000-0000-0000-0000-000000020301']::uuid[],
      10,
      0
    );

  IF v_row.projection_source <> 'fantasypros_weekly_total' OR v_row.projection_fantasy_points <> 60 THEN
    RAISE EXCEPTION 'Weekly total bonus scoring should infer DD/TD from per-game stat rates, got %', row_to_json(v_row);
  END IF;

  SELECT *
    INTO v_row
    FROM public.get_league_projection_rows(
      '00000000-0000-0000-0000-000000020101',
      2099,
      (timezone('America/New_York', now()))::date,
      'week_total',
      ARRAY['00000000-0000-0000-0000-000000020302']::uuid[],
      10,
      0
    );

  IF v_row.projection_source <> 'fantasypros_weekly_avg_total'
     OR v_row.projection_view <> 'week_total'
     OR v_row.projection_games_played <> 2
     OR v_row.projection_points <> 40
     OR v_row.projection_rebounds <> 4
     OR v_row.projection_fantasy_points <> 44 THEN
    RAISE EXCEPTION 'Week-total view should scale FantasyPros weekly-average fallback rows by GP, got %', row_to_json(v_row);
  END IF;

  SELECT *
    INTO v_row
    FROM public.get_league_projection_rows(
      '00000000-0000-0000-0000-000000020102',
      2099,
      (timezone('America/New_York', now()))::date,
      'week_total',
      ARRAY['00000000-0000-0000-0000-000000020301']::uuid[],
      10,
      0
    );

  IF v_row.projection_source <> 'internal'
     OR v_row.projection_games_played <> 2
     OR v_row.projection_points <> 80
     OR v_row.projection_fantasy_points <> 180 THEN
    RAISE EXCEPTION 'Unsupported weekly total fallback should scale internal projections by scheduled games, got %', row_to_json(v_row);
  END IF;

  SELECT *
    INTO v_row
    FROM public.get_league_projection_rows(
      '00000000-0000-0000-0000-000000020102',
      2099,
      (timezone('America/New_York', now()))::date,
      'week_total',
      ARRAY['00000000-0000-0000-0000-000000020303']::uuid[],
      10,
      0
    );

  IF v_row.projection_source <> 'season_avg'
     OR v_row.projection_games_played <> 2
     OR v_row.projection_points <> 30
     OR v_row.projection_fantasy_points <> 150 THEN
    RAISE EXCEPTION 'Unsupported weekly total fallback should scale season averages by scheduled games, got %', row_to_json(v_row);
  END IF;
END $$;

DO $$
DECLARE
  v_first record;
  v_projection_leader record;
  v_average_leader record;
BEGIN
  SELECT *
    INTO v_first
    FROM public.search_players(
      '',
      'ALL',
      ARRAY[]::text[],
      '00000000-0000-0000-0000-000000020101',
      NULL,
      ARRAY[]::text[],
      ARRAY[
        '00000000-0000-0000-0000-000000020301',
        '00000000-0000-0000-0000-000000020302'
      ]::uuid[],
      ARRAY[]::uuid[],
      false,
      'all',
      'fpts',
      'desc',
      2099,
      10,
      0
    )
   LIMIT 1;

  IF v_first.id <> '00000000-0000-0000-0000-000000020302' THEN
    RAISE EXCEPTION 'fpts sort should use season-average fantasy points, not projection points, got %', row_to_json(v_first);
  END IF;

  SELECT *
    INTO v_projection_leader
    FROM public.search_players(
      '',
      'ALL',
      ARRAY[]::text[],
      '00000000-0000-0000-0000-000000020101',
      NULL,
      ARRAY[]::text[],
      ARRAY['00000000-0000-0000-0000-000000020301']::uuid[],
      ARRAY[]::uuid[],
      false,
      'all',
      'fpts',
      'desc',
      2099,
      10,
      0
    );

  IF v_projection_leader.avg_fantasy_points <> 10 OR v_projection_leader.projection_fantasy_points <> 124.5 THEN
    RAISE EXCEPTION 'search_players mixed average and projection fields for projection leader: %', row_to_json(v_projection_leader);
  END IF;

  SELECT *
    INTO v_average_leader
    FROM public.search_players(
      '',
      'ALL',
      ARRAY[]::text[],
      '00000000-0000-0000-0000-000000020101',
      NULL,
      ARRAY[]::text[],
      ARRAY['00000000-0000-0000-0000-000000020302']::uuid[],
      ARRAY[]::uuid[],
      false,
      'all',
      'fpts',
      'desc',
      2099,
      10,
      0
    );

  IF v_average_leader.avg_fantasy_points <> 30 OR v_average_leader.projection_fantasy_points <> 20 THEN
    RAISE EXCEPTION 'search_players mixed average and projection fields for average leader: %', row_to_json(v_average_leader);
  END IF;
END $$;

ROLLBACK;
