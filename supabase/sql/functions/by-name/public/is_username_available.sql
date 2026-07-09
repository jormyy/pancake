-- Canonical SQL source for public.is_username_available.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.is_username_available(p_username text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE username = trim(p_username)
  );
$$;
