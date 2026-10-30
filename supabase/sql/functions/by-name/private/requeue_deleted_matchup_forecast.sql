-- Canonical SQL source for private.requeue_deleted_matchup_forecast.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.requeue_deleted_matchup_forecast()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.matchups WHERE id=OLD.matchup_id) THEN
    PERFORM private.queue_matchup_forecasts(NULL,OLD.matchup_id);
  END IF;
  RETURN NULL;
END;
$$;
