-- Canonical SQL source for private.playoff_seed_rankings.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.playoff_seed_rankings(
  p_league_id uuid,
  p_league_season_id uuid,
  p_playoff_start_week int
)
RETURNS TABLE (
  member_id uuid,
  wins bigint,
  points_for numeric,
  max_possible_points numeric,
  points_against numeric,
  tie_token text,
  seed_rank bigint,
  group_start bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH member_stats AS (
    SELECT
      member.id AS member_id,
      count(*) FILTER (WHERE matchup.winner_member_id = member.id) AS wins,
      COALESCE(sum(CASE
        WHEN matchup.home_member_id = member.id THEN matchup.home_points
        WHEN matchup.away_member_id = member.id THEN matchup.away_points
        ELSE 0
      END), 0) AS points_for,
      COALESCE(sum(CASE
        WHEN matchup.home_member_id = member.id THEN matchup.home_max_possible_points
        WHEN matchup.away_member_id = member.id THEN matchup.away_max_possible_points
        ELSE 0
      END), 0) AS max_possible_points,
      COALESCE(sum(CASE
        WHEN matchup.home_member_id = member.id THEN matchup.away_points
        WHEN matchup.away_member_id = member.id THEN matchup.home_points
        ELSE 0
      END), 0) AS points_against,
      encode(extensions.digest((p_league_season_id::text || ':' || member.id::text)::bytea, 'sha256'), 'hex') AS tie_token
    FROM public.league_members AS member
    LEFT JOIN public.matchups AS matchup
      ON matchup.league_season_id = p_league_season_id
     AND matchup.matchup_type = 'regular_season'::public.matchup_type
     AND matchup.week_number < p_playoff_start_week
     AND matchup.is_finalized = true
     AND member.id IN (matchup.home_member_id, matchup.away_member_id)
    WHERE member.league_id = p_league_id
    GROUP BY member.id
  ),
  ranked AS (
    SELECT
      member_stats.*,
      row_number() OVER (
        ORDER BY wins DESC, points_for DESC, max_possible_points DESC, points_against ASC, tie_token ASC, member_id ASC
      ) AS seed_rank
    FROM member_stats
  )
  SELECT
    ranked.*,
    min(seed_rank) OVER (
      PARTITION BY wins, points_for, max_possible_points, points_against
    ) AS group_start
  FROM ranked;
$$;
