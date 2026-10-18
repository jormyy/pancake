-- Canonical SQL source for private.emit_league_inventory_change.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.emit_league_inventory_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows text; v_change record;
BEGIN
  IF TG_OP='INSERT' THEN v_rows := 'SELECT * FROM new_rows';
  ELSIF TG_OP='DELETE' THEN v_rows := 'SELECT * FROM old_rows';
  ELSE
    v_rows := $rows$SELECT n.* FROM new_rows n JOIN old_rows o USING(id)
      WHERE (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')
      UNION ALL SELECT o.* FROM old_rows o JOIN new_rows n USING(id)
      WHERE (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')$rows$;
  END IF;
  FOR v_change IN EXECUTE format($query$
    WITH changed AS (%s) SELECT DISTINCT changed.league_id FROM changed
      JOIN public.leagues league ON league.id=changed.league_id AND league.deleted_at IS NULL
      ORDER BY changed.league_id
  $query$,v_rows) LOOP
    INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes)
      VALUES(v_change.league_id,'inventory',1,NULL)
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,
      scopes=NULL,updated_at=clock_timestamp();
  END LOOP;
  RETURN NULL;
END;
$$;
