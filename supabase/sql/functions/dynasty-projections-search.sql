-- Canonical SQL source for dynasty projections and search.
-- Edit this file first, then copy changed function statements into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies the latest migration definitions still match.

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
  p_limit int DEFAULT 20,
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
  projection_view text,
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
    LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100) AS page_limit,
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
paged_base AS (
  SELECT *
  FROM (
    SELECT
      filtered_base.*,
      row_number() OVER (
        ORDER BY
          CASE WHEN p_sort_by = 'fpts' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_fantasy_points, 0) END ASC,
          CASE WHEN p_sort_by = 'fpts' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_fantasy_points, 0) END DESC,
          CASE WHEN p_sort_by = 'pts' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_points, 0) END ASC,
          CASE WHEN p_sort_by = 'pts' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_points, 0) END DESC,
          CASE WHEN p_sort_by = 'reb' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_rebounds, 0) END ASC,
          CASE WHEN p_sort_by = 'reb' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_rebounds, 0) END DESC,
          CASE WHEN p_sort_by = 'ast' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_assists, 0) END ASC,
          CASE WHEN p_sort_by = 'ast' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_assists, 0) END DESC,
          CASE WHEN p_sort_by = 'stl' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_steals, 0) END ASC,
          CASE WHEN p_sort_by = 'stl' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_steals, 0) END DESC,
          CASE WHEN p_sort_by = 'blk' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_blocks, 0) END ASC,
          CASE WHEN p_sort_by = 'blk' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_blocks, 0) END DESC,
          CASE WHEN p_sort_by = 'tpm' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_three_pointers_made, 0) END ASC,
          CASE WHEN p_sort_by = 'tpm' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_three_pointers_made, 0) END DESC,
          CASE WHEN p_sort_by = 'to' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_turnovers, 0) END ASC,
          CASE WHEN p_sort_by = 'to' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_turnovers, 0) END DESC,
          CASE WHEN p_sort_by = 'gp' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.games_played, 0) END ASC,
          CASE WHEN p_sort_by = 'gp' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.games_played, 0) END DESC,
          filtered_base.display_name ASC,
          filtered_base.id ASC
      ) AS page_rank
    FROM filtered_base
  ) ranked_base
  ORDER BY page_rank
  LIMIT (SELECT page_limit FROM args)
  OFFSET (SELECT page_offset FROM args)
),
projection AS (
  SELECT *
  FROM public.get_league_projection_rows(
    p_league_id,
    p_season_year,
    (timezone('America/New_York', now()))::date,
    'today',
    COALESCE((SELECT array_agg(paged_base.id ORDER BY paged_base.id) FROM paged_base), ARRAY[]::uuid[]),
    (SELECT page_limit FROM args),
    0
  )
  WHERE p_league_id IS NOT NULL
)
SELECT
  pb.id,
  pb.display_name,
  pb.nba_team,
  pb."position",
  pb.eligible_positions,
  pb.status,
  pb.injury_status,
  pb.headshot_url,
  pb.nba_id,
  pb.years_exp,
  pb.avg_fantasy_points,
  pb.avg_points,
  pb.avg_rebounds,
  pb.avg_assists,
  pb.avg_steals,
  pb.avg_blocks,
  pb.avg_turnovers,
  pb.avg_three_pointers_made,
  pb.avg_minutes_played,
  pb.games_played,
  proj.projection_fantasy_points,
  proj.projection_source,
  proj.projection_source_label,
  proj.projection_view,
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
FROM paged_base pb
LEFT JOIN projection AS proj
  ON proj.player_id = pb.id
ORDER BY pb.page_rank;
$$;

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

CREATE OR REPLACE FUNCTION public.replace_dynasty_rankings(
  p_source text,
  p_fetched_at timestamptz,
  p_rows jsonb,
  p_min_rows int DEFAULT 100,
  p_scoring_format text DEFAULT 'overall',
  p_source_url text DEFAULT NULL,
  p_source_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source text := NULLIF(trim(p_source), '');
  v_scoring_format text := lower(NULLIF(trim(p_scoring_format), ''));
  v_source_url text := NULLIF(trim(p_source_url), '');
  v_payload_count int;
  v_stage_count int;
  v_upserted int;
  v_deleted int;
  v_players_updated int;
  v_players_cleared int;
BEGIN
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'Ranking source is required';
  END IF;

  IF v_scoring_format IS NULL OR v_scoring_format NOT IN ('overall', 'points', 'category', 'custom') THEN
    RAISE EXCEPTION 'Ranking scoring format is invalid: %', p_scoring_format;
  END IF;

  IF p_source_metadata IS NULL OR jsonb_typeof(p_source_metadata) <> 'object' THEN
    RAISE EXCEPTION 'Ranking source metadata must be a JSON object';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Ranking rows must be a JSON array';
  END IF;

  v_payload_count := jsonb_array_length(p_rows);
  IF v_payload_count < GREATEST(COALESCE(p_min_rows, 100), 1) THEN
    RAISE EXCEPTION 'Ranking row count % is below minimum %', v_payload_count, p_min_rows;
  END IF;

  WITH stage AS (
    SELECT
      CASE
        WHEN NULLIF(item ->> 'source_rank', '') ~ '^[0-9]+$' THEN (item ->> 'source_rank')::int
        ELSE NULL
      END AS source_rank,
      NULLIF(trim(item ->> 'source_player_name'), '') AS source_player_name
    FROM jsonb_array_elements(p_rows) AS rows(item)
  )
  SELECT count(*) INTO v_stage_count FROM stage;

  IF v_stage_count <> v_payload_count THEN
    RAISE EXCEPTION 'Staged ranking row count % does not match payload count %', v_stage_count, v_payload_count;
  END IF;

  IF EXISTS (
    WITH stage AS (
      SELECT
        CASE
          WHEN NULLIF(item ->> 'source_rank', '') ~ '^[0-9]+$' THEN (item ->> 'source_rank')::int
          ELSE NULL
        END AS source_rank,
        NULLIF(trim(item ->> 'source_player_name'), '') AS source_player_name
      FROM jsonb_array_elements(p_rows) AS rows(item)
    )
    SELECT 1
    FROM stage
    WHERE source_rank IS NULL OR source_rank <= 0 OR source_player_name IS NULL
  ) THEN
    RAISE EXCEPTION 'Ranking payload contains invalid rank or player name';
  END IF;

  IF EXISTS (
    SELECT (item ->> 'source_rank')::int AS source_rank
    FROM jsonb_array_elements(p_rows) AS rows(item)
    GROUP BY (item ->> 'source_rank')::int
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Ranking payload contains duplicate source ranks';
  END IF;

  WITH stage AS (
    SELECT
      v_source AS source,
      v_scoring_format AS scoring_format,
      v_source_url AS source_url,
      p_source_metadata AS source_metadata,
      (item ->> 'source_rank')::int AS source_rank,
      NULLIF(item ->> 'source_player_id', '') AS source_player_id,
      NULLIF(trim(item ->> 'source_player_name'), '') AS source_player_name,
      NULLIF(item ->> 'source_team', '') AS source_team,
      COALESCE(
        ARRAY(
          SELECT jsonb_array_elements_text(COALESCE(item -> 'source_positions', '[]'::jsonb))
        ),
        '{}'::text[]
      ) AS source_positions,
      NULLIF(item ->> 'player_id', '')::uuid AS player_id,
      NULLIF(item ->> 'age', '')::numeric(4,1) AS age,
      COALESCE(NULLIF(item ->> 'rank_change', '')::int, 0) AS rank_change,
      NULLIF(item ->> 'games_played', '')::int AS games_played,
      NULLIF(item ->> 'field_goal_pct', '')::numeric(5,3) AS field_goal_pct,
      NULLIF(item ->> 'free_throw_pct', '')::numeric(5,3) AS free_throw_pct,
      NULLIF(item ->> 'three_pointers_made', '')::numeric(5,1) AS three_pointers_made,
      NULLIF(item ->> 'points', '')::numeric(5,1) AS points,
      NULLIF(item ->> 'rebounds', '')::numeric(5,1) AS rebounds,
      NULLIF(item ->> 'assists', '')::numeric(5,1) AS assists,
      NULLIF(item ->> 'steals', '')::numeric(5,1) AS steals,
      NULLIF(item ->> 'blocks', '')::numeric(5,1) AS blocks,
      NULLIF(item ->> 'turnovers', '')::numeric(5,1) AS turnovers,
      NULLIF(item ->> 'comment', '') AS comment,
      p_fetched_at AS fetched_at
    FROM jsonb_array_elements(p_rows) AS rows(item)
  )
  INSERT INTO public.dynasty_rankings (
    source,
    scoring_format,
    source_url,
    source_metadata,
    source_rank,
    source_player_id,
    source_player_name,
    source_team,
    source_positions,
    player_id,
    age,
    rank_change,
    games_played,
    field_goal_pct,
    free_throw_pct,
    three_pointers_made,
    points,
    rebounds,
    assists,
    steals,
    blocks,
    turnovers,
    comment,
    fetched_at,
    updated_at
  )
  SELECT
    source,
    scoring_format,
    source_url,
    source_metadata,
    source_rank,
    source_player_id,
    source_player_name,
    source_team,
    source_positions,
    player_id,
    age,
    rank_change,
    games_played,
    field_goal_pct,
    free_throw_pct,
    three_pointers_made,
    points,
    rebounds,
    assists,
    steals,
    blocks,
    turnovers,
    comment,
    fetched_at,
    now()
  FROM stage
  ON CONFLICT (source, source_rank) DO UPDATE SET
    scoring_format = EXCLUDED.scoring_format,
    source_url = EXCLUDED.source_url,
    source_metadata = EXCLUDED.source_metadata,
    source_player_id = EXCLUDED.source_player_id,
    source_player_name = EXCLUDED.source_player_name,
    source_team = EXCLUDED.source_team,
    source_positions = EXCLUDED.source_positions,
    player_id = EXCLUDED.player_id,
    age = EXCLUDED.age,
    rank_change = EXCLUDED.rank_change,
    games_played = EXCLUDED.games_played,
    field_goal_pct = EXCLUDED.field_goal_pct,
    free_throw_pct = EXCLUDED.free_throw_pct,
    three_pointers_made = EXCLUDED.three_pointers_made,
    points = EXCLUDED.points,
    rebounds = EXCLUDED.rebounds,
    assists = EXCLUDED.assists,
    steals = EXCLUDED.steals,
    blocks = EXCLUDED.blocks,
    turnovers = EXCLUDED.turnovers,
    comment = EXCLUDED.comment,
    fetched_at = EXCLUDED.fetched_at,
    updated_at = now();
  GET DIAGNOSTICS v_upserted = ROW_COUNT;

  WITH stage AS (
    SELECT
      (item ->> 'source_rank')::int AS source_rank
    FROM jsonb_array_elements(p_rows) AS rows(item)
  )
  DELETE FROM public.dynasty_rankings AS ranking
  WHERE ranking.source = v_source
    AND NOT EXISTS (
      SELECT 1
      FROM stage
      WHERE stage.source_rank = ranking.source_rank
    );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  WITH stage AS (
    SELECT
      (item ->> 'source_rank')::int AS source_rank,
      NULLIF(item ->> 'player_id', '')::uuid AS player_id
    FROM jsonb_array_elements(p_rows) AS rows(item)
  ),
  best_rank AS (
    SELECT DISTINCT ON (player_id)
      player_id,
      source_rank
    FROM stage
    WHERE player_id IS NOT NULL
    ORDER BY player_id, source_rank
  )
  UPDATE public.players AS player
     SET dynasty_rank = best_rank.source_rank,
         dynasty_rank_source = v_source,
         dynasty_rank_fetched_at = p_fetched_at
    FROM best_rank
   WHERE player.id = best_rank.player_id;
  GET DIAGNOSTICS v_players_updated = ROW_COUNT;

  WITH stage AS (
    SELECT
      NULLIF(item ->> 'player_id', '')::uuid AS player_id
    FROM jsonb_array_elements(p_rows) AS rows(item)
  )
  UPDATE public.players AS player
     SET dynasty_rank = NULL,
         dynasty_rank_source = NULL,
         dynasty_rank_fetched_at = NULL
   WHERE player.dynasty_rank_source = v_source
     AND NOT EXISTS (
       SELECT 1
       FROM stage
       WHERE stage.player_id = player.id
     );
  GET DIAGNOSTICS v_players_cleared = ROW_COUNT;

  RETURN jsonb_build_object(
    'rows', v_stage_count,
    'scoringFormat', v_scoring_format,
    'sourceUrl', v_source_url,
    'upserted', v_upserted,
    'deleted', v_deleted,
    'playersUpdated', v_players_updated,
    'playersCleared', v_players_cleared
  );
END;
$$;
