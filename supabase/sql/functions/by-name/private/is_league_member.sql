-- Canonical SQL source for private.is_league_member.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.is_league_member(p_league_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.league_members AS member
      JOIN public.leagues AS league
        ON league.id = member.league_id
       AND league.deleted_at IS NULL
     WHERE member.league_id = p_league_id
       AND member.user_id = (SELECT auth.uid())
  )
$$;
