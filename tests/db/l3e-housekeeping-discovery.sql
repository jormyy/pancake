SELECT private.scheduler_health();
SELECT private.retain_cron_job_run_details('2026-10-28T12:00:00Z');
SELECT private.retain_work_items('2026-10-28T12:00:00Z');
SELECT count(*) FROM public.work_dashboard();
SELECT public.prune_unbounded_history();
