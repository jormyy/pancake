CREATE OR REPLACE FUNCTION public.perf_summary(p_days integer DEFAULT 7)
RETURNS TABLE(day date, screen text, samples bigint, p50_ms double precision, p95_ms double precision)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 30 THEN
    RAISE EXCEPTION 'p_days must be between 1 and 30' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT (b.received_at AT TIME ZONE 'UTC')::date, b.screen, count(*),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY b.useful_ms),
    percentile_cont(0.95) WITHIN GROUP (ORDER BY b.useful_ms)
  FROM public.perf_beacons b
  WHERE b.received_at >= ((now() AT TIME ZONE 'UTC')::date - (p_days - 1))::timestamp AT TIME ZONE 'UTC'
  GROUP BY 1, 2 ORDER BY 1, 2;
END;
$$;
