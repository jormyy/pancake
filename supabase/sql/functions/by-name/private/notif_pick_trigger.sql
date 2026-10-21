CREATE OR REPLACE FUNCTION private.notif_pick_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM private.notif_draft_clock(NEW.draft_id);
  RETURN NEW;
END;
$$;
