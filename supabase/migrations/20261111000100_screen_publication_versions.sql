CREATE OR REPLACE FUNCTION private.league_version_capture()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed_sql text; leagues_sql text; affected record;
  ignored text[] := ARRAY['updated_at','set_at'];
BEGIN
  IF TG_TABLE_NAME IN ('standings_current','matchup_totals','player_season_averages','trade_value_cache') THEN
    ignored := ignored||ARRAY['version','refreshed_at'];
  END IF;
  IF TG_TABLE_NAME='profiles' THEN ignored := ignored||ARRAY['push_token','push_token_revocation_hash']; END IF;
  IF TG_TABLE_NAME='nba_games' THEN
    ignored := ignored||ARRAY['live_stats_elapsed_seconds','live_scoreboard_elapsed_seconds','stats_synced_at'];
  END IF;
  IF TG_OP='INSERT' THEN changed_sql := 'SELECT to_jsonb(n) AS data FROM version_new_rows n';
  ELSIF TG_OP='DELETE' THEN changed_sql := 'SELECT to_jsonb(o) AS data FROM version_old_rows o';
  ELSE
    changed_sql := format($rows$
      (SELECT to_jsonb(n)-%L::text[] AS data FROM version_new_rows n
       EXCEPT SELECT to_jsonb(o)-%L::text[] FROM version_old_rows o)
      UNION ALL
      (SELECT to_jsonb(o)-%L::text[] FROM version_old_rows o
       EXCEPT SELECT to_jsonb(n)-%L::text[] FROM version_new_rows n)
    $rows$,ignored,ignored,ignored,ignored);
  END IF;
  CASE TG_ARGV[1]
    WHEN 'league' THEN leagues_sql := 'SELECT (data->>''league_id'')::uuid AS league_id FROM changed';
    WHEN 'user' THEN leagues_sql := 'SELECT member.league_id FROM changed JOIN public.league_members member ON member.user_id=COALESCE((data->>''user_id'')::uuid,(data->>''id'')::uuid)';
    WHEN 'self' THEN leagues_sql := 'SELECT (data->>''id'')::uuid AS league_id FROM changed';
    WHEN 'draft' THEN leagues_sql := 'SELECT draft.league_id FROM changed JOIN public.drafts draft ON draft.id=(data->>''draft_id'')::uuid';
    WHEN 'trade' THEN leagues_sql := 'SELECT trade.league_id FROM changed JOIN public.trades trade ON trade.id=(data->>''trade_id'')::uuid';
    WHEN 'season' THEN leagues_sql := 'SELECT season.league_id FROM changed JOIN public.league_seasons season ON season.season_year=(data->>''season_year'')::integer';
    WHEN 'global' THEN leagues_sql := 'SELECT league.id AS league_id FROM public.leagues league WHERE league.deleted_at IS NULL AND EXISTS(SELECT 1 FROM changed)';
    ELSE RAISE EXCEPTION 'Unsupported league version source: %',TG_TABLE_NAME;
  END CASE;
  FOR affected IN EXECUTE format('WITH changed AS (%s) SELECT DISTINCT league_id FROM (%s) affected WHERE league_id IS NOT NULL ORDER BY league_id',changed_sql,leagues_sql) LOOP
    PERFORM private.league_version_enqueue(affected.league_id,TG_ARGV[0],TG_TABLE_NAME);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_changed_screen_views()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE row_data jsonb;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME = 'league_change_hints' AND row_data->>'topic' = 'version'
    AND jsonb_array_length(COALESCE(row_data->'details'->0->'scope'->'tables', '[]')) > 0
    AND row_data->'details'->0->'scope'->'tables' <@ '["standings_current","matchup_totals","player_season_averages","trade_value_cache"]'::jsonb THEN
    RETURN NULL;
  END IF;
  PERFORM private.refresh_queue_screen_views(
    CASE WHEN TG_TABLE_NAME = 'leagues' THEN (row_data->>'id')::uuid ELSE (row_data->>'league_id')::uuid END);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS league_version_insert ON public.standings_current;
CREATE TRIGGER league_version_insert AFTER INSERT ON public.standings_current
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('score','league');

DROP TRIGGER IF EXISTS league_version_update ON public.standings_current;
CREATE TRIGGER league_version_update AFTER UPDATE ON public.standings_current
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('score','league');

DROP TRIGGER IF EXISTS league_version_delete ON public.standings_current;
CREATE TRIGGER league_version_delete AFTER DELETE ON public.standings_current
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('score','league');

DROP TRIGGER IF EXISTS league_version_insert ON public.matchup_totals;
CREATE TRIGGER league_version_insert AFTER INSERT ON public.matchup_totals
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('score','league');

DROP TRIGGER IF EXISTS league_version_update ON public.matchup_totals;
CREATE TRIGGER league_version_update AFTER UPDATE ON public.matchup_totals
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('score','league');

DROP TRIGGER IF EXISTS league_version_delete ON public.matchup_totals;
CREATE TRIGGER league_version_delete AFTER DELETE ON public.matchup_totals
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('score','league');

DROP TRIGGER IF EXISTS league_version_insert ON public.player_season_averages;
CREATE TRIGGER league_version_insert AFTER INSERT ON public.player_season_averages
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('resources','league');

DROP TRIGGER IF EXISTS league_version_update ON public.player_season_averages;
CREATE TRIGGER league_version_update AFTER UPDATE ON public.player_season_averages
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('resources','league');

DROP TRIGGER IF EXISTS league_version_delete ON public.player_season_averages;
CREATE TRIGGER league_version_delete AFTER DELETE ON public.player_season_averages
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('resources','league');

DROP TRIGGER IF EXISTS league_version_insert ON public.trade_value_cache;
CREATE TRIGGER league_version_insert AFTER INSERT ON public.trade_value_cache
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');

DROP TRIGGER IF EXISTS league_version_update ON public.trade_value_cache;
CREATE TRIGGER league_version_update AFTER UPDATE ON public.trade_value_cache
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');

DROP TRIGGER IF EXISTS league_version_delete ON public.trade_value_cache;
CREATE TRIGGER league_version_delete AFTER DELETE ON public.trade_value_cache
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
