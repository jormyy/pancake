CREATE OR REPLACE FUNCTION private.enqueue_season_boundary(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (p_now AT TIME ZONE 'America/New_York')::time<time '09:00' THEN RETURN; END IF;
  PERFORM private.work_enqueue('setup-season-rollover',date_trunc('hour',p_now)::text||':'||(extract(minute FROM p_now)::int/15)::text,p_now);
  IF EXISTS(SELECT 1 FROM public.leagues WHERE status IN ('active','playoffs','offseason','drafting')) THEN
    PERFORM private.work_enqueue('season-boundary',(p_now AT TIME ZONE 'America/New_York')::date::text,p_now);
  END IF;
END;
$$;
