CREATE OR REPLACE FUNCTION private.refresh_changed_screen_views()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE row_data jsonb;
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)-ARRAY['updated_at','set_at']) IS NOT DISTINCT FROM (to_jsonb(NEW)-ARRAY['updated_at','set_at']) THEN RETURN NULL; END IF;
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='league_change_hints' AND row_data->>'topic'='inventory'
    AND EXISTS(SELECT 1 FROM private.league_version_pending
      WHERE transaction_id=pg_current_xact_id() AND league_id=(row_data->>'league_id')::uuid) THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME<>'league_change_hints' AND current_setting('pancake.trade_write',true)='true' THEN
    PERFORM private.queue_trade_publication(
      CASE WHEN TG_TABLE_NAME='leagues' THEN (row_data->>'id')::uuid ELSE (row_data->>'league_id')::uuid END);
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'league_change_hints' AND row_data->>'topic' = 'version'
    AND jsonb_array_length(COALESCE(row_data->'details'->0->'scope'->'tables', '[]')) > 0
    AND row_data->'details'->0->'scope'->'tables' <@ '["standings_current","matchup_totals","player_season_averages","trade_value_cache","matchup_forecasts"]'::jsonb THEN
    RETURN NULL;
  END IF;
  PERFORM private.refresh_queue_screen_views(
    CASE WHEN TG_TABLE_NAME = 'leagues' THEN (row_data->>'id')::uuid ELSE (row_data->>'league_id')::uuid END);
  RETURN NULL;
END;
$$;
