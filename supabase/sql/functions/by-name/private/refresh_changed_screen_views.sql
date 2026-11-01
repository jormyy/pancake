-- Canonical SQL source for private.refresh_changed_screen_views.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.refresh_changed_screen_views()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE row_data jsonb;
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)-ARRAY['updated_at','set_at']) IS NOT DISTINCT FROM (to_jsonb(NEW)-ARRAY['updated_at','set_at']) THEN RETURN NULL; END IF;
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='trades' AND TG_OP='INSERT' AND row_data->>'status' IN ('pending','accepted') THEN
    PERFORM private.work_enqueue('trade-revaluation',NEW.id::text||':created',now(),
      jsonb_build_object('tradeId',NEW.id,'memberId',NEW.proposer_member_id,
        'userId',(SELECT user_id FROM public.league_members WHERE id=NEW.proposer_member_id),'latestInputs',true),NEW.league_id);
  END IF;
  IF TG_TABLE_NAME='league_seasons' AND TG_OP='UPDATE'
    AND to_jsonb(OLD)->>'season_year' IS DISTINCT FROM row_data->>'season_year' THEN
    UPDATE private.screen_refresh_queue SET averages_initialized=false WHERE league_season_id=(row_data->>'id')::uuid;
  END IF;
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
    AND row_data->'details'->0->'scope'->'tables' <@ '["standings_current","matchup_totals","player_season_averages","trade_value_cache","matchup_forecasts","league_events"]'::jsonb THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME IN ('league_members','league_seasons') OR TG_TABLE_NAME='matchups' AND (
    COALESCE((row_data->>'is_finalized')::boolean,false)
    OR TG_OP='UPDATE' AND COALESCE((to_jsonb(OLD)->>'is_finalized')::boolean,false)) THEN
    UPDATE private.screen_refresh_queue SET standings_dirty=true
      WHERE league_id=(row_data->>'league_id')::uuid AND NOT standings_dirty;
  END IF;
  PERFORM private.refresh_queue_screen_views(
    CASE WHEN TG_TABLE_NAME = 'leagues' THEN (row_data->>'id')::uuid ELSE (row_data->>'league_id')::uuid END);
  RETURN NULL;
END;
$$;
