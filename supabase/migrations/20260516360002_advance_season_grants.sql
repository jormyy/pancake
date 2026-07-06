-- Grants for advance_season_atomic (split from 20260516360000 due to
-- Supabase CLI v2.75.0 prepared-statement restriction on multi-command migrations).
REVOKE ALL ON FUNCTION public.advance_season_atomic(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.advance_season_atomic(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.advance_season_atomic(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.advance_season_atomic(uuid) TO service_role;
