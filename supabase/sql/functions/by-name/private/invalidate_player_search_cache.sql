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
