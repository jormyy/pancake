CREATE OR REPLACE FUNCTION private.flush_league_inventory_hints(p_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit,1000),0),5000);
  v_league_id uuid;
  v_ids uuid[];
  v_details jsonb;
  v_processed integer := 0;
BEGIN
  FOR v_league_id IN
    SELECT DISTINCT pending.league_id FROM (
      SELECT league_id FROM private.league_hint_pending ORDER BY created_at,id LIMIT v_limit
    ) pending ORDER BY pending.league_id
  LOOP
    EXIT WHEN v_processed>=v_limit;
    BEGIN
      IF NOT pg_try_advisory_xact_lock(hashtextextended('league-inventory-hint:'||v_league_id::text,0)) THEN
        CONTINUE;
      END IF;
      SELECT array_agg(pending.id) INTO v_ids FROM (
        SELECT id FROM private.league_hint_pending WHERE league_id=v_league_id
          ORDER BY created_at,id LIMIT v_limit-v_processed FOR UPDATE SKIP LOCKED
      ) pending;
      IF v_ids IS NULL THEN CONTINUE; END IF;
      IF EXISTS(SELECT 1 FROM public.leagues WHERE id=v_league_id AND deleted_at IS NULL) THEN
        v_details := NULL;
        IF cardinality(v_ids)=1 THEN
          SELECT details INTO v_details FROM private.league_hint_pending WHERE id=v_ids[1];
        END IF;
        PERFORM 1 FROM public.league_change_hints
          WHERE league_id=v_league_id AND topic='inventory' FOR UPDATE NOWAIT;
        INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details)
          VALUES(v_league_id,'inventory',cardinality(v_ids),NULL,v_details)
        ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+EXCLUDED.revision,
          scopes=NULL,details=EXCLUDED.details,updated_at=clock_timestamp();
      END IF;
      DELETE FROM private.league_hint_pending WHERE id=ANY(v_ids);
      v_processed := v_processed+cardinality(v_ids);
    EXCEPTION WHEN serialization_failure OR lock_not_available THEN
      NULL;
    END;
  END LOOP;
  RETURN v_processed;
END;
$$;
