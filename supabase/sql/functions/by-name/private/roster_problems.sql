CREATE OR REPLACE FUNCTION private.roster_problems(p_league_id uuid, p_league_season_id uuid, p_member_id uuid)
RETURNS TABLE(kind text, roster_player_id uuid, player_name text, message text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH roster AS (
    SELECT r.*, COALESCE(p.display_name, 'Unknown') AS player_name, p.injury_status,
      p.years_exp, p.career_regular_season_games,
      count(*) FILTER (WHERE NOT r.is_on_ir AND NOT r.is_on_taxi) OVER () AS active_count,
      COALESCE(l.roster_size,20) AS roster_size
    FROM public.roster_players r JOIN public.players p ON p.id=r.player_id
    JOIN public.leagues l ON l.id=r.league_id
    WHERE r.league_id=p_league_id AND r.league_season_id=p_league_season_id AND r.member_id=p_member_id
  )
  SELECT 'ir', id, player_name, player_name || ' is no longer eligible for IR. Activate or drop this player.'
  FROM roster WHERE is_on_ir AND NOT private.is_ir_designation(injury_status)
  UNION ALL
  SELECT 'taxi', id, player_name, player_name || CASE WHEN career_regular_season_games IS NULL
    THEN ': the career games count is not known yet. Activate or drop this taxi player.'
    ELSE ' is no longer taxi-eligible. Activate or drop this player.' END
  FROM roster WHERE is_on_taxi AND NOT private.taxi_player_eligible(p_league_id,player_id)
  UNION ALL
  SELECT 'active_limit', id, player_name, player_name || ': your roster is over the active player limit. Drop or move an eligible player to IR.'
  FROM roster WHERE NOT is_on_ir AND NOT is_on_taxi AND active_count>roster_size;
$$;
