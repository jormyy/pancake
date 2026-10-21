CREATE OR REPLACE FUNCTION private.notif_wake_draft_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.event_type='draft_on_clock' THEN
    BEGIN
      PERFORM public.invoke_edge_function('process-trades');
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG 'Draft notification wake failed; minute dispatcher will retry: %',SQLSTATE;
    END;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.notif_wake_draft_trigger() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER notif_draft_immediate_wake AFTER INSERT ON public.notification_outbox
FOR EACH ROW WHEN (NEW.event_type='draft_on_clock') EXECUTE FUNCTION private.notif_wake_draft_trigger();
