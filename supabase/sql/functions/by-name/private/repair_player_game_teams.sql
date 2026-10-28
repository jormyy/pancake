CREATE OR REPLACE FUNCTION private.repair_player_game_teams(p_player_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed integer;
BEGIN
  UPDATE private.player_game_memberships membership SET nba_team=listing.nba_team
  FROM public.nba_games game, private.player_espn_listings listing
  WHERE game.id=membership.game_id AND listing.player_id=membership.player_id
    AND (p_player_id IS NULL OR membership.player_id=p_player_id)
    AND listing.nba_team IN (game.home_team,game.away_team)
    AND (membership.nba_team IS NULL OR membership.nba_team NOT IN (game.home_team,game.away_team))
    AND game.game_date >= (COALESCE(listing.team_since,listing.listed_at) AT TIME ZONE 'America/New_York')::date
    AND game.game_date <= (listing.listed_at AT TIME ZONE 'America/New_York')::date;
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed;
END;
$$;
