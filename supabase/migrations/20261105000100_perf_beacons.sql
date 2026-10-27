CREATE TABLE public.perf_beacons (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  member_id uuid NOT NULL REFERENCES public.league_members(id) ON DELETE CASCADE,
  screen text NOT NULL CHECK (screen IN ('matchup', 'roster', 'players', 'league', 'trades', 'profile', 'draft', 'player', 'draft-room', 'rookie-draft-room', 'lineup', 'team-roster', 'bracket', 'claim-player', 'propose-trade', 'commissioner-settings', 'notification-settings', 'change-password', 'create-league', 'join-league')),
  useful_ms integer NOT NULL CHECK (useful_ms BETWEEN 0 AND 120000),
  request_count smallint NOT NULL CHECK (request_count BETWEEN 0 AND 10000),
  transfer_bytes integer NOT NULL CHECK (transfer_bytes BETWEEN 0 AND 1000000000),
  bytes_complete boolean NOT NULL,
  cold boolean NOT NULL,
  device_class text NOT NULL CHECK (device_class IN ('phone', 'tablet', 'desktop')),
  connection_type text NOT NULL CHECK (connection_type IN ('slow-2g', '2g', '3g', '4g', 'unknown')),
  app_version text NOT NULL CHECK (app_version ~ '^[a-zA-Z0-9.+_-]{1,40}$'),
  sample_n smallint NOT NULL CHECK (sample_n BETWEEN 1 AND 10000)
);

CREATE INDEX perf_beacons_received_at_idx ON public.perf_beacons(received_at);
CREATE INDEX perf_beacons_member_id_idx ON public.perf_beacons(member_id);
ALTER TABLE public.perf_beacons ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.perf_beacons FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.perf_beacons TO service_role;
GRANT USAGE ON SEQUENCE public.perf_beacons_id_seq TO service_role;

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

CREATE OR REPLACE FUNCTION private.prune_perf_beacons()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '250ms'
AS $$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM public.perf_beacons WHERE received_at < now() - interval '30 days';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.perf_summary(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.perf_summary(integer) TO service_role;
REVOKE ALL ON FUNCTION private.prune_perf_beacons() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  retention record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    SELECT jobid, command INTO retention FROM cron.job WHERE jobname = 'retention-prune';
    IF FOUND THEN
      PERFORM cron.alter_job(retention.jobid, schedule := '0 10 * * *',
        command := rtrim(retention.command, '; ' || chr(10)) || '; SELECT private.prune_perf_beacons();');
    END IF;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
