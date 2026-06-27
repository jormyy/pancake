-- Restore the hardened, immutable search_path on the scoring helpers.
--
-- 20260422000002 set `SET search_path = public` on compute_fantasy_points to fix
-- the Supabase function_search_path_mutable lint, but the later CREATE OR REPLACE
-- in 20260626000002 (which added the regular-season filter) omitted the clause,
-- and CREATE OR REPLACE reverts unspecified SET params to default — silently
-- reintroducing the mutable search_path. is_regular_season_game_id (added in the
-- same migration) never had it. Re-pin both via ALTER (no body change needed).

ALTER FUNCTION public.compute_fantasy_points(uuid, uuid) SET search_path = public;
ALTER FUNCTION public.is_regular_season_game_id(text) SET search_path = public;
