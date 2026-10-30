-- Canonical SQL source for private.emit_league_resource_change.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.emit_league_resource_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows text; v_details text; v_change record;
BEGIN
  IF TG_OP='DELETE' AND TG_TABLE_NAME IN ('projection_sync_runs','fantasypros_projection_rows','sleeper_projection_rows')
    AND current_setting('pancake.projection_cleanup',true)='on' THEN RETURN NULL; END IF;
  IF TG_OP='INSERT' THEN v_rows := 'SELECT * FROM resource_new_rows';
  ELSIF TG_OP='DELETE' THEN v_rows := 'SELECT * FROM resource_old_rows';
  ELSE
    v_rows := $rows$SELECT n.* FROM resource_new_rows n JOIN resource_old_rows o USING(id)
      WHERE (to_jsonb(n)-ARRAY['updated_at','fetched_at','last_modified']) IS DISTINCT FROM (to_jsonb(o)-ARRAY['updated_at','fetched_at','last_modified'])
      UNION ALL SELECT o.* FROM resource_old_rows o JOIN resource_new_rows n USING(id)
      WHERE (to_jsonb(n)-ARRAY['updated_at','fetched_at','last_modified']) IS DISTINCT FROM (to_jsonb(o)-ARRAY['updated_at','fetched_at','last_modified'])$rows$;
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'leagues' THEN
      IF TG_OP='UPDATE' THEN
        v_rows := $rows$SELECT n.* FROM resource_new_rows n JOIN resource_old_rows o USING(id)
          WHERE n.scoring_settings IS DISTINCT FROM o.scoring_settings$rows$;
      END IF;
      v_details := $details$SELECT league.id AS league_id,
        CASE WHEN season.id IS NOT NULL THEN jsonb_build_object('resource','scoring','season_id',season.id) END AS detail
        FROM changed league LEFT JOIN public.league_seasons season ON season.league_id=league.id$details$;
    WHEN 'search_cache_refresh_state' THEN
      v_details := $details$SELECT league.id AS league_id,
        CASE WHEN season.id IS NOT NULL THEN jsonb_build_object('resource','averages','season_id',season.id) END AS detail
        FROM public.leagues league LEFT JOIN public.league_seasons season ON season.league_id=league.id
        WHERE EXISTS (SELECT 1 FROM changed WHERE source_revision IS NOT NULL AND refreshed_at IS NOT NULL)$details$;
    WHEN 'player_projections' THEN
      v_details := $details$SELECT season.league_id,
        jsonb_build_object('resource','projections','season_id',season.id) AS detail
        FROM changed projection JOIN public.league_seasons season ON season.season_year=projection.season_year$details$;
    WHEN 'sleeper_projection_rows' THEN
      v_details := $details$SELECT season.league_id,
        jsonb_build_object('resource','projections','season_id',season.id) AS detail
        FROM changed projection JOIN public.league_seasons season ON season.season_year=projection.season_year
        WHERE projection.game_date>=date_trunc('week',timezone('America/Los_Angeles',now()))::date$details$;
    WHEN 'projection_sync_runs' THEN
      v_details := $details$SELECT season.league_id,
        jsonb_build_object('resource','projections','season_id',season.id) AS detail
        FROM changed run JOIN public.league_seasons season ON run.season_year IS NULL OR season.season_year=run.season_year
        WHERE run.source='fantasypros' AND run.status IN ('success','failed','skipped') AND run.completed_at IS NOT NULL$details$;
    WHEN 'fantasypros_projection_rows' THEN
      v_details := $details$SELECT season.league_id,
        jsonb_build_object('resource','projections','season_id',season.id) AS detail
        FROM changed projection JOIN public.projection_sync_runs run ON run.id=projection.run_id
        JOIN public.league_seasons season ON COALESCE(projection.season_year,run.season_year) IS NULL
          OR season.season_year=COALESCE(projection.season_year,run.season_year)
        WHERE run.status='success' AND run.completed_at IS NOT NULL$details$;
    ELSE RAISE EXCEPTION 'Unsupported league resource source';
  END CASE;
  FOR v_change IN EXECUTE format($query$
    WITH changed AS (%s),details AS (%s),distinct_details AS (
      SELECT DISTINCT details.league_id,details.detail FROM details
      JOIN public.leagues league ON league.id=details.league_id AND league.deleted_at IS NULL
    ) SELECT league_id,CASE WHEN count(*)<=16 AND bool_and(detail IS NOT NULL)
        THEN jsonb_agg(detail ORDER BY detail::text) END AS details
      FROM distinct_details GROUP BY league_id ORDER BY league_id
  $query$,v_rows,v_details) LOOP
    INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details)
      VALUES(v_change.league_id,'resources',1,NULL,v_change.details)
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,
      scopes=NULL,details=EXCLUDED.details,updated_at=clock_timestamp();
  END LOOP;
  RETURN NULL;
END;
$$;
