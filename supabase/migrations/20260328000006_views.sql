-- ============================================================
-- Migration: Database Views
--
-- 1. mv_player_season_averages  — materialized view; replaces the
--    in-JS per-game averaging in lib/players.ts
-- 2. v_matchup_detail           — regular view; eliminates the N+1
--    member name lookup in lib/scoring.ts
-- 3. v_fantasy_points           — regular view; exposes per-game
--    fantasy point totals under each league's scoring settings
-- ============================================================

-- ── 1. mv_player_season_averages ─────────────────────────────
-- Pre-aggregates per-player per-season averages over player_game_stats.
-- Materialized so repeated frontend queries hit pre-computed data.
--
-- Refreshed daily by pg_cron (see cron job added below).
-- CONCURRENTLY refresh requires a unique index (added below).
--
-- NOTE: materialized views cannot have RLS. This view contains
-- only globally public NBA statistics — no league-private data.

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_player_season_averages AS
SELECT
  player_id,
  season_year,
  COUNT(*)                                       AS games_played,
  ROUND(AVG(points)::numeric,             1)     AS avg_points,
  ROUND(AVG(rebounds)::numeric,           1)     AS avg_rebounds,
  ROUND(AVG(assists)::numeric,            1)     AS avg_assists,
  ROUND(AVG(steals)::numeric,             2)     AS avg_steals,
  ROUND(AVG(blocks)::numeric,             2)     AS avg_blocks,
  ROUND(AVG(turnovers)::numeric,          2)     AS avg_turnovers,
  ROUND(AVG(three_pointers_made)::numeric,2)     AS avg_three_pointers_made,
  ROUND(AVG(field_goals_made)::numeric,   2)     AS avg_field_goals_made,
  ROUND(AVG(field_goals_attempted)::numeric,2)   AS avg_field_goals_attempted,
  ROUND(AVG(free_throws_made)::numeric,   2)     AS avg_free_throws_made,
  ROUND(AVG(free_throws_attempted)::numeric,2)   AS avg_free_throws_attempted,
  ROUND(AVG(minutes_played)::numeric,     1)     AS avg_minutes_played,
  COUNT(*) FILTER (WHERE double_double = true)   AS double_doubles,
  COUNT(*) FILTER (WHERE triple_double = true)   AS triple_doubles
FROM player_game_stats
WHERE NOT did_not_play
GROUP BY player_id, season_year;

-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_player_season_averages
  ON mv_player_season_averages(player_id, season_year);

-- Refresh daily at 8:30 AM ET (12:30 UTC) — after projections sync
SELECT cron.schedule(
  'refresh-player-season-averages',
  '30 12 * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY mv_player_season_averages$$
);

-- Grant read access to the authenticated and anon roles
GRANT SELECT ON mv_player_season_averages TO authenticated, anon;


-- ── 2. v_matchup_detail ───────────────────────────────────────
-- Joins matchups with team names so the frontend avoids a separate
-- league_members lookup after fetching matchup data.
--
-- security_invoker = true: the view uses the calling user's RLS
-- context, so it automatically filters to the user's leagues.

CREATE OR REPLACE VIEW v_matchup_detail
  WITH (security_invoker = true)
AS
SELECT
  m.*,
  hm.team_name AS home_team_name,
  am.team_name AS away_team_name
FROM matchups m
JOIN league_members hm ON hm.id = m.home_member_id
JOIN league_members am ON am.id = m.away_member_id;

GRANT SELECT ON v_matchup_detail TO authenticated;


-- ── 3. v_fantasy_points ───────────────────────────────────────
-- Computes per-game fantasy points for every player under every
-- league's scoring settings via a CROSS JOIN.
--
-- The CROSS JOIN is bounded by the user's leagues (via security_invoker
-- RLS on the `leagues` table), keeping the result set small.
--
-- Usage: .from('v_fantasy_points')
--          .select('fantasy_points')
--          .eq('league_id', leagueId)
--          .eq('player_id', playerId)
--          .eq('week_number', weekNumber)
--
-- security_invoker = true: inherits RLS from player_game_stats and
-- leagues, which ensures only accessible rows are returned.

CREATE OR REPLACE VIEW v_fantasy_points
  WITH (security_invoker = true)
AS
SELECT
  pgs.id           AS stat_id,
  l.id             AS league_id,
  pgs.player_id,
  pgs.game_id,
  pgs.season_year,
  pgs.week_number,
  CASE WHEN pgs.did_not_play THEN 0::numeric ELSE
    COALESCE(pgs.points              * (l.scoring_settings->>'points')::numeric,             0) +
    COALESCE(pgs.rebounds            * (l.scoring_settings->>'rebounds')::numeric,           0) +
    COALESCE(pgs.assists             * (l.scoring_settings->>'assists')::numeric,             0) +
    COALESCE(pgs.steals              * (l.scoring_settings->>'steals')::numeric,              0) +
    COALESCE(pgs.blocks              * (l.scoring_settings->>'blocks')::numeric,              0) +
    COALESCE(pgs.turnovers           * (l.scoring_settings->>'turnovers')::numeric,           0) +
    COALESCE(pgs.three_pointers_made * (l.scoring_settings->>'three_pointers_made')::numeric, 0) +
    CASE WHEN pgs.double_double = true
      THEN COALESCE((l.scoring_settings->>'double_double')::numeric, 0) ELSE 0 END +
    CASE WHEN pgs.triple_double = true
      THEN COALESCE((l.scoring_settings->>'triple_double')::numeric, 0) ELSE 0 END
  END AS fantasy_points
FROM player_game_stats pgs
CROSS JOIN leagues l;

GRANT SELECT ON v_fantasy_points TO authenticated;
