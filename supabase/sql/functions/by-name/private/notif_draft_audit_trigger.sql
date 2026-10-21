CREATE OR REPLACE FUNCTION private.notif_draft_audit_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.drafts%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.drafts WHERE id = NEW.draft_id;
  IF NOT d.is_mock AND NEW.action = 'auto_pick' THEN
    PERFORM private.notif_enqueue('draft_auto_picked',NEW.id::text,d.league_id,(NEW.metadata->>'memberId')::uuid,
      jsonb_build_object('draftId',d.id,'playerId',NEW.metadata->>'playerId'));
  END IF;
  RETURN NEW;
END;
$$;
