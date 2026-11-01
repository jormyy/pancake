-- Canonical SQL source for private.enqueue_matchup_forecasts.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.enqueue_matchup_forecasts(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM private.forecast_refresh_requests WHERE available_at<=p_now)
    OR EXISTS(SELECT 1 FROM private.matchup_forecast_expiries WHERE available_at<=p_now) THEN
    PERFORM private.work_enqueue('forecast-inputs',date_trunc('minute',p_now)::text,p_now,'{"schedulerChunk":"forecasts"}');
  END IF;
  IF EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty AND available_at<=p_now
    AND (SELECT due_at FROM private.matchup_forecast_schedule schedule WHERE schedule.matchup_id=private.matchup_forecast_queue.matchup_id)<=p_now
    AND NOT private.matchup_forecast_refresh_pending(matchup_id)
    AND (claimed_at IS NULL OR claimed_at<p_now-interval '3 minutes')) THEN
    PERFORM private.work_enqueue('matchup-forecasts',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;
