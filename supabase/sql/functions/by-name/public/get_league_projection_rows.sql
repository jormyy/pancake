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
regular_games AS MATERIALIZED (
  SELECT id, game_date, home_team, away_team, game_time, status, started_at
  FROM public.nba_games
  WHERE season_year = p_season_year AND public.is_regular_season_game_id(nba_game_id)
),
upcoming_games AS MATERIALIZED (
  SELECT ng.id, ng.game_date, ng.home_team, ng.away_team, ng.game_time
  FROM args
  JOIN regular_games ng
    ON ng.game_date >= args.game_date
   AND ng.status NOT IN ('InProgress', 'Final')
   AND (ng.game_time IS NULL OR ng.game_time > now())
   AND (ng.started_at IS NULL OR ng.started_at > now())
),
team_next_games AS MATERIALIZED (
  SELECT DISTINCT ON (teams.nba_team) teams.nba_team, g.game_date, g.home_team, g.away_team, g.game_time
  FROM (SELECT DISTINCT nba_team FROM base_players WHERE nba_team IS NOT NULL) teams
  LEFT JOIN (
    SELECT home_team AS nba_team, id, game_date, home_team, away_team, game_time FROM upcoming_games
    UNION ALL
    SELECT away_team, id, game_date, home_team, away_team, game_time FROM upcoming_games
  ) g ON g.nba_team = teams.nba_team
  ORDER BY teams.nba_team, g.game_date ASC, g.game_time ASC NULLS LAST, g.id ASC
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
  ) AS fantasy_points, r.team IS DISTINCT FROM bp.nba_team AS prior_team_game
  FROM public.sleeper_projection_rows r
  JOIN base_players bp ON bp.id = r.player_id
  LEFT JOIN next_games ng ON ng.player_id=bp.id
  JOIN league l ON true
  CROSS JOIN args
  LEFT JOIN week_ctx wc ON true
  WHERE r.season_year = p_season_year
    AND (r.game_date<(now() AT TIME ZONE 'America/New_York')::date OR r.team=bp.nba_team)
    AND EXISTS (SELECT 1 FROM (
      SELECT game_date,home_team AS team,away_team AS opponent FROM regular_games
      UNION ALL SELECT game_date,away_team,home_team FROM regular_games
    ) g WHERE g.game_date=r.game_date AND g.team=r.team AND g.opponent=r.opponent)
    AND (args.view_name = 'today' AND r.game_date = COALESCE(ng.next_game_date,args.game_date)
      OR args.view_name <> 'today' AND r.week_number = wc.week_number)
),
sleeper_totals AS (
  SELECT player_id, count(*)::integer AS games, count(*) FILTER(WHERE prior_team_game)::integer AS prior_team_games,
    sum(fantasy_points) AS fantasy_points,
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
    s.week_number AS projection_week_number, s.fetched_at>=now()-interval '36 hours' AS projection_is_fresh, 0 AS priority
  FROM sleeper_totals s CROSS JOIN args
  LEFT JOIN fallback_best b ON b.player_id=s.player_id
  LEFT JOIN week_game_counts wgc ON wgc.player_id=s.player_id
  CROSS JOIN LATERAL (
    SELECT CASE WHEN args.view_name='today' THEN 0 ELSE GREATEST(COALESCE(wgc.scheduled_games,0)+s.prior_team_games-s.games,0) END AS missing_games
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
