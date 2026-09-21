-- Canonical SQL source for private.ineligible_ir_player_names.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.ineligible_ir_player_names(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT string_agg(COALESCE(player_row.display_name, 'Unknown'), ', ' ORDER BY player_row.display_name)
    FROM public.roster_players AS roster_row
    JOIN public.players AS player_row
      ON player_row.id = roster_row.player_id
   WHERE roster_row.member_id = p_member_id
     AND roster_row.league_id = p_league_id
     AND roster_row.league_season_id = p_league_season_id
     AND roster_row.is_on_ir = true
     AND NOT private.is_ir_designation(player_row.injury_status)
$$;
