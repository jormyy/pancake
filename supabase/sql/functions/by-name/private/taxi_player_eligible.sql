CREATE OR REPLACE FUNCTION private.taxi_player_eligible(p_league_id uuid, p_player_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(CASE WHEN league.taxi_rule = 'rookies_or_64_games'
    THEN player.years_exp = 0 OR player.career_regular_season_games < 65
    ELSE player.years_exp = 0 AND player.nba_draft_number IS NOT NULL END, false)
  FROM leagues league CROSS JOIN players player
  WHERE league.id = p_league_id AND player.id = p_player_id;
$$;
