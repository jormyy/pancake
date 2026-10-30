BEGIN;
SET LOCAL pg_stat_statements.track='none';
CREATE TEMP TABLE ra_http_work AS SELECT id,key,invocation_key FROM private.work_items
WHERE kind='process-waivers' AND payload ? 'roster_actions';
DELETE FROM public.league_events WHERE kind IN('work.succeeded','work.dead') AND detail->>'key' IN(SELECT key FROM ra_http_work);
DELETE FROM public.sync_runs WHERE id IN(SELECT sync_run_id FROM public.edge_invocations WHERE invocation_key IN(SELECT invocation_key FROM ra_http_work));
DELETE FROM public.edge_invocations WHERE invocation_key IN(SELECT invocation_key FROM ra_http_work);
DELETE FROM private.work_items WHERE id IN(SELECT id FROM ra_http_work);
CREATE TEMP TABLE ra_http_users AS SELECT id FROM auth.users WHERE email LIKE 'roster-http-%@example.test';
DELETE FROM private.request_receipts WHERE actor IN(SELECT id FROM ra_http_users);
DELETE FROM public.leagues WHERE commissioner_id IN(SELECT id FROM ra_http_users) AND name IN('Roster HTTP cost','HTTP invite');
DELETE FROM public.players WHERE first_name='Roster HTTP' AND last_name ~ '^[0-8]$' AND nba_id IS NULL;
DELETE FROM public.season_weeks WHERE season_year=9882;
DELETE FROM auth.users WHERE id IN(SELECT id FROM ra_http_users);
COMMIT;
