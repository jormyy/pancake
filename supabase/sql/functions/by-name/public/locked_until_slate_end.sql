-- Canonical SQL source for public.locked_until_slate_end.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.locked_until_slate_end(p_roster roster_players)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.roster_status_game_started(p_roster.player_id)
$$;
