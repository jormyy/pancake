BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TABLE analytics.search_cache_source_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision bigint NOT NULL DEFAULT 1
);
INSERT INTO analytics.search_cache_source_state (id) VALUES (true);
REVOKE ALL ON analytics.search_cache_source_state FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE analytics.search_cache_refresh_state ADD COLUMN source_revision bigint;

CREATE OR REPLACE FUNCTION private.invalidate_player_search_cache()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'leagues' THEN
    IF NOT EXISTS (
      SELECT 1 FROM cache_old_rows old_row FULL JOIN cache_new_rows new_row USING (id)
      WHERE old_row.id IS NULL OR new_row.id IS NULL
         OR old_row.scoring_settings IS DISTINCT FROM new_row.scoring_settings
    ) THEN RETURN NULL; END IF;
  ELSIF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'nba_games' THEN
    IF NOT EXISTS (
      SELECT 1 FROM cache_old_rows old_row FULL JOIN cache_new_rows new_row USING (id)
      WHERE old_row.id IS NULL OR new_row.id IS NULL
         OR old_row.nba_game_id IS DISTINCT FROM new_row.nba_game_id
    ) THEN RETURN NULL; END IF;
  ELSIF TG_OP <> 'TRUNCATE' THEN
    IF NOT EXISTS (SELECT 1 FROM cache_changed_rows) THEN RETURN NULL; END IF;
  END IF;
  UPDATE analytics.search_cache_source_state SET revision = revision + 1 WHERE id;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.invalidate_player_search_cache() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER search_cache_insert AFTER INSERT ON public.player_game_stats REFERENCING NEW TABLE AS cache_changed_rows
FOR EACH STATEMENT EXECUTE FUNCTION private.invalidate_player_search_cache();
CREATE TRIGGER search_cache_update AFTER UPDATE ON public.player_game_stats REFERENCING OLD TABLE AS cache_old_rows NEW TABLE AS cache_changed_rows
FOR EACH STATEMENT EXECUTE FUNCTION private.invalidate_player_search_cache();
CREATE TRIGGER search_cache_delete AFTER DELETE ON public.player_game_stats REFERENCING OLD TABLE AS cache_changed_rows
FOR EACH STATEMENT EXECUTE FUNCTION private.invalidate_player_search_cache();
CREATE TRIGGER search_cache_truncate AFTER TRUNCATE ON public.player_game_stats
FOR EACH STATEMENT EXECUTE FUNCTION private.invalidate_player_search_cache();
CREATE TRIGGER search_cache_insert AFTER INSERT ON public.nba_games REFERENCING NEW TABLE AS cache_changed_rows
FOR EACH STATEMENT EXECUTE FUNCTION private.invalidate_player_search_cache();
CREATE TRIGGER search_cache_update AFTER UPDATE ON public.nba_games REFERENCING OLD TABLE AS cache_old_rows NEW TABLE AS cache_new_rows
FOR EACH STATEMENT EXECUTE FUNCTION private.invalidate_player_search_cache();
CREATE TRIGGER search_cache_delete AFTER DELETE ON public.nba_games REFERENCING OLD TABLE AS cache_changed_rows
FOR EACH STATEMENT EXECUTE FUNCTION private.invalidate_player_search_cache();
CREATE TRIGGER search_cache_truncate AFTER TRUNCATE ON public.nba_games
FOR EACH STATEMENT EXECUTE FUNCTION private.invalidate_player_search_cache();
CREATE TRIGGER search_cache_insert AFTER INSERT ON public.leagues REFERENCING NEW TABLE AS cache_changed_rows
FOR EACH STATEMENT EXECUTE FUNCTION private.invalidate_player_search_cache();
CREATE TRIGGER search_cache_update AFTER UPDATE ON public.leagues REFERENCING OLD TABLE AS cache_old_rows NEW TABLE AS cache_new_rows
FOR EACH STATEMENT EXECUTE FUNCTION private.invalidate_player_search_cache();
CREATE TRIGGER search_cache_delete AFTER DELETE ON public.leagues REFERENCING OLD TABLE AS cache_changed_rows
FOR EACH STATEMENT EXECUTE FUNCTION private.invalidate_player_search_cache();
CREATE TRIGGER search_cache_truncate AFTER TRUNCATE ON public.leagues
FOR EACH STATEMENT EXECUTE FUNCTION private.invalidate_player_search_cache();

CREATE OR REPLACE FUNCTION public.refresh_player_search_caches()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, analytics
AS $$
DECLARE
  v_state analytics.search_cache_refresh_state;
  v_source_revision bigint;
BEGIN
  IF NOT pg_try_advisory_xact_lock(189736123, 2) THEN RETURN; END IF;
  SELECT revision INTO STRICT v_source_revision FROM analytics.search_cache_source_state WHERE id;
  SELECT * INTO v_state FROM analytics.search_cache_refresh_state WHERE id;

  IF v_state.refreshed_at IS NOT NULL
     AND v_state.refreshed_at > now() - interval '7 days'
     AND v_state.source_revision = v_source_revision THEN
    RETURN;
  END IF;

  REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_player_season_averages;
  REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_player_avg_fantasy_points;
  DELETE FROM analytics.player_avg_fantasy_points_fresh fresh
  WHERE EXISTS (
    SELECT 1
    FROM analytics.mv_player_avg_fantasy_points cached
    WHERE cached.league_id = fresh.league_id
  );

  INSERT INTO analytics.search_cache_refresh_state (id, refreshed_at, source_revision)
  VALUES (true, now(), v_source_revision)
  ON CONFLICT (id) DO UPDATE
    SET refreshed_at = excluded.refreshed_at,
        source_revision = excluded.source_revision;
END;
$$;

COMMIT;
