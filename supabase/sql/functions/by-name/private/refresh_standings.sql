CREATE OR REPLACE FUNCTION private.refresh_standings(p_league_id uuid, p_season_id uuid, p_version bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM private.screen_refresh_queue WHERE league_id = p_league_id AND league_season_id = p_season_id AND version = p_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.standings_current AS cached(league_id, league_season_id, member_id, team_name, wins, losses, ties, points_for, points_against, max_points_for, version)
  SELECT p_league_id, p_season_id, member.id, COALESCE(member.team_name, 'Team'),
    count(matchup.id) FILTER (WHERE matchup.winner_member_id = member.id),
    count(matchup.id) FILTER (WHERE matchup.winner_member_id IS NOT NULL AND matchup.winner_member_id <> member.id),
    count(matchup.id) FILTER (WHERE matchup.winner_member_id IS NULL),
    COALESCE(sum(CASE WHEN matchup.home_member_id = member.id THEN matchup.home_points ELSE matchup.away_points END), 0),
    COALESCE(sum(CASE WHEN matchup.home_member_id = member.id THEN matchup.away_points ELSE matchup.home_points END), 0),
    COALESCE(sum(CASE WHEN matchup.home_member_id = member.id THEN matchup.home_max_possible_points ELSE matchup.away_max_possible_points END), 0), p_version
  FROM public.league_members member
  LEFT JOIN public.matchups matchup ON matchup.league_id = p_league_id AND matchup.league_season_id = p_season_id
    AND member.id IN (matchup.home_member_id, matchup.away_member_id)
    AND matchup.is_finalized AND NOT matchup.is_voided AND matchup.matchup_type = 'regular_season'
  WHERE member.league_id = p_league_id GROUP BY member.id
  ON CONFLICT (league_season_id, member_id) DO UPDATE SET team_name = EXCLUDED.team_name,
    wins = EXCLUDED.wins, losses = EXCLUDED.losses, ties = EXCLUDED.ties,
    points_for = EXCLUDED.points_for, points_against = EXCLUDED.points_against, max_points_for = EXCLUDED.max_points_for,
    version = EXCLUDED.version, refreshed_at = now() WHERE cached.version < EXCLUDED.version
      AND (md5((to_jsonb(cached)-ARRAY['version','refreshed_at'])::text)
        IS DISTINCT FROM md5((to_jsonb(EXCLUDED)-ARRAY['version','refreshed_at'])::text)
        OR (to_jsonb(cached)-ARRAY['version','refreshed_at'])
          IS DISTINCT FROM (to_jsonb(EXCLUDED)-ARRAY['version','refreshed_at']));
  RETURN true;
END;
$$;
