BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='io-hint-drain') THEN
    RAISE EXCEPTION 'The hint drain schedule is missing';
  END IF;
END;
$$;
SELECT cron.alter_job(jobid, schedule:='* * * * *', command:='SET statement_timeout=''5s''; SET lock_timeout=''250ms''; DO $job$ BEGIN IF NOT pg_try_advisory_lock(hashtext(''io-hint-drain'')) THEN RETURN; END IF; BEGIN IF NOT (SELECT paused FROM private.worker_controls WHERE id) THEN PERFORM private.flush_player_stats_hints(); PERFORM private.flush_league_inventory_hints(1000); END IF; EXCEPTION WHEN query_canceled THEN PERFORM pg_advisory_unlock(hashtext(''io-hint-drain'')); RAISE; WHEN OTHERS THEN PERFORM pg_advisory_unlock(hashtext(''io-hint-drain'')); RAISE; END; PERFORM pg_advisory_unlock(hashtext(''io-hint-drain'')); END; $job$;') FROM cron.job WHERE jobname='io-hint-drain';
COMMIT;
