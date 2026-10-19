CREATE OR REPLACE FUNCTION private.publish_league_inventory_hint(p_league_id uuid,p_details jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  BEGIN
    IF pg_try_advisory_xact_lock(hashtextextended('league-inventory-hint:'||p_league_id::text,0)) THEN
      PERFORM 1 FROM public.league_change_hints
        WHERE league_id=p_league_id AND topic='inventory' FOR UPDATE NOWAIT;
      INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details)
        VALUES(p_league_id,'inventory',1,NULL,p_details)
      ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,
        scopes=NULL,details=EXCLUDED.details,updated_at=clock_timestamp();
      RETURN;
    END IF;
  EXCEPTION WHEN serialization_failure OR lock_not_available THEN
    NULL;
  END;
  INSERT INTO private.league_hint_pending(league_id,details) VALUES(p_league_id,p_details);
END;
$$;
