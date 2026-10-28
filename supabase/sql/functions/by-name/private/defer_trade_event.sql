CREATE OR REPLACE FUNCTION private.defer_trade_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.league_id IS NOT NULL AND current_setting('pancake.trade_write',true)='true' THEN
    PERFORM private.queue_trade_publication(NEW.league_id,'trade','league_events',to_jsonb(NEW));
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
