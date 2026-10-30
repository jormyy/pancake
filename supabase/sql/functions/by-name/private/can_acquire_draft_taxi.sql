-- Canonical SQL source for private.can_acquire_draft_taxi.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.can_acquire_draft_taxi(p_league_id uuid,p_season_id uuid,p_member_id uuid,p_player_id uuid DEFAULT NULL,p_draft_id uuid DEFAULT NULL,p_roster_player_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,private AS $$
  SELECT EXISTS(SELECT 1 FROM leagues l WHERE l.id=p_league_id AND l.taxi_slots >
    (SELECT count(*) FROM roster_players r WHERE r.league_id=p_league_id AND r.league_season_id=p_season_id AND r.member_id=p_member_id AND r.is_on_taxi))
  AND EXISTS(SELECT 1 FROM players p WHERE (p_player_id IS NULL OR p.id=p_player_id)
    AND (p_draft_id IS NULL OR NOT EXISTS(SELECT 1 FROM nominations n WHERE n.draft_id=p_draft_id AND n.player_id=p.id))
    AND private.taxi_player_eligible(p_league_id,p.id)
    AND NOT EXISTS (SELECT 1 FROM leagues league JOIN league_seasons season ON season.id=p_season_id
      WHERE league.id=p_league_id AND league.taxi_max_seasons IS NOT NULL
        AND season.season_year-private.taxi_start_year(p_league_id,p.id,season.season_year)>=league.taxi_max_seasons)
    AND NOT private.roster_status_game_started(p.id)
    AND NOT EXISTS(SELECT 1 FROM league_member_taxi_exits x WHERE x.league_id=p_league_id AND x.member_id=p_member_id AND x.player_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM roster_players r WHERE r.league_id=p_league_id AND r.league_season_id=p_season_id AND r.player_id=p.id
      AND (r.id IS DISTINCT FROM p_roster_player_id OR r.member_id<>p_member_id OR r.acquired_via<>'draft'
        OR NOT EXISTS(SELECT 1 FROM snake_draft_picks pick WHERE pick.draft_id=p_draft_id
          AND pick.member_id=p_member_id AND pick.player_id=p.id))));
$$;
