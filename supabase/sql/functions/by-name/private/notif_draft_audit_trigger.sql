CREATE OR REPLACE FUNCTION private.notif_draft_audit_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.drafts%ROWTYPE;
  m record;
BEGIN
  SELECT * INTO d FROM public.drafts WHERE id = NEW.draft_id;
  IF NOT d.is_mock AND NEW.action = 'auto_pick' THEN
    PERFORM private.notif_enqueue('draft_auto_picked',NEW.id::text,d.league_id,(NEW.metadata->>'memberId')::uuid,
      jsonb_build_object('draftId',d.id,'playerId',NEW.metadata->>'playerId'));
  ELSIF NOT d.is_mock AND NEW.action='resume' AND NEW.metadata->>'previousStatus'='paused' AND d.status='in_progress' THEN
    FOR m IN SELECT id FROM public.league_members WHERE league_id=d.league_id LOOP
      PERFORM private.notif_enqueue('draft_resumed',NEW.id::text,d.league_id,m.id,jsonb_build_object('draftId',d.id));
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
