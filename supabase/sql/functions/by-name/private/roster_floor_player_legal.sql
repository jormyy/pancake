-- Canonical SQL source for private.roster_floor_player_legal.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.roster_floor_player_legal(
  p_league_id uuid,
  p_league_season_id uuid,
  p_player_id uuid
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.players player
      JOIN public.league_seasons season
        ON season.id = p_league_season_id
       AND season.league_id = p_league_id
      JOIN public.leagues league
        ON league.id = p_league_id
     WHERE player.id = p_player_id
       AND player.nba_team IS NOT NULL
       AND player.injury_status IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.roster_players roster
          WHERE roster.league_id = p_league_id
            AND roster.league_season_id = p_league_season_id
            AND roster.player_id = player.id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.waiver_claims claim
          WHERE claim.league_id = p_league_id
            AND claim.league_season_id = p_league_season_id
            AND claim.player_id = player.id
            AND claim.status = 'pending'
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.waiver_wire_log wire
          WHERE wire.league_id = p_league_id
            AND wire.league_season_id = p_league_season_id
            AND wire.player_id = player.id
            AND wire.cleared_at IS NULL
            AND wire.clears_at > clock_timestamp()
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.trades trade
           JOIN public.trade_items item ON item.trade_id = trade.id
          WHERE trade.league_id = p_league_id
            AND trade.league_season_id = p_league_season_id
            AND trade.status IN ('pending', 'accepted')
            AND item.player_id = player.id
       )
       AND NOT (
         league.status = 'offseason'
         AND player.years_exp = 0
         AND player.nba_draft_number IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM public.drafts draft
            WHERE draft.league_id = p_league_id
              AND draft.league_season_id = p_league_season_id
              AND draft.draft_type = 'snake'
              AND NOT draft.is_mock
              AND draft.status = 'completed'
         )
       )
       AND NOT private.roster_status_game_started_live(player.id)
  )
$$;
