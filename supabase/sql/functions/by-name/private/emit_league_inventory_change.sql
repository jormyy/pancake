-- Canonical SQL source for private.emit_league_inventory_change.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.emit_league_inventory_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows text; v_details text; v_change record;
BEGIN
  IF TG_OP='INSERT' THEN v_rows := 'SELECT * FROM new_rows';
  ELSIF TG_OP='DELETE' THEN v_rows := 'SELECT * FROM old_rows';
  ELSE
    v_rows := $rows$SELECT n.* FROM new_rows n JOIN old_rows o USING(id)
      WHERE (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')
      UNION ALL SELECT o.* FROM old_rows o JOIN new_rows n USING(id)
      WHERE (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')$rows$;
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'draft_picks' THEN
      v_details := $details$SELECT pick.league_id,
        CASE WHEN season.id IS NOT NULL THEN jsonb_build_object(
          'resource','picks','season_id',season.id,'member_id',pick.current_owner_id) END AS detail
        FROM changed pick LEFT JOIN public.league_seasons season
          ON season.league_id=pick.league_id AND season.season_year=pick.season_year$details$;
    WHEN 'waiver_claims' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','claims','season_id',league_season_id) AS detail FROM changed WHERE status NOT IN ('pending','cancelled')$details$;
    WHEN 'waiver_wire_log' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','waivers','season_id',league_season_id) AS detail FROM changed$details$;
    WHEN 'waiver_priorities' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','priority','season_id',league_season_id,'member_id',member_id) AS detail FROM changed$details$;
    WHEN 'faab_balances' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','faab','season_id',league_season_id,'member_id',member_id) AS detail FROM changed$details$;
    WHEN 'league_activity' THEN
      RETURN NULL;
    WHEN 'league_seasons' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','season','season_id',id) AS detail FROM changed$details$;
    ELSE
      v_details := 'SELECT league_id,NULL::jsonb AS detail FROM changed';
  END CASE;
  FOR v_change IN EXECUTE format($query$
    WITH changed AS (%s),details AS (%s),distinct_details AS (
      SELECT DISTINCT details.league_id,details.detail FROM details
      JOIN public.leagues league ON league.id=details.league_id AND league.deleted_at IS NULL
    ) SELECT league_id,CASE WHEN count(*)<=16 AND bool_and(detail IS NOT NULL)
        THEN jsonb_agg(detail ORDER BY detail::text) END AS details
      FROM distinct_details GROUP BY league_id ORDER BY league_id
  $query$,v_rows,v_details) LOOP
    PERFORM private.publish_league_inventory_hint(v_change.league_id,v_change.details);
  END LOOP;
  RETURN NULL;
END;
$$;
