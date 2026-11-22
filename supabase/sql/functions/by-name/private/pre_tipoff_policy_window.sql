-- Canonical SQL source for private.pre_tipoff_policy_window.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.pre_tipoff_policy_window(p_tipoff_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_tipoff_at IS NOT NULL AND EXISTS (
    SELECT 1
      FROM private.league_roster_policies policy
      JOIN public.leagues league
        ON league.id = policy.league_id
       AND league.status IN ('active', 'playoffs')
      JOIN public.league_seasons season
        ON season.league_id = league.id
       AND season.is_current
      JOIN public.nba_games game
        ON game.season_year = season.season_year
       AND game.game_time = p_tipoff_at
       AND game.status = 'Scheduled'
       AND private.lineup_game_available(game.status, game.game_status_text)
     WHERE policy.auto_ir_all_members
       AND policy.ir_activated_at IS NOT NULL
  )
$$;
