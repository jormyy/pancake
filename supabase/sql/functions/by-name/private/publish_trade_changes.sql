CREATE OR REPLACE FUNCTION private.publish_trade_changes(p_publication_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE publication private.trade_publications%ROWTYPE; event jsonb; topic text; source text;
  previous_mode text:=coalesce(current_setting('pancake.trade_write',true),'');
BEGIN
  SELECT * INTO publication FROM private.trade_publications WHERE id=p_publication_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    IF EXISTS(SELECT 1 FROM private.trade_publications WHERE id=p_publication_id) THEN
      RAISE EXCEPTION 'Trade publication is busy.' USING ERRCODE='55P03';
    END IF;
    RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.leagues WHERE id=publication.league_id AND deleted_at IS NULL) THEN
    DELETE FROM private.trade_publications WHERE id=publication.id;
    RETURN;
  END IF;
  PERFORM set_config('pancake.trade_write','',true);
  FOR event IN SELECT value FROM jsonb_array_elements(publication.events) LOOP
    INSERT INTO public.league_events(league_id,member_id,kind,summary,detail,created_at)
      VALUES(publication.league_id,(SELECT id FROM public.league_members WHERE id=(event->>'member_id')::uuid),
        event->>'kind',event->>'summary',event->'detail',(event->>'created_at')::timestamptz);
  END LOOP;
  FOREACH topic IN ARRAY publication.topics LOOP
    FOREACH source IN ARRAY publication.sources LOOP
      PERFORM private.league_version_enqueue(publication.league_id,topic,source);
    END LOOP;
  END LOOP;
  PERFORM private.refresh_queue_screen_views(publication.league_id);
  DELETE FROM private.trade_publications WHERE id=publication.id;
  PERFORM set_config('pancake.trade_write',previous_mode,true);
END;
$$;
