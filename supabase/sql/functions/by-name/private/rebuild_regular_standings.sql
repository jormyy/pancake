CREATE OR REPLACE FUNCTION private.rebuild_regular_standings(p_league_id uuid, p_season_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  DELETE FROM standings WHERE league_season_id = p_season_id;
  INSERT INTO standings(league_id, league_season_id, member_id, week_number, wins, losses, ties,
    points_for, points_against, max_possible_points, waiver_priority)
  SELECT p_league_id, p_season_id, member.id, weeks.week_number,
    count(result.id) FILTER (WHERE result.winner_member_id = member.id),
    count(result.id) FILTER (WHERE result.winner_member_id IS NOT NULL AND result.winner_member_id <> member.id),
    count(result.id) FILTER (WHERE result.winner_member_id IS NULL),
    COALESCE(sum(CASE WHEN result.home_member_id = member.id THEN result.home_points ELSE result.away_points END), 0),
    COALESCE(sum(CASE WHEN result.home_member_id = member.id THEN result.away_points ELSE result.home_points END), 0),
    COALESCE(sum(CASE WHEN result.home_member_id = member.id THEN result.home_max_possible_points ELSE result.away_max_possible_points END), 0),
    COALESCE(priority.priority, 0)
  FROM league_members member
  CROSS JOIN (SELECT DISTINCT week_number FROM matchups WHERE league_season_id = p_season_id
    AND matchup_type = 'regular_season' AND is_finalized AND NOT is_voided) weeks
  LEFT JOIN matchups result ON result.league_season_id = p_season_id AND result.matchup_type = 'regular_season'
    AND result.week_number <= weeks.week_number AND result.is_finalized AND NOT result.is_voided
    AND member.id IN (result.home_member_id, result.away_member_id)
  LEFT JOIN waiver_priorities priority ON priority.league_season_id = p_season_id AND priority.member_id = member.id
  WHERE member.league_id = p_league_id
  GROUP BY member.id, weeks.week_number, priority.priority;
END;
$$;
