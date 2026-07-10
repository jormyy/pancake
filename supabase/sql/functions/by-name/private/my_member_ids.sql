-- Canonical SQL source for private.my_member_ids.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.my_member_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT member.id
    FROM public.league_members AS member
    JOIN public.leagues AS league
      ON league.id = member.league_id
     AND league.deleted_at IS NULL
   WHERE member.user_id = (SELECT auth.uid())
$$;
