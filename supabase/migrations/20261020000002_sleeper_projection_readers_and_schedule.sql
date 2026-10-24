-- Canonical SQL source for public.get_league_projection_rows.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  SELECT sw.week_number, sw.week_start, sw.week_end
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
team_next_games AS MATERIALIZED (
  SELECT teams.nba_team, g.game_date, g.home_team, g.away_team, g.game_time
  FROM (SELECT DISTINCT nba_team FROM base_players WHERE nba_team IS NOT NULL) teams
  LEFT JOIN LATERAL (
    SELECT ng.game_date, ng.home_team, ng.away_team, ng.game_time
    FROM args
    JOIN public.nba_games ng
      ON ng.season_year = p_season_year
     AND ng.game_date >= args.game_date
     AND public.is_regular_season_game_id(ng.nba_game_id)
     AND (ng.home_team = teams.nba_team OR ng.away_team = teams.nba_team)
    ORDER BY ng.game_date ASC, ng.game_time ASC NULLS LAST, ng.id ASC
    LIMIT 1
  ) g ON true
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
  LEFT JOIN team_next_games g ON g.nba_team = bp.nba_team
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
   AND latest_run.status = 'success'
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
   AND latest_run.status = 'success'
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
   AND latest_run.status = 'success'
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
  JOIN base_players projected_player
    ON projected_player.id = r.player_id
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
  JOIN base_players projected_player
    ON projected_player.id = r.player_id
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
  JOIN base_players projected_player
    ON projected_player.id = r.player_id
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
  JOIN base_players projected_player
    ON projected_player.id = pp.player_id
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
  JOIN base_players projected_player
    ON projected_player.id = avg.player_id
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
fallback_best AS (
  SELECT DISTINCT ON (cu.player_id) cu.*
  FROM candidate_union cu
  ORDER BY cu.player_id, cu.priority ASC, cu.projection_fetched_at DESC NULLS LAST
),
sleeper_games AS (
  SELECT r.*, public.projection_stat_fantasy_points(
    r.points, r.rebounds, r.assists, r.steals, r.blocks, r.three_pointers_made, r.turnovers,
    r.field_goals_made, r.field_goals_attempted, r.free_throws_made, r.free_throws_attempted,
    r.double_doubles, r.triple_doubles, l.scoring_settings
  ) AS fantasy_points
  FROM public.sleeper_projection_rows r
  JOIN base_players bp ON bp.id = r.player_id
  LEFT JOIN next_games ng ON ng.player_id=bp.id
  JOIN league l ON true
  CROSS JOIN args
  LEFT JOIN week_ctx wc ON true
  WHERE r.season_year = p_season_year
    AND (args.view_name = 'today' AND r.game_date = COALESCE(ng.next_game_date,args.game_date)
      OR args.view_name <> 'today' AND r.week_number = wc.week_number
        AND EXISTS (SELECT 1 FROM public.nba_games g WHERE g.season_year=p_season_year
          AND g.game_date=r.game_date AND public.is_regular_season_game_id(g.nba_game_id)
          AND (g.home_team=r.team AND g.away_team=r.opponent OR g.away_team=r.team AND g.home_team=r.opponent)))
),
sleeper_totals AS (
  SELECT player_id, count(*)::integer AS games, sum(fantasy_points) AS fantasy_points,
    sum(points) AS points, sum(rebounds) AS rebounds, sum(assists) AS assists,
    sum(steals) AS steals, sum(blocks) AS blocks, sum(three_pointers_made) AS three_pointers_made,
    sum(turnovers) AS turnovers, sum(minutes) AS minutes,
    100 * sum(field_goals_made) / NULLIF(sum(field_goals_attempted),0) AS field_goal_pct,
    100 * sum(free_throws_made) / NULLIF(sum(free_throws_attempted),0) AS free_throw_pct,
    max(fetched_at) AS fetched_at, min(game_date) AS game_date, min(week_number) AS week_number
  FROM sleeper_games GROUP BY player_id
),
sleeper_candidates AS (
  SELECT s.player_id, 'sleeper'::text AS projection_source, 'Sleeper (RotoWire)'::text AS projection_source_label,
    args.view_name AS projection_view,
    ROUND((s.fantasy_points + COALESCE(b.projection_fantasy_points * m.missing_fraction,0)) / m.divisor,2) AS projection_fantasy_points,
    (s.minutes + COALESCE(b.projection_minutes * m.missing_fraction,0)) / m.divisor AS projection_minutes,
    (s.points + COALESCE(b.projection_points * m.missing_fraction,0)) / m.divisor AS projection_points,
    (s.rebounds + COALESCE(b.projection_rebounds * m.missing_fraction,0)) / m.divisor AS projection_rebounds,
    (s.assists + COALESCE(b.projection_assists * m.missing_fraction,0)) / m.divisor AS projection_assists,
    (s.steals + COALESCE(b.projection_steals * m.missing_fraction,0)) / m.divisor AS projection_steals,
    (s.blocks + COALESCE(b.projection_blocks * m.missing_fraction,0)) / m.divisor AS projection_blocks,
    (s.three_pointers_made + COALESCE(b.projection_three_pointers_made * m.missing_fraction,0)) / m.divisor AS projection_three_pointers_made,
    (s.turnovers + COALESCE(b.projection_turnovers * m.missing_fraction,0)) / m.divisor AS projection_turnovers,
    s.games + CASE WHEN b.player_id IS NOT NULL THEN m.missing_games ELSE 0 END AS projection_games_played,
    (COALESCE(s.field_goal_pct,0)*s.games + COALESCE(b.projection_field_goal_pct,0)*m.missing_games) /
      NULLIF(s.games + CASE WHEN b.projection_field_goal_pct IS NOT NULL THEN m.missing_games ELSE 0 END,0) AS projection_field_goal_pct,
    (COALESCE(s.free_throw_pct,0)*s.games + COALESCE(b.projection_free_throw_pct,0)*m.missing_games) /
      NULLIF(s.games + CASE WHEN b.projection_free_throw_pct IS NOT NULL THEN m.missing_games ELSE 0 END,0) AS projection_free_throw_pct,
    NULL::text AS projection_status, s.fetched_at AS projection_fetched_at,
    CASE WHEN args.view_name='today' THEN s.game_date ELSE NULL::date END AS projection_date,
    s.week_number AS projection_week_number, true AS projection_is_fresh, 0 AS priority
  FROM sleeper_totals s CROSS JOIN args
  LEFT JOIN fallback_best b ON b.player_id=s.player_id
  LEFT JOIN week_game_counts wgc ON wgc.player_id=s.player_id
  CROSS JOIN LATERAL (
    SELECT CASE WHEN args.view_name='today' THEN 0 ELSE GREATEST(COALESCE(wgc.scheduled_games,0)-s.games,0) END AS missing_games
  ) missing
  CROSS JOIN LATERAL (
    SELECT missing.missing_games,
      CASE WHEN args.view_name='week_total' THEN missing.missing_games::numeric / NULLIF(b.projection_games_played,0)
        ELSE missing.missing_games::numeric END AS missing_fraction,
      CASE WHEN args.view_name='week_avg' THEN s.games + CASE WHEN b.player_id IS NOT NULL THEN missing.missing_games ELSE 0 END
        ELSE 1 END::numeric AS divisor
  ) m
),
best AS (
  SELECT * FROM sleeper_candidates
  UNION ALL SELECT b.* FROM fallback_best b WHERE NOT EXISTS(SELECT 1 FROM sleeper_candidates s WHERE s.player_id=b.player_id)
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

CREATE OR REPLACE FUNCTION private.pre_tipoff_input_fingerprint(p_game_date date)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH teams AS MATERIALIZED (
    SELECT s.league_id, s.league_season_id, s.member_id, ls.season_year, l.scoring_settings
    FROM public.lineup_optimizer_settings s
    JOIN public.league_seasons ls ON ls.id = s.league_season_id AND ls.is_current
    JOIN public.leagues l ON l.id = s.league_id AND l.status IN ('active', 'playoffs')
    WHERE s.enabled AND EXISTS (
      SELECT 1 FROM public.nba_games g WHERE g.game_date = p_game_date AND g.season_year = ls.season_year
    )
  ), roster AS MATERIALIZED (
    SELECT rp.league_id, rp.member_id, p.id AS player_id, p.nba_team, p.position,
      p.eligible_positions, p.injury_status, rp.is_on_ir, rp.is_on_taxi
    FROM teams t JOIN public.roster_players rp ON rp.league_id = t.league_id
      AND rp.league_season_id = t.league_season_id AND rp.member_id = t.member_id
    JOIN public.players p ON p.id = rp.player_id
  )
  SELECT md5(jsonb_build_object(
    'teams', (SELECT jsonb_agg(to_jsonb(t) ORDER BY league_id, member_id) FROM teams t),
    'roster', (SELECT jsonb_agg(to_jsonb(r) ORDER BY league_id, member_id, player_id) FROM roster r),
    'slots', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.league_id, s.slot_type)
      FROM public.lineup_slot_templates s WHERE s.league_id IN (SELECT league_id FROM teams)),
    'games', (SELECT jsonb_agg(jsonb_build_array(g.id, g.game_date, g.game_time, g.home_team,
        g.away_team, private.lineup_game_available(g.status, g.game_status_text)) ORDER BY g.id)
      FROM public.nba_games g WHERE g.game_date = p_game_date),
    'projections', (SELECT jsonb_agg(jsonb_build_array(t.league_id,
        to_jsonb(p)-'projection_fetched_at') ORDER BY t.league_id,p.player_id)
      FROM (SELECT DISTINCT league_id,season_year FROM teams) t CROSS JOIN LATERAL public.get_league_projection_rows(t.league_id,t.season_year,
        p_game_date,'today',ARRAY(SELECT DISTINCT r.player_id FROM roster r
          WHERE r.league_id=t.league_id),1000,0) p)
  )::text);
$$;

CREATE OR REPLACE FUNCTION private.projection_sync_due_work(p_now timestamptz DEFAULT now())
RETURNS TABLE(job_key text, period_key text, function_name text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH local_clock AS (
    SELECT p_now AT TIME ZONE 'America/Los_Angeles' AS local_now
  ), clock AS (
    SELECT local_now, local_now::date AS today,
      date_trunc('week',local_now)::date AS monday,
      EXTRACT(HOUR FROM local_now)::integer AS hour,
      EXTRACT(YEAR FROM local_now)::integer + (EXTRACT(MONTH FROM local_now)>=10)::integer AS season_year
    FROM local_clock
  ), calendar AS (
    SELECT clock.*, min(g.game_time) AS first_tipoff
    FROM clock LEFT JOIN public.nba_games g ON g.game_date=clock.today
      AND g.season_year=clock.season_year AND public.is_regular_season_game_id(g.nba_game_id)
    GROUP BY local_now,today,monday,hour,clock.season_year
  )
  SELECT 'pt:sleeper-week',monday::text,'sync-sleeper-projections'
  FROM calendar WHERE EXISTS (SELECT 1 FROM public.season_weeks w WHERE w.season_year=calendar.season_year
    AND date_trunc('week',w.week_start::timestamp)::date=calendar.monday)
  UNION ALL
  SELECT 'pt:sleeper-day',today::text||':'||CASE WHEN hour>=15 THEN '15' WHEN hour>=12 THEN '12' ELSE '08' END,
    'sync-sleeper-projections'
  FROM calendar WHERE hour>=8 AND first_tipoff>p_now
    AND EXISTS (SELECT 1 FROM public.sleeper_projection_rows r WHERE r.game_date>=calendar.monday AND r.game_date<calendar.monday+7)
  UNION ALL
  SELECT 'pt:fantasypros',today::text||':'||CASE WHEN hour>=15 THEN '15' ELSE '08' END,'sync-projections'
  FROM calendar WHERE hour>=8;
$$;

-- Canonical SQL source for public.invoke_projection_sync_if_due.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.invoke_projection_sync_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_work record;
BEGIN
  FOR v_work IN SELECT * FROM private.projection_sync_due_work() LOOP
    IF private.claim_cron_dispatch(v_work.job_key,v_work.period_key) THEN
      PERFORM private.invoke_claimed_edge_function(v_work.job_key,v_work.function_name);
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.emit_league_resource_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows text; v_details text; v_change record;
BEGIN
  IF TG_OP='DELETE' AND TG_TABLE_NAME IN ('projection_sync_runs','fantasypros_projection_rows','sleeper_projection_rows')
    AND current_setting('pancake.projection_cleanup',true)='on' THEN RETURN NULL; END IF;
  IF TG_OP='INSERT' THEN v_rows := 'SELECT * FROM resource_new_rows';
  ELSIF TG_OP='DELETE' THEN v_rows := 'SELECT * FROM resource_old_rows';
  ELSE
    v_rows := $rows$SELECT n.* FROM resource_new_rows n JOIN resource_old_rows o USING(id)
      WHERE (to_jsonb(n)-ARRAY['updated_at','fetched_at','last_modified']) IS DISTINCT FROM (to_jsonb(o)-ARRAY['updated_at','fetched_at','last_modified'])
      UNION ALL SELECT o.* FROM resource_old_rows o JOIN resource_new_rows n USING(id)
      WHERE (to_jsonb(n)-ARRAY['updated_at','fetched_at','last_modified']) IS DISTINCT FROM (to_jsonb(o)-ARRAY['updated_at','fetched_at','last_modified'])$rows$;
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'leagues' THEN
      IF TG_OP='UPDATE' THEN
        v_rows := $rows$SELECT n.* FROM resource_new_rows n JOIN resource_old_rows o USING(id)
          WHERE n.scoring_settings IS DISTINCT FROM o.scoring_settings$rows$;
      END IF;
      v_details := $details$SELECT league.id AS league_id,
        CASE WHEN season.id IS NOT NULL THEN jsonb_build_object('resource','scoring','season_id',season.id) END AS detail
        FROM changed league LEFT JOIN public.league_seasons season ON season.league_id=league.id$details$;
    WHEN 'search_cache_refresh_state' THEN
      v_details := $details$SELECT league.id AS league_id,
        CASE WHEN season.id IS NOT NULL THEN jsonb_build_object('resource','averages','season_id',season.id) END AS detail
        FROM public.leagues league LEFT JOIN public.league_seasons season ON season.league_id=league.id
        WHERE EXISTS (SELECT 1 FROM changed WHERE source_revision IS NOT NULL AND refreshed_at IS NOT NULL)$details$;
    WHEN 'player_projections' THEN
      v_details := $details$SELECT season.league_id,
        jsonb_build_object('resource','projections','season_id',season.id) AS detail
        FROM changed projection JOIN public.league_seasons season ON season.season_year=projection.season_year$details$;
    WHEN 'sleeper_projection_rows' THEN
      v_details := $details$SELECT season.league_id,
        jsonb_build_object('resource','projections','season_id',season.id) AS detail
        FROM changed projection JOIN public.league_seasons season ON season.season_year=projection.season_year
        WHERE projection.game_date>=date_trunc('week',timezone('America/Los_Angeles',now()))::date$details$;
    WHEN 'projection_sync_runs' THEN
      v_details := $details$SELECT season.league_id,
        jsonb_build_object('resource','projections','season_id',season.id) AS detail
        FROM changed run JOIN public.league_seasons season ON run.season_year IS NULL OR season.season_year=run.season_year
        WHERE run.source='fantasypros' AND run.status IN ('success','failed','skipped') AND run.completed_at IS NOT NULL$details$;
    WHEN 'fantasypros_projection_rows' THEN
      v_details := $details$SELECT season.league_id,
        jsonb_build_object('resource','projections','season_id',season.id) AS detail
        FROM changed projection JOIN public.projection_sync_runs run ON run.id=projection.run_id
        JOIN public.league_seasons season ON COALESCE(projection.season_year,run.season_year) IS NULL
          OR season.season_year=COALESCE(projection.season_year,run.season_year)
        WHERE run.status='success' AND run.completed_at IS NOT NULL$details$;
    ELSE RAISE EXCEPTION 'Unsupported league resource source';
  END CASE;
  FOR v_change IN EXECUTE format($query$
    WITH changed AS (%s),details AS (%s),distinct_details AS (
      SELECT DISTINCT details.league_id,details.detail FROM details
      JOIN public.leagues league ON league.id=details.league_id AND league.deleted_at IS NULL
    ) SELECT league_id,CASE WHEN count(*)<=16 AND bool_and(detail IS NOT NULL)
        THEN jsonb_agg(detail ORDER BY detail::text) END AS details
      FROM distinct_details GROUP BY league_id ORDER BY league_id
  $query$,v_rows,v_details) LOOP
    INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details)
      VALUES(v_change.league_id,'resources',1,NULL,v_change.details)
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,
      scopes=NULL,details=EXCLUDED.details,updated_at=clock_timestamp();
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.projection_sync_due_work(timestamptz) FROM PUBLIC, anon, authenticated;
CREATE TRIGGER compact_resource_insert AFTER INSERT ON public.sleeper_projection_rows
  REFERENCING NEW TABLE AS resource_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_resource_change();
CREATE TRIGGER compact_resource_update AFTER UPDATE ON public.sleeper_projection_rows
  REFERENCING NEW TABLE AS resource_new_rows OLD TABLE AS resource_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_resource_change();
CREATE TRIGGER compact_resource_delete AFTER DELETE ON public.sleeper_projection_rows
  REFERENCING OLD TABLE AS resource_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_resource_change();
SELECT cron.schedule('nba-sync-projections','*/15 * * * *','SELECT public.invoke_projection_sync_if_due();');
