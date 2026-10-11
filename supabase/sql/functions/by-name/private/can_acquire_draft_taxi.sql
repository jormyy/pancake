-- Canonical SQL source for private.can_acquire_draft_taxi.
-- Keep the latest migration definition identical.

CREATE OR REPLACE FUNCTION private.can_acquire_draft_taxi(p_league_id uuid,p_season_id uuid,p_member_id uuid,p_player_id uuid DEFAULT NULL,p_draft_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,private AS $$
  SELECT EXISTS(SELECT 1 FROM leagues l WHERE l.id=p_league_id AND l.taxi_slots >
    (SELECT count(*) FROM roster_players r WHERE r.league_id=p_league_id AND r.league_season_id=p_season_id AND r.member_id=p_member_id AND r.is_on_taxi))
  AND EXISTS(SELECT 1 FROM players p WHERE (p_player_id IS NULL OR p.id=p_player_id)
    AND (p_draft_id IS NULL OR NOT EXISTS(SELECT 1 FROM nominations n WHERE n.draft_id=p_draft_id AND n.player_id=p.id))
    AND p.years_exp=0 AND p.nba_draft_number IS NOT NULL
    AND NOT private.roster_status_game_started(p.id)
    AND NOT EXISTS(SELECT 1 FROM league_player_taxi_exits x WHERE x.league_id=p_league_id AND x.player_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM roster_players r WHERE r.league_id=p_league_id AND r.league_season_id=p_season_id AND r.player_id=p.id));
$$;
