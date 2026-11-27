-- Canonical SQL source for private.rookie_class_players.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.rookie_class_players(p_draft_year int)
RETURNS TABLE (player_id uuid, draft_round int, draft_overall_pick int)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT player.id, player.draft_round::int, player.draft_overall_pick::int
    FROM public.players player
   WHERE player.draft_status = 'drafted'
     AND player.draft_year = p_draft_year
     AND player.nba_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.players other
        WHERE other.id <> player.id
          AND other.draft_status = 'drafted'
          AND other.draft_year = player.draft_year
          AND other.draft_overall_pick = player.draft_overall_pick
     )
$$;
