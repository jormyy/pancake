\set ON_ERROR_STOP off
\echo ==== P1 ops#3 minute-exact ET gate (invoke_edge_function_at_et_time)
SELECT to_char(timezone('America/New_York', now()), 'HH24:MI:SS') AS et_now;
SELECT count(*) AS queued_before FROM net.http_request_queue;
SELECT public.invoke_edge_function_at_et_time('process-waivers', 3, 0);
SELECT count(*) AS queued_after FROM net.http_request_queue;
SELECT 'predicate is hour=3 AND minute=0 equality (source):' AS note, regexp_replace(substring(pg_get_functiondef('public.invoke_edge_function_at_et_time'::regproc) from 'IF[^;]*THEN'), '\s+', ' ', 'g') AS gate;
SELECT 'boundary gate:' AS note, regexp_replace(substring(pg_get_functiondef('public.invoke_season_boundary_if_due'::regproc) from 'IF EXTRACT[^;]*THEN'), '\s+', ' ', 'g') AS gate;

\echo ==== P3 ops#2 cron->edge invocation is fire-and-forget (local GUCs set for this session only)
SELECT set_config('app.supabase_url', :'api', false) IS NOT NULL AS url_set, set_config('app.edge_internal_token', 'pancake-local-edge-auth-probe-token', false) IS NOT NULL AS token_set;
SELECT count(*) AS sync_runs_before FROM public.sync_runs;
SELECT public.invoke_edge_function('function-that-does-not-exist');
SELECT pg_sleep(6);
SELECT status_code, left(coalesce(error_msg, content::text), 120) AS response FROM net._http_response ORDER BY created DESC LIMIT 1;
SELECT count(*) AS sync_runs_after FROM public.sync_runs;
SELECT 'nothing reads net._http_response:' AS note, count(*) AS functions_referencing FROM pg_proc WHERE prosrc ILIKE '%_http_response%';

\echo ==== P4 ops#11 Final game with no stats is invisible to the live-poll gate
BEGIN;
INSERT INTO public.nba_games (id, season_year, game_date, week_number, home_team, away_team, status)
VALUES ('00000000-0000-4000-8000-0000000000f1', 2026, (timezone('America/New_York', now()))::date - 1, 1, 'BOS', 'MIA', 'Final');
SELECT public.count_final_games_missing_stats(2026) AS final_games_missing_stats;
SELECT EXISTS (SELECT 1 FROM public.nba_games WHERE game_date IN ((timezone('America/New_York', now()))::date - 1, (timezone('America/New_York', now()))::date) AND status <> 'Final') AS live_poll_gate_would_fire;
SELECT count(*) AS cron_jobs_using_missing_stats_count FROM cron.job WHERE command ILIKE '%count_final_games_missing_stats%';
ROLLBACK;

\echo ==== P9 ops#4 parked stats job cannot be reclaimed and nothing on cron resurrects it
BEGIN;
INSERT INTO public.sync_jobs (id, job_type, status, total_items, completed_items, failed_items, metadata)
VALUES ('00000000-0000-4000-8000-0000000000f2', 'stats_range', 'failed', 10, 2, 3, '{"start_date":"2026-01-01","end_date":"2026-01-10","cursor_date":"2026-01-03"}'::jsonb);
SELECT public.claim_stats_sync_job_atomic('00000000-0000-4000-8000-0000000000f2', 600) IS NULL AS claim_refused;
SELECT count(*) AS cron_jobs_calling_resume FROM cron.job WHERE command ILIKE '%create_or_resume_stats_sync_job%';
ROLLBACK;

\echo ==== P8 ops#8 optimizer has no progress cursor
SELECT count(*) AS cursor_like_columns FROM information_schema.columns WHERE table_name='lineup_optimizer_settings' AND column_name ILIKE '%cursor%';
