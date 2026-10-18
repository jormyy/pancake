DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pg-net-response-vacuum') THEN
    PERFORM cron.alter_job(jobid, schedule := '17 8 * * *')
    FROM cron.job WHERE jobname = 'pg-net-response-vacuum';
  END IF;
END;
$$;
