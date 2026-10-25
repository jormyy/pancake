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
  SELECT string_agg(problem.player_name, ', ' ORDER BY problem.player_name)
  FROM private.roster_problems(p_league_id,p_league_season_id,p_member_id) problem
  WHERE problem.kind='ir'
$$;
