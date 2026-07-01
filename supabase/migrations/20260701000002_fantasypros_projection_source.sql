-- FantasyPros projection source:
-- - Raw/auditable source runs and rows.
-- - League-scored projection read RPC with source precedence.
-- - Player search projection columns.
-- - Backend-only cron schedule for projection refreshes.

CREATE TABLE IF NOT EXISTS public.projection_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'fantasypros',
  projection_type text NOT NULL CHECK (projection_type IN ('daily', 'weekly_avg', 'weekly_total', 'internal')),
  source_url text NOT NULL,
  season_year int,
  week_number int,
  projection_date date,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed', 'skipped')),
  http_status int,
  row_count int NOT NULL DEFAULT 0,
  matched_count int NOT NULL DEFAULT 0,
  unmatched_count int NOT NULL DEFAULT 0,
  parser_version text NOT NULL DEFAULT 'fantasypros-html-v1',
  error_message text,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projection_sync_runs_source_public_html CHECK (
    source <> 'fantasypros'
    OR (
      source_url ~ '^https://www\.fantasypros\.com/nba/projections/[A-Za-z0-9_-]+\.php$'
      AND source_url !~ '/(api|json|xml|ajax)/'
    )
  )
);

CREATE TABLE IF NOT EXISTS public.fantasypros_projection_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.projection_sync_runs(id) ON DELETE CASCADE,
  projection_type text NOT NULL CHECK (projection_type IN ('daily', 'weekly_avg', 'weekly_total')),
  source_url text NOT NULL,
  source_row_number int NOT NULL,
  season_year int,
  week_number int,
  projection_date date,
  fetched_at timestamptz NOT NULL,
  source_player_name text NOT NULL,
  normalized_player_name text NOT NULL,
  source_team text,
  source_positions text[] NOT NULL DEFAULT '{}'::text[],
  source_status text,
  source_opponent text,
  player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  match_status text NOT NULL CHECK (match_status IN ('matched', 'unmatched', 'ambiguous')),
  match_reason text,
  points numeric(8,2),
  rebounds numeric(8,2),
  assists numeric(8,2),
  steals numeric(8,2),
  blocks numeric(8,2),
  three_pointers_made numeric(8,2),
  turnovers numeric(8,2),
  minutes numeric(6,2),
  games_played int,
  field_goal_pct numeric(7,4),
  free_throw_pct numeric(7,4),
  raw_player_cell text,
  raw_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, source_row_number),
  CONSTRAINT fantasypros_projection_rows_source_public_html CHECK (
    source_url ~ '^https://www\.fantasypros\.com/nba/projections/[A-Za-z0-9_-]+\.php$'
    AND source_url !~ '/(api|json|xml|ajax)/'
  )
);

CREATE INDEX IF NOT EXISTS idx_projection_sync_runs_source_type_started
  ON public.projection_sync_runs (source, projection_type, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_projection_sync_runs_status
  ON public.projection_sync_runs (status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_fantasypros_projection_rows_daily_read
  ON public.fantasypros_projection_rows (projection_date, player_id, fetched_at DESC)
  WHERE projection_type = 'daily' AND player_id IS NOT NULL AND match_status = 'matched';

CREATE INDEX IF NOT EXISTS idx_fantasypros_projection_rows_weekly_read
  ON public.fantasypros_projection_rows (season_year, week_number, projection_type, player_id, fetched_at DESC)
  WHERE projection_type IN ('weekly_avg', 'weekly_total') AND player_id IS NOT NULL AND match_status = 'matched';

CREATE INDEX IF NOT EXISTS idx_fantasypros_projection_rows_unmatched
  ON public.fantasypros_projection_rows (projection_type, fetched_at DESC, normalized_player_name)
  WHERE player_id IS NULL OR match_status <> 'matched';

CREATE INDEX IF NOT EXISTS idx_player_projections_week_read
  ON public.player_projections (season_year, week_number, player_id, fetched_at DESC);

ALTER TABLE public.player_projections
  ADD COLUMN IF NOT EXISTS projected_stat_points numeric(8,2),
  ADD COLUMN IF NOT EXISTS projected_rebounds numeric(8,2),
  ADD COLUMN IF NOT EXISTS projected_assists numeric(8,2),
  ADD COLUMN IF NOT EXISTS projected_steals numeric(8,2),
  ADD COLUMN IF NOT EXISTS projected_blocks numeric(8,2),
  ADD COLUMN IF NOT EXISTS projected_three_pointers_made numeric(8,2),
  ADD COLUMN IF NOT EXISTS projected_turnovers numeric(8,2),
  ADD COLUMN IF NOT EXISTS projected_field_goals_made numeric(8,2),
  ADD COLUMN IF NOT EXISTS projected_field_goals_attempted numeric(8,2),
  ADD COLUMN IF NOT EXISTS projected_free_throws_made numeric(8,2),
  ADD COLUMN IF NOT EXISTS projected_free_throws_attempted numeric(8,2),
  ADD COLUMN IF NOT EXISTS projected_double_doubles numeric(8,2),
  ADD COLUMN IF NOT EXISTS projected_triple_doubles numeric(8,2);

ALTER TABLE public.projection_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fantasypros_projection_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS projection_sync_runs_select_authenticated ON public.projection_sync_runs;
CREATE POLICY projection_sync_runs_select_authenticated ON public.projection_sync_runs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS fantasypros_projection_rows_select_authenticated ON public.fantasypros_projection_rows;
CREATE POLICY fantasypros_projection_rows_select_authenticated ON public.fantasypros_projection_rows
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.projection_sync_runs FROM anon, authenticated;
REVOKE ALL ON public.fantasypros_projection_rows FROM anon, authenticated;
GRANT SELECT ON public.projection_sync_runs TO authenticated;
GRANT SELECT ON public.fantasypros_projection_rows TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projection_sync_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fantasypros_projection_rows TO service_role;

CREATE OR REPLACE FUNCTION public.projection_stat_fantasy_points(
  p_points numeric,
  p_rebounds numeric,
  p_assists numeric,
  p_steals numeric,
  p_blocks numeric,
  p_three_pointers_made numeric,
  p_turnovers numeric,
  p_field_goals_made numeric,
  p_field_goals_attempted numeric,
  p_free_throws_made numeric,
  p_free_throws_attempted numeric,
  p_double_doubles numeric,
  p_triple_doubles numeric,
  p_scoring_settings jsonb
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  WITH category_counts AS (
    SELECT (
      (COALESCE(p_points, 0) >= 10)::int +
      (COALESCE(p_rebounds, 0) >= 10)::int +
      (COALESCE(p_assists, 0) >= 10)::int +
      (COALESCE(p_steals, 0) >= 10)::int +
      (COALESCE(p_blocks, 0) >= 10)::int
    ) AS ten_plus_categories
  )
  SELECT ROUND((
    COALESCE(p_points, 0)              * COALESCE((p_scoring_settings->>'points')::numeric, 0) +
    COALESCE(p_rebounds, 0)            * COALESCE((p_scoring_settings->>'rebounds')::numeric, 0) +
    COALESCE(p_assists, 0)             * COALESCE((p_scoring_settings->>'assists')::numeric, 0) +
    COALESCE(p_steals, 0)              * COALESCE((p_scoring_settings->>'steals')::numeric, 0) +
    COALESCE(p_blocks, 0)              * COALESCE((p_scoring_settings->>'blocks')::numeric, 0) +
    COALESCE(p_three_pointers_made, 0) * COALESCE((p_scoring_settings->>'three_pointers_made')::numeric, 0) +
    COALESCE(p_turnovers, 0)           * COALESCE((p_scoring_settings->>'turnovers')::numeric, 0) +
    COALESCE(p_field_goals_made, 0)    * COALESCE((p_scoring_settings->>'field_goals_made')::numeric, 0) +
    COALESCE(p_field_goals_attempted, 0) * COALESCE((p_scoring_settings->>'field_goals_attempted')::numeric, 0) +
    COALESCE(p_free_throws_made, 0)    * COALESCE((p_scoring_settings->>'free_throws_made')::numeric, 0) +
    COALESCE(p_free_throws_attempted, 0) * COALESCE((p_scoring_settings->>'free_throws_attempted')::numeric, 0) +
    COALESCE(p_double_doubles, CASE WHEN ten_plus_categories >= 2 THEN 1 ELSE 0 END) *
      COALESCE((p_scoring_settings->>'double_double')::numeric, 0) +
    COALESCE(p_triple_doubles, CASE WHEN ten_plus_categories >= 3 THEN 1 ELSE 0 END) *
      COALESCE((p_scoring_settings->>'triple_double')::numeric, 0)
  ), 2)
  FROM category_counts;
$$;

GRANT EXECUTE ON FUNCTION public.projection_stat_fantasy_points(numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, jsonb)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_league_projection_rows(
  p_league_id uuid,
  p_season_year int DEFAULT public.current_season_year_et(),
  p_game_date date DEFAULT (timezone('America/New_York', now()))::date,
  p_view text DEFAULT 'today',
  p_player_ids uuid[] DEFAULT NULL,
  p_limit int DEFAULT 600,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  player_id uuid,
  display_name text,
  nba_team text,
  "position" text,
  eligible_positions text[],
  injury_status text,
  headshot_url text,
  nba_id text,
  next_game_date date,
  next_game_opponent text,
  next_game_time timestamptz,
  projection_source text,
  projection_source_label text,
  projection_view text,
  projection_fantasy_points numeric,
  projection_minutes numeric,
  projection_points numeric,
  projection_rebounds numeric,
  projection_assists numeric,
  projection_steals numeric,
  projection_blocks numeric,
  projection_three_pointers_made numeric,
  projection_turnovers numeric,
  projection_games_played int,
  projection_field_goal_pct numeric,
  projection_free_throw_pct numeric,
  projection_status text,
  projection_fetched_at timestamptz,
  projection_date date,
  projection_week_number int,
  projection_is_fresh boolean
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
WITH args AS (
  SELECT
    CASE WHEN p_view IN ('today', 'week_avg', 'week_total') THEN p_view ELSE 'today' END AS view_name,
    COALESCE(p_game_date, (timezone('America/New_York', now()))::date) AS game_date,
    LEAST(GREATEST(COALESCE(p_limit, 600), 1), 1000) AS page_limit,
    GREATEST(COALESCE(p_offset, 0), 0) AS page_offset
),
league AS (
  SELECT
    id,
    scoring_settings,
    (
      COALESCE((scoring_settings->>'field_goals_made')::numeric, 0) <> 0 OR
      COALESCE((scoring_settings->>'field_goals_attempted')::numeric, 0) <> 0 OR
      COALESCE((scoring_settings->>'free_throws_made')::numeric, 0) <> 0 OR
      COALESCE((scoring_settings->>'free_throws_attempted')::numeric, 0) <> 0
    ) AS uses_fantasypros_unsupported_scoring
  FROM public.leagues
  WHERE id = p_league_id
),
week_ctx AS (
  SELECT sw.week_number
  FROM args
  JOIN public.season_weeks sw
    ON sw.season_year = p_season_year
   AND sw.week_start <= args.game_date
   AND sw.week_end >= args.game_date
  LIMIT 1
),
base_players AS (
  SELECT
    p.id,
    COALESCE(p.display_name, concat_ws(' ', p.first_name, p.last_name)) AS display_name,
    p.nba_team,
    p.position::text AS "position",
    ARRAY(SELECT pos::text FROM unnest(p.eligible_positions) AS pos) AS eligible_positions,
    p.injury_status,
    p.headshot_url,
    p.nba_id
  FROM public.players p
  WHERE p_player_ids IS NULL OR p.id = ANY(p_player_ids)
),
next_games AS (
  SELECT
    bp.id AS player_id,
    g.game_date AS next_game_date,
    CASE
      WHEN g.home_team = bp.nba_team THEN 'vs ' || COALESCE(g.away_team, '?')
      WHEN g.away_team = bp.nba_team THEN '@ ' || COALESCE(g.home_team, '?')
      ELSE NULL
    END AS next_game_opponent,
    g.game_time AS next_game_time
  FROM base_players bp
  LEFT JOIN LATERAL (
    SELECT ng.game_date, ng.home_team, ng.away_team, ng.game_time
    FROM args
    JOIN public.nba_games ng
      ON ng.season_year = p_season_year
     AND ng.game_date >= args.game_date
     AND public.is_regular_season_game_id(ng.nba_game_id)
     AND bp.nba_team IS NOT NULL
     AND (ng.home_team = bp.nba_team OR ng.away_team = bp.nba_team)
    ORDER BY ng.game_date ASC, ng.game_time ASC NULLS LAST, ng.id ASC
    LIMIT 1
  ) g ON true
),
week_game_counts AS (
  SELECT
    bp.id AS player_id,
    COUNT(ng.id)::int AS scheduled_games
  FROM base_players bp
  JOIN week_ctx wc ON true
  JOIN public.nba_games ng
    ON ng.season_year = p_season_year
   AND ng.week_number = wc.week_number
   AND public.is_regular_season_game_id(ng.nba_game_id)
   AND bp.nba_team IS NOT NULL
   AND (ng.home_team = bp.nba_team OR ng.away_team = bp.nba_team)
  GROUP BY bp.id
),
latest_daily_run AS (
  SELECT latest_run.id
  FROM args
  JOIN public.projection_sync_runs latest_run
    ON latest_run.source = 'fantasypros'
   AND latest_run.projection_type = 'daily'
   AND latest_run.projection_date = args.game_date
   AND latest_run.status IN ('success', 'failed', 'skipped')
   AND latest_run.completed_at IS NOT NULL
  ORDER BY latest_run.started_at DESC, latest_run.id DESC
  LIMIT 1
),
latest_weekly_avg_run AS (
  SELECT latest_run.id
  FROM args
  LEFT JOIN week_ctx wc ON true
  JOIN public.projection_sync_runs latest_run
    ON latest_run.source = 'fantasypros'
   AND latest_run.projection_type = 'weekly_avg'
   AND latest_run.season_year = p_season_year
   AND (wc.week_number IS NULL OR latest_run.week_number IS NULL OR latest_run.week_number = wc.week_number)
   AND latest_run.status IN ('success', 'failed', 'skipped')
   AND latest_run.completed_at IS NOT NULL
  ORDER BY latest_run.week_number DESC NULLS LAST, latest_run.started_at DESC, latest_run.id DESC
  LIMIT 1
),
latest_weekly_total_run AS (
  SELECT latest_run.id
  FROM args
  LEFT JOIN week_ctx wc ON true
  JOIN public.projection_sync_runs latest_run
    ON latest_run.source = 'fantasypros'
   AND latest_run.projection_type = 'weekly_total'
   AND latest_run.season_year = p_season_year
   AND (wc.week_number IS NULL OR latest_run.week_number IS NULL OR latest_run.week_number = wc.week_number)
   AND latest_run.status IN ('success', 'failed', 'skipped')
   AND latest_run.completed_at IS NOT NULL
  ORDER BY latest_run.week_number DESC NULLS LAST, latest_run.started_at DESC, latest_run.id DESC
  LIMIT 1
),
daily_candidates AS (
  SELECT DISTINCT ON (r.player_id)
    r.player_id,
    'fantasypros_daily'::text AS projection_source,
    'FantasyPros Daily'::text AS projection_source_label,
    'today'::text AS projection_view,
    public.projection_stat_fantasy_points(
      r.points, r.rebounds, r.assists, r.steals, r.blocks, r.three_pointers_made, r.turnovers,
      NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
      l.scoring_settings
    ) AS projection_fantasy_points,
    r.minutes AS projection_minutes,
    r.points AS projection_points,
    r.rebounds AS projection_rebounds,
    r.assists AS projection_assists,
    r.steals AS projection_steals,
    r.blocks AS projection_blocks,
    r.three_pointers_made AS projection_three_pointers_made,
    r.turnovers AS projection_turnovers,
    r.games_played AS projection_games_played,
    r.field_goal_pct AS projection_field_goal_pct,
    r.free_throw_pct AS projection_free_throw_pct,
    r.source_status AS projection_status,
    r.fetched_at AS projection_fetched_at,
    r.projection_date,
    r.week_number AS projection_week_number,
    true AS projection_is_fresh,
    1 AS priority
  FROM args
  JOIN league l ON true
  JOIN public.fantasypros_projection_rows r
    ON r.projection_type = 'daily'
   AND r.match_status = 'matched'
   AND r.player_id IS NOT NULL
   AND r.projection_date = args.game_date
   AND r.fetched_at >= now() - interval '36 hours'
  JOIN latest_daily_run ldr
    ON ldr.id = r.run_id
  JOIN public.projection_sync_runs psr
    ON psr.id = r.run_id
   AND psr.status = 'success'
   AND psr.completed_at IS NOT NULL
  WHERE args.view_name = 'today'
    AND NOT l.uses_fantasypros_unsupported_scoring
  ORDER BY r.player_id, r.fetched_at DESC, r.run_id DESC
),
weekly_avg_candidates AS (
  SELECT DISTINCT ON (r.player_id)
    r.player_id,
    CASE
      WHEN args.view_name = 'week_total' THEN 'fantasypros_weekly_avg_total'
      ELSE 'fantasypros_weekly_avg'
    END::text AS projection_source,
    CASE
      WHEN args.view_name = 'week_total' THEN 'FantasyPros Week Avg x GP'
      ELSE 'FantasyPros Week Avg'
    END::text AS projection_source_label,
    CASE
      WHEN args.view_name = 'week_total' THEN 'week_total'
      ELSE 'week_avg'
    END::text AS projection_view,
    public.projection_stat_fantasy_points(
      r.points * m.games_multiplier,
      r.rebounds * m.games_multiplier,
      r.assists * m.games_multiplier,
      r.steals * m.games_multiplier,
      r.blocks * m.games_multiplier,
      r.three_pointers_made * m.games_multiplier,
      r.turnovers * m.games_multiplier,
      NULL::numeric,
      NULL::numeric,
      NULL::numeric,
      NULL::numeric,
      CASE
        WHEN args.view_name = 'week_total' AND m.games_multiplier > 0 AND (
          (COALESCE(r.points, 0) >= 10)::int +
          (COALESCE(r.rebounds, 0) >= 10)::int +
          (COALESCE(r.assists, 0) >= 10)::int +
          (COALESCE(r.steals, 0) >= 10)::int +
          (COALESCE(r.blocks, 0) >= 10)::int
        ) >= 2 THEN m.games_multiplier
        WHEN args.view_name = 'week_total' THEN 0::numeric
        ELSE NULL::numeric
      END,
      CASE
        WHEN args.view_name = 'week_total' AND m.games_multiplier > 0 AND (
          (COALESCE(r.points, 0) >= 10)::int +
          (COALESCE(r.rebounds, 0) >= 10)::int +
          (COALESCE(r.assists, 0) >= 10)::int +
          (COALESCE(r.steals, 0) >= 10)::int +
          (COALESCE(r.blocks, 0) >= 10)::int
        ) >= 3 THEN m.games_multiplier
        WHEN args.view_name = 'week_total' THEN 0::numeric
        ELSE NULL::numeric
      END,
      l.scoring_settings
    ) AS projection_fantasy_points,
    r.minutes * m.games_multiplier AS projection_minutes,
    r.points * m.games_multiplier AS projection_points,
    r.rebounds * m.games_multiplier AS projection_rebounds,
    r.assists * m.games_multiplier AS projection_assists,
    r.steals * m.games_multiplier AS projection_steals,
    r.blocks * m.games_multiplier AS projection_blocks,
    r.three_pointers_made * m.games_multiplier AS projection_three_pointers_made,
    r.turnovers * m.games_multiplier AS projection_turnovers,
    CASE WHEN args.view_name = 'week_total' THEN m.games_multiplier::int ELSE r.games_played END AS projection_games_played,
    r.field_goal_pct AS projection_field_goal_pct,
    r.free_throw_pct AS projection_free_throw_pct,
    r.source_status AS projection_status,
    r.fetched_at AS projection_fetched_at,
    r.projection_date,
    r.week_number AS projection_week_number,
    true AS projection_is_fresh,
    CASE WHEN args.view_name = 'week_avg' THEN 1 ELSE 2 END AS priority
  FROM args
  JOIN league l ON true
  LEFT JOIN week_ctx wc ON true
  JOIN public.fantasypros_projection_rows r
    ON r.projection_type = 'weekly_avg'
   AND r.match_status = 'matched'
   AND r.player_id IS NOT NULL
   AND r.season_year = p_season_year
   AND (wc.week_number IS NULL OR r.week_number IS NULL OR r.week_number = wc.week_number)
   AND r.fetched_at >= now() - interval '8 days'
  JOIN latest_weekly_avg_run lwar
    ON lwar.id = r.run_id
  JOIN public.projection_sync_runs psr
    ON psr.id = r.run_id
   AND psr.status = 'success'
   AND psr.completed_at IS NOT NULL
  LEFT JOIN week_game_counts wgc
    ON wgc.player_id = r.player_id
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN args.view_name = 'week_total' THEN COALESCE(NULLIF(r.games_played, 0), wgc.scheduled_games, 0)::numeric
      ELSE 1::numeric
    END AS games_multiplier
  ) m
  WHERE args.view_name IN ('today', 'week_avg', 'week_total')
    AND NOT l.uses_fantasypros_unsupported_scoring
  ORDER BY r.player_id, r.week_number DESC NULLS LAST, r.fetched_at DESC, r.run_id DESC
),
weekly_total_candidates AS (
  SELECT DISTINCT ON (r.player_id)
    r.player_id,
    'fantasypros_weekly_total'::text AS projection_source,
    'FantasyPros Week Total'::text AS projection_source_label,
    'week_total'::text AS projection_view,
    public.projection_stat_fantasy_points(
      r.points, r.rebounds, r.assists, r.steals, r.blocks, r.three_pointers_made, r.turnovers,
      NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
      CASE
        WHEN COALESCE(r.games_played, 0) > 0 AND (
          (COALESCE(r.points, 0) / NULLIF(r.games_played, 0) >= 10)::int +
          (COALESCE(r.rebounds, 0) / NULLIF(r.games_played, 0) >= 10)::int +
          (COALESCE(r.assists, 0) / NULLIF(r.games_played, 0) >= 10)::int +
          (COALESCE(r.steals, 0) / NULLIF(r.games_played, 0) >= 10)::int +
          (COALESCE(r.blocks, 0) / NULLIF(r.games_played, 0) >= 10)::int
        ) >= 2 THEN r.games_played::numeric
        ELSE 0
      END,
      CASE
        WHEN COALESCE(r.games_played, 0) > 0 AND (
          (COALESCE(r.points, 0) / NULLIF(r.games_played, 0) >= 10)::int +
          (COALESCE(r.rebounds, 0) / NULLIF(r.games_played, 0) >= 10)::int +
          (COALESCE(r.assists, 0) / NULLIF(r.games_played, 0) >= 10)::int +
          (COALESCE(r.steals, 0) / NULLIF(r.games_played, 0) >= 10)::int +
          (COALESCE(r.blocks, 0) / NULLIF(r.games_played, 0) >= 10)::int
        ) >= 3 THEN r.games_played::numeric
        ELSE 0
      END,
      l.scoring_settings
    ) AS projection_fantasy_points,
    r.minutes AS projection_minutes,
    r.points AS projection_points,
    r.rebounds AS projection_rebounds,
    r.assists AS projection_assists,
    r.steals AS projection_steals,
    r.blocks AS projection_blocks,
    r.three_pointers_made AS projection_three_pointers_made,
    r.turnovers AS projection_turnovers,
    r.games_played AS projection_games_played,
    r.field_goal_pct AS projection_field_goal_pct,
    r.free_throw_pct AS projection_free_throw_pct,
    r.source_status AS projection_status,
    r.fetched_at AS projection_fetched_at,
    r.projection_date,
    r.week_number AS projection_week_number,
    true AS projection_is_fresh,
    1 AS priority
  FROM args
  JOIN league l ON true
  LEFT JOIN week_ctx wc ON true
  JOIN public.fantasypros_projection_rows r
    ON r.projection_type = 'weekly_total'
   AND r.match_status = 'matched'
   AND r.player_id IS NOT NULL
   AND r.season_year = p_season_year
   AND (wc.week_number IS NULL OR r.week_number IS NULL OR r.week_number = wc.week_number)
   AND r.fetched_at >= now() - interval '8 days'
  JOIN latest_weekly_total_run lwtr
    ON lwtr.id = r.run_id
  JOIN public.projection_sync_runs psr
    ON psr.id = r.run_id
   AND psr.status = 'success'
   AND psr.completed_at IS NOT NULL
  WHERE args.view_name = 'week_total'
    AND NOT l.uses_fantasypros_unsupported_scoring
  ORDER BY r.player_id, r.week_number DESC NULLS LAST, r.fetched_at DESC, r.run_id DESC
),
internal_candidates AS (
  SELECT DISTINCT ON (pp.player_id)
    pp.player_id,
    'internal'::text AS projection_source,
    'Internal Projection'::text AS projection_source_label,
    'fallback'::text AS projection_view,
    public.projection_stat_fantasy_points(
      pp.projected_stat_points * m.games_multiplier,
      pp.projected_rebounds * m.games_multiplier,
      pp.projected_assists * m.games_multiplier,
      pp.projected_steals * m.games_multiplier,
      pp.projected_blocks * m.games_multiplier,
      pp.projected_three_pointers_made * m.games_multiplier,
      pp.projected_turnovers * m.games_multiplier,
      pp.projected_field_goals_made * m.games_multiplier,
      pp.projected_field_goals_attempted * m.games_multiplier,
      pp.projected_free_throws_made * m.games_multiplier,
      pp.projected_free_throws_attempted * m.games_multiplier,
      CASE
        WHEN args.view_name = 'week_total' THEN COALESCE(pp.projected_double_doubles, 0) * m.games_multiplier
        ELSE pp.projected_double_doubles
      END,
      CASE
        WHEN args.view_name = 'week_total' THEN COALESCE(pp.projected_triple_doubles, 0) * m.games_multiplier
        ELSE pp.projected_triple_doubles
      END,
      l.scoring_settings
    ) AS projection_fantasy_points,
    pp.projected_minutes * m.games_multiplier AS projection_minutes,
    pp.projected_stat_points * m.games_multiplier AS projection_points,
    pp.projected_rebounds * m.games_multiplier AS projection_rebounds,
    pp.projected_assists * m.games_multiplier AS projection_assists,
    pp.projected_steals * m.games_multiplier AS projection_steals,
    pp.projected_blocks * m.games_multiplier AS projection_blocks,
    pp.projected_three_pointers_made * m.games_multiplier AS projection_three_pointers_made,
    pp.projected_turnovers * m.games_multiplier AS projection_turnovers,
    CASE WHEN args.view_name = 'week_total' THEN m.games_multiplier::int ELSE NULL::int END AS projection_games_played,
    NULL::numeric AS projection_field_goal_pct,
    NULL::numeric AS projection_free_throw_pct,
    NULL::text AS projection_status,
    pp.fetched_at AS projection_fetched_at,
    NULL::date AS projection_date,
    pp.week_number AS projection_week_number,
    true AS projection_is_fresh,
    3 AS priority
  FROM args
  JOIN week_ctx wc ON true
  JOIN league l ON true
  JOIN public.player_projections pp
    ON pp.season_year = p_season_year
   AND pp.week_number = wc.week_number
   AND pp.projected_stat_points IS NOT NULL
  LEFT JOIN week_game_counts wgc
    ON wgc.player_id = pp.player_id
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN args.view_name = 'week_total' THEN COALESCE(wgc.scheduled_games, 0)::numeric
      ELSE 1::numeric
    END AS games_multiplier
  ) m
  ORDER BY pp.player_id, pp.fetched_at DESC
),
season_avg_candidates AS (
  SELECT
    avg.player_id,
    'season_avg'::text AS projection_source,
    'Season Avg'::text AS projection_source_label,
    'fallback'::text AS projection_view,
    public.projection_stat_fantasy_points(
      avg.avg_points * m.games_multiplier,
      avg.avg_rebounds * m.games_multiplier,
      avg.avg_assists * m.games_multiplier,
      avg.avg_steals * m.games_multiplier,
      avg.avg_blocks * m.games_multiplier,
      avg.avg_three_pointers_made * m.games_multiplier,
      avg.avg_turnovers * m.games_multiplier,
      avg.avg_field_goals_made * m.games_multiplier,
      avg.avg_field_goals_attempted * m.games_multiplier,
      avg.avg_free_throws_made * m.games_multiplier,
      avg.avg_free_throws_attempted * m.games_multiplier,
      (CASE WHEN COALESCE(avg.games_played, 0) > 0
        THEN COALESCE(avg.double_doubles, 0)::numeric / avg.games_played
        ELSE 0 END) * m.games_multiplier,
      (CASE WHEN COALESCE(avg.games_played, 0) > 0
        THEN COALESCE(avg.triple_doubles, 0)::numeric / avg.games_played
        ELSE 0 END) * m.games_multiplier,
      l.scoring_settings
    ) AS projection_fantasy_points,
    avg.avg_minutes_played * m.games_multiplier AS projection_minutes,
    avg.avg_points * m.games_multiplier AS projection_points,
    avg.avg_rebounds * m.games_multiplier AS projection_rebounds,
    avg.avg_assists * m.games_multiplier AS projection_assists,
    avg.avg_steals * m.games_multiplier AS projection_steals,
    avg.avg_blocks * m.games_multiplier AS projection_blocks,
    avg.avg_three_pointers_made * m.games_multiplier AS projection_three_pointers_made,
    avg.avg_turnovers * m.games_multiplier AS projection_turnovers,
    CASE WHEN args.view_name = 'week_total' THEN m.games_multiplier::int ELSE avg.games_played::int END AS projection_games_played,
    NULL::numeric AS projection_field_goal_pct,
    NULL::numeric AS projection_free_throw_pct,
    NULL::text AS projection_status,
    NULL::timestamptz AS projection_fetched_at,
    NULL::date AS projection_date,
    NULL::int AS projection_week_number,
    true AS projection_is_fresh,
    4 AS priority
  FROM args
  JOIN league l ON true
  JOIN public.mv_player_season_averages avg
    ON avg.season_year = p_season_year
  LEFT JOIN week_game_counts wgc
    ON wgc.player_id = avg.player_id
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN args.view_name = 'week_total' THEN COALESCE(wgc.scheduled_games, 0)::numeric
      ELSE 1::numeric
    END AS games_multiplier
  ) m
),
candidate_union AS (
  SELECT * FROM daily_candidates
  UNION ALL SELECT * FROM weekly_total_candidates
  UNION ALL SELECT * FROM weekly_avg_candidates
  UNION ALL SELECT * FROM internal_candidates
  UNION ALL SELECT * FROM season_avg_candidates
),
best AS (
  SELECT DISTINCT ON (cu.player_id) cu.*
  FROM candidate_union cu
  ORDER BY cu.player_id, cu.priority ASC, cu.projection_fetched_at DESC NULLS LAST
)
SELECT
  bp.id AS player_id,
  bp.display_name,
  bp.nba_team,
  bp."position",
  bp.eligible_positions,
  bp.injury_status,
  bp.headshot_url,
  bp.nba_id,
  ng.next_game_date,
  ng.next_game_opponent,
  ng.next_game_time,
  b.projection_source,
  b.projection_source_label,
  b.projection_view,
  b.projection_fantasy_points,
  b.projection_minutes,
  b.projection_points,
  b.projection_rebounds,
  b.projection_assists,
  b.projection_steals,
  b.projection_blocks,
  b.projection_three_pointers_made,
  b.projection_turnovers,
  b.projection_games_played,
  b.projection_field_goal_pct,
  b.projection_free_throw_pct,
  b.projection_status,
  b.projection_fetched_at,
  COALESCE(b.projection_date, ng.next_game_date) AS projection_date,
  b.projection_week_number,
  b.projection_is_fresh
FROM args
JOIN base_players bp ON true
LEFT JOIN best b ON b.player_id = bp.id
LEFT JOIN next_games ng ON ng.player_id = bp.id
WHERE b.player_id IS NOT NULL
ORDER BY b.projection_fantasy_points DESC NULLS LAST, bp.display_name ASC, bp.id ASC
LIMIT (SELECT page_limit FROM args)
OFFSET (SELECT page_offset FROM args);
$$;

REVOKE ALL ON FUNCTION public.get_league_projection_rows(uuid, int, date, text, uuid[], int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_league_projection_rows(uuid, int, date, text, uuid[], int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_league_projection_rows(uuid, int, date, text, uuid[], int, int) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.search_players(text, text, text[], uuid, text[], text[], uuid[], uuid[], boolean, text, text, text, int, int, int);

CREATE OR REPLACE FUNCTION public.search_players(
  p_query text DEFAULT '',
  p_position text DEFAULT 'ALL',
  p_teams text[] DEFAULT '{}',
  p_league_id uuid DEFAULT NULL,
  p_playing_teams text[] DEFAULT NULL,
  p_excluded_teams text[] DEFAULT '{}',
  p_include_player_ids uuid[] DEFAULT NULL,
  p_exclude_player_ids uuid[] DEFAULT '{}',
  p_rookies_only boolean DEFAULT false,
  p_health text DEFAULT 'all',
  p_sort_by text DEFAULT 'fpts',
  p_sort_dir text DEFAULT 'desc',
  p_season_year int DEFAULT public.current_season_year_et(),
  p_limit int DEFAULT 60,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  display_name text,
  nba_team text,
  "position" text,
  eligible_positions text[],
  status text,
  injury_status text,
  headshot_url text,
  nba_id text,
  years_exp int,
  avg_fantasy_points numeric,
  avg_points numeric,
  avg_rebounds numeric,
  avg_assists numeric,
  avg_steals numeric,
  avg_blocks numeric,
  avg_turnovers numeric,
  avg_three_pointers_made numeric,
  avg_minutes_played numeric,
  games_played int,
  projection_fantasy_points numeric,
  projection_source text,
  projection_source_label text,
  projection_fetched_at timestamptz,
  projection_date date,
  projection_opponent text,
  projection_minutes numeric,
  projection_points numeric,
  projection_rebounds numeric,
  projection_assists numeric,
  projection_steals numeric,
  projection_blocks numeric,
  projection_three_pointers_made numeric,
  projection_turnovers numeric,
  projection_status text
)
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $$
WITH args AS (
  SELECT
    NULLIF(trim(COALESCE(p_query, '')), '') AS query_text,
    CASE COALESCE(p_position, 'ALL')
      WHEN 'ALL' THEN ARRAY[]::text[]
      WHEN 'G' THEN ARRAY['PG', 'SG']::text[]
      WHEN 'F' THEN ARRAY['SF', 'PF']::text[]
      ELSE ARRAY[p_position]::text[]
    END AS pos_filter,
    CASE
      WHEN p_playing_teams IS NOT NULL AND cardinality(COALESCE(p_teams, '{}')) > 0 THEN
          ARRAY(
            SELECT explicit_team
            FROM unnest(COALESCE(p_teams, '{}')) AS explicit_team
            WHERE explicit_team = ANY(COALESCE(p_playing_teams, '{}'))
            ORDER BY explicit_team
          )
      WHEN p_playing_teams IS NOT NULL THEN COALESCE(p_playing_teams, '{}')
      ELSE COALESCE(p_teams, '{}')
    END AS effective_teams,
    (p_playing_teams IS NOT NULL OR cardinality(COALESCE(p_teams, '{}')) > 0) AS team_filter_active,
    COALESCE(p_excluded_teams, '{}') AS excluded_teams,
    COALESCE(p_exclude_player_ids, '{}') AS exclude_player_ids,
    LEAST(GREATEST(COALESCE(p_limit, 60), 1), 100) AS page_limit,
    GREATEST(COALESCE(p_offset, 0), 0) AS page_offset
),
filtered_base AS (
  SELECT
    p.id,
    COALESCE(p.display_name, concat_ws(' ', p.first_name, p.last_name)) AS display_name,
    p.nba_team,
    p.position::text AS "position",
    ARRAY(SELECT pos::text FROM unnest(p.eligible_positions) AS pos) AS eligible_positions,
    p.status,
    p.injury_status,
    p.headshot_url,
    p.nba_id,
    p.years_exp,
    COALESCE(fp.avg_fantasy_points, avg.avg_points) AS avg_fantasy_points,
    avg.avg_points,
    avg.avg_rebounds,
    avg.avg_assists,
    avg.avg_steals,
    avg.avg_blocks,
    avg.avg_turnovers,
    avg.avg_three_pointers_made,
    avg.avg_minutes_played,
    avg.games_played::int AS games_played
  FROM args
  JOIN public.players AS p ON true
  LEFT JOIN public.mv_player_season_averages AS avg
    ON avg.player_id = p.id
   AND avg.season_year = p_season_year
  LEFT JOIN public.v_player_avg_fantasy_points AS fp
    ON fp.player_id = p.id
   AND fp.season_year = p_season_year
   AND fp.league_id = p_league_id
  WHERE
    (args.query_text IS NULL OR p.display_name ILIKE ('%' || args.query_text || '%'))
    AND (cardinality(args.pos_filter) = 0 OR EXISTS (
      SELECT 1
      FROM unnest(p.eligible_positions) AS player_position
      WHERE player_position::text = ANY(args.pos_filter)
    ))
    AND (NOT args.team_filter_active OR (cardinality(args.effective_teams) > 0 AND p.nba_team = ANY(args.effective_teams)))
    AND (cardinality(args.excluded_teams) = 0 OR p.nba_team IS NULL OR p.nba_team <> ALL(args.excluded_teams))
    AND (p_include_player_ids IS NULL OR p.id = ANY(p_include_player_ids))
    AND (cardinality(args.exclude_player_ids) = 0 OR p.id <> ALL(args.exclude_player_ids))
    AND (NOT p_rookies_only OR p.years_exp = 0)
    AND CASE COALESCE(p_health, 'all')
      WHEN 'healthy' THEN p.injury_status IS NULL
      WHEN 'gtd' THEN p.injury_status = ANY(ARRAY['GTD', 'DTD', 'Questionable', 'Game Time Decision'])
      WHEN 'out' THEN p.injury_status = ANY(ARRAY['Out', 'OUT', 'O'])
      WHEN 'ir' THEN p.injury_status = ANY(ARRAY['IR', 'IR-LTI'])
      ELSE true
    END
),
projection AS (
  SELECT *
  FROM public.get_league_projection_rows(
    p_league_id,
    p_season_year,
    (timezone('America/New_York', now()))::date,
    'today',
    COALESCE((SELECT array_agg(filtered_base.id ORDER BY filtered_base.id) FROM filtered_base), ARRAY[]::uuid[]),
    1000,
    0
  )
  WHERE p_league_id IS NOT NULL
),
filtered AS (
  SELECT
    fb.id,
    fb.display_name,
    fb.nba_team,
    fb."position",
    fb.eligible_positions,
    fb.status,
    fb.injury_status,
    fb.headshot_url,
    fb.nba_id,
    fb.years_exp,
    fb.avg_fantasy_points AS avg_fantasy_points,
    fb.avg_points,
    fb.avg_rebounds,
    fb.avg_assists,
    fb.avg_steals,
    fb.avg_blocks,
    fb.avg_turnovers,
    fb.avg_three_pointers_made,
    fb.avg_minutes_played,
    fb.games_played,
    proj.projection_fantasy_points,
    proj.projection_source,
    proj.projection_source_label,
    proj.projection_fetched_at,
    proj.projection_date,
    proj.next_game_opponent AS projection_opponent,
    proj.projection_minutes,
    proj.projection_points,
    proj.projection_rebounds,
    proj.projection_assists,
    proj.projection_steals,
    proj.projection_blocks,
    proj.projection_three_pointers_made,
    proj.projection_turnovers,
    proj.projection_status
  FROM filtered_base fb
  LEFT JOIN projection AS proj
    ON proj.player_id = fb.id
)
SELECT
  filtered.id,
  filtered.display_name,
  filtered.nba_team,
  filtered."position",
  filtered.eligible_positions,
  filtered.status,
  filtered.injury_status,
  filtered.headshot_url,
  filtered.nba_id,
  filtered.years_exp,
  filtered.avg_fantasy_points,
  filtered.avg_points,
  filtered.avg_rebounds,
  filtered.avg_assists,
  filtered.avg_steals,
  filtered.avg_blocks,
  filtered.avg_turnovers,
  filtered.avg_three_pointers_made,
  filtered.avg_minutes_played,
  filtered.games_played,
  filtered.projection_fantasy_points,
  filtered.projection_source,
  filtered.projection_source_label,
  filtered.projection_fetched_at,
  filtered.projection_date,
  filtered.projection_opponent,
  filtered.projection_minutes,
  filtered.projection_points,
  filtered.projection_rebounds,
  filtered.projection_assists,
  filtered.projection_steals,
  filtered.projection_blocks,
  filtered.projection_three_pointers_made,
  filtered.projection_turnovers,
  filtered.projection_status
FROM filtered
ORDER BY
  CASE WHEN p_sort_by = 'fpts' AND p_sort_dir = 'asc' THEN COALESCE(filtered.avg_fantasy_points, 0) END ASC,
  CASE WHEN p_sort_by = 'fpts' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.avg_fantasy_points, 0) END DESC,
  CASE WHEN p_sort_by = 'pts' AND p_sort_dir = 'asc' THEN COALESCE(filtered.avg_points, 0) END ASC,
  CASE WHEN p_sort_by = 'pts' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.avg_points, 0) END DESC,
  CASE WHEN p_sort_by = 'reb' AND p_sort_dir = 'asc' THEN COALESCE(filtered.avg_rebounds, 0) END ASC,
  CASE WHEN p_sort_by = 'reb' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.avg_rebounds, 0) END DESC,
  CASE WHEN p_sort_by = 'ast' AND p_sort_dir = 'asc' THEN COALESCE(filtered.avg_assists, 0) END ASC,
  CASE WHEN p_sort_by = 'ast' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.avg_assists, 0) END DESC,
  CASE WHEN p_sort_by = 'stl' AND p_sort_dir = 'asc' THEN COALESCE(filtered.avg_steals, 0) END ASC,
  CASE WHEN p_sort_by = 'stl' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.avg_steals, 0) END DESC,
  CASE WHEN p_sort_by = 'blk' AND p_sort_dir = 'asc' THEN COALESCE(filtered.avg_blocks, 0) END ASC,
  CASE WHEN p_sort_by = 'blk' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.avg_blocks, 0) END DESC,
  CASE WHEN p_sort_by = 'tpm' AND p_sort_dir = 'asc' THEN COALESCE(filtered.avg_three_pointers_made, 0) END ASC,
  CASE WHEN p_sort_by = 'tpm' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.avg_three_pointers_made, 0) END DESC,
  CASE WHEN p_sort_by = 'to' AND p_sort_dir = 'asc' THEN COALESCE(filtered.avg_turnovers, 0) END ASC,
  CASE WHEN p_sort_by = 'to' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.avg_turnovers, 0) END DESC,
  CASE WHEN p_sort_by = 'gp' AND p_sort_dir = 'asc' THEN COALESCE(filtered.games_played, 0) END ASC,
  CASE WHEN p_sort_by = 'gp' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.games_played, 0) END DESC,
  filtered.display_name ASC,
  filtered.id ASC
LIMIT (SELECT page_limit FROM args)
OFFSET (SELECT page_offset FROM args);
$$;

REVOKE ALL ON FUNCTION public.search_players(text, text, text[], uuid, text[], text[], uuid[], uuid[], boolean, text, text, text, int, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_players(text, text, text[], uuid, text[], text[], uuid[], uuid[], boolean, text, text, text, int, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.search_players(text, text, text[], uuid, text[], text[], uuid[], uuid[], boolean, text, text, text, int, int, int) TO authenticated;

CREATE OR REPLACE FUNCTION public.invoke_projection_sync_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (timezone('America/New_York', now()))::date;
  v_now_et timestamp := timezone('America/New_York', now());
  v_first_lock timestamptz;
  v_has_games boolean := false;
BEGIN
  SELECT min(game_time), bool_or(true)
    INTO v_first_lock, v_has_games
    FROM public.nba_games
   WHERE game_date = v_today
     AND game_time IS NOT NULL
     AND public.is_regular_season_game_id(nba_game_id);

  -- Backend cron calls this hourly. It invokes the scraper in the morning, then
  -- hourly until the first NBA game locks on scheduled game days. On no-game
  -- days it still refreshes once in the morning so weekly projections stay warm.
  IF EXTRACT(HOUR FROM v_now_et)::int = 8 THEN
    PERFORM public.invoke_edge_function('sync-projections');
  ELSIF v_has_games AND v_first_lock IS NOT NULL AND now() < v_first_lock THEN
    PERFORM public.invoke_edge_function('sync-projections');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_projection_sync_if_due() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_projection_sync_if_due() FROM anon;
REVOKE ALL ON FUNCTION public.invoke_projection_sync_if_due() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_projection_sync_if_due() TO service_role;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('nba-sync-projections') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'nba-sync-projections'
    );

    PERFORM cron.schedule(
      'nba-sync-projections',
      '0 12-23 * * *',
      $$SELECT public.invoke_projection_sync_if_due()$$
    );
  END IF;
END
$cron$;

COMMENT ON TABLE public.projection_sync_runs IS
  'Auditable FantasyPros projection sync runs. Clients can read freshness metadata; only service-role sync writes.';

COMMENT ON TABLE public.fantasypros_projection_rows IS
  'Raw parsed FantasyPros public HTML projection rows, including unmatched rows for review and matched rows for scored app reads.';
