CREATE OR REPLACE FUNCTION private.notif_draft_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_event text;
  v_occurrence text;
  m record;
BEGIN
  IF NEW.is_mock THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    v_event := CASE WHEN NEW.status = 'in_progress' AND TG_OP = 'UPDATE' AND OLD.status = 'paused' THEN 'draft_resumed'
      WHEN NEW.status = 'in_progress' THEN 'draft_started'
      WHEN NEW.status = 'paused' THEN 'draft_paused' WHEN NEW.status = 'completed' THEN 'draft_finished' END;
    v_occurrence := CASE WHEN v_event IN ('draft_paused','draft_resumed') THEN NEW.id::text || ':' || gen_random_uuid()::text ELSE NEW.id::text END;
    IF v_event IS NOT NULL THEN
      FOR m IN SELECT id FROM public.league_members WHERE league_id = NEW.league_id LOOP
        PERFORM private.notif_enqueue(v_event,v_occurrence,NEW.league_id,m.id,jsonb_build_object('draftId',NEW.id));
      END LOOP;
    END IF;
  END IF;
  PERFORM private.notif_draft_clock(NEW.id);
  RETURN NEW;
END;
$$;
