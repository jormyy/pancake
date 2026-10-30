-- Canonical SQL source for public.run_scheduler_chunk.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.run_scheduler_chunk(p_kind text,p_requeue boolean DEFAULT false,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE selected_kind text; result jsonb;
BEGIN
  selected_kind:=CASE p_kind WHEN 'forecasts' THEN 'forecast-inputs' WHEN 'notifications' THEN 'notification-scan' END;
  IF selected_kind IS NULL THEN RAISE EXCEPTION 'Unknown scheduler chunk.' USING ERRCODE='22023'; END IF;
  IF p_requeue THEN
    IF pg_try_advisory_xact_lock(hashtextextended('scheduler-chunk:'||selected_kind,0))
      AND NOT EXISTS(SELECT 1 FROM private.work_items WHERE work_items.kind=selected_kind AND status IN('pending','failed')) THEN
      PERFORM private.work_enqueue(selected_kind,gen_random_uuid()::text,now(),
        jsonb_build_object('schedulerChunk',p_kind,'continuation',gen_random_uuid())
          ||CASE WHEN p_kind='notifications' THEN jsonb_build_object('at',p_now) ELSE '{}'::jsonb END);
    END IF;
    RETURN jsonb_build_object('processed',0,'remaining',true);
  END IF;
  IF p_kind='forecasts' THEN result:=private.complete_forecast_input_chunk();
  ELSE result:=private.complete_notification_scan_chunk(p_now); END IF;
  RETURN result;
END;
$$;
