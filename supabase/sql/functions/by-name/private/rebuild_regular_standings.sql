-- Canonical SQL source for private.rebuild_regular_standings.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.rebuild_regular_standings(p_league_id uuid, p_season_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  INSERT INTO standings(league_id, league_season_id, member_id, week_number, wins, losses, ties,
    points_for, points_against, max_possible_points)
  SELECT p_league_id, p_season_id, member.id, weeks.week_number,
    count(result.id) FILTER (WHERE result.winner_member_id = member.id),
    count(result.id) FILTER (WHERE result.winner_member_id IS NOT NULL AND result.winner_member_id <> member.id),
    count(result.id) FILTER (WHERE result.winner_member_id IS NULL),
    COALESCE(sum(CASE WHEN result.home_member_id = member.id THEN result.home_points ELSE result.away_points END), 0),
    COALESCE(sum(CASE WHEN result.home_member_id = member.id THEN result.away_points ELSE result.home_points END), 0),
    COALESCE(sum(CASE WHEN result.home_member_id = member.id THEN result.home_max_possible_points ELSE result.away_max_possible_points END), 0)
  FROM league_members member
  CROSS JOIN (SELECT DISTINCT matchup.week_number FROM matchups matchup WHERE matchup.league_season_id = p_season_id
    AND matchup.matchup_type = 'regular_season' AND ((matchup.is_finalized AND NOT matchup.is_voided)
      OR EXISTS (SELECT 1 FROM standings saved WHERE saved.league_season_id = p_season_id
        AND saved.week_number = matchup.week_number))) weeks
  LEFT JOIN matchups result ON result.league_season_id = p_season_id AND result.matchup_type = 'regular_season'
    AND result.week_number <= weeks.week_number AND result.is_finalized AND NOT result.is_voided
    AND member.id IN (result.home_member_id, result.away_member_id)
  WHERE member.league_id = p_league_id
  GROUP BY member.id, weeks.week_number
  ON CONFLICT (league_id, league_season_id, member_id, week_number) DO UPDATE SET
    wins = EXCLUDED.wins,
    losses = EXCLUDED.losses,
    ties = EXCLUDED.ties,
    points_for = EXCLUDED.points_for,
    points_against = EXCLUDED.points_against,
    max_possible_points = EXCLUDED.max_possible_points
  WHERE (standings.wins, standings.losses, standings.ties, standings.points_for, standings.points_against,
    standings.max_possible_points) IS DISTINCT FROM
    (EXCLUDED.wins, EXCLUDED.losses, EXCLUDED.ties, EXCLUDED.points_for, EXCLUDED.points_against,
      EXCLUDED.max_possible_points);
END;
$$;
