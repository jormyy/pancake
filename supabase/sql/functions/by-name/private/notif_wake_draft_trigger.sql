-- Canonical SQL source for private.notif_wake_draft_trigger.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
