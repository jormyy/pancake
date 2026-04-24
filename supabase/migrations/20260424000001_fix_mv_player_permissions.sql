-- Fix: Grant SELECT on analytics.mv_player_season_averages to authenticated and anon
--
-- The public view proxy uses security_invoker = true, which means queries
-- execute with the caller's permissions. Without this grant, the view
-- returns 403 Forbidden because the underlying analytics.mv_player_season_averages
-- materialized view is inaccessible to authenticated/anon users.
GRANT SELECT ON analytics.mv_player_season_averages TO authenticated, anon;
