\o /dev/null
SET pg_stat_statements.track = 'all';
SELECT pg_stat_statements_reset();
BEGIN;
SET LOCAL app.supabase_url = 'http://127.0.0.1:1';
SET LOCAL app.edge_internal_token = 'synthetic-local-load-token';
SELECT public.invoke_live_poll_if_due() FROM generate_series(1,60);
SELECT public.invoke_close_expired_nominations_if_due() FROM generate_series(1,60);
SELECT public.invoke_stats_sync_dispatch_if_due() FROM generate_series(1,60);
SELECT private.reconcile_edge_invocations() FROM generate_series(1,12);
SELECT public.invoke_edge_function('load-fixture') FROM generate_series(1,10);
WITH rows AS (SELECT ctid FROM net._http_response WHERE created<now()-interval '6 hours' ORDER BY created LIMIT 1000)
DELETE FROM net._http_response WHERE ctid IN (SELECT ctid FROM rows);
UPDATE analytics.search_cache_refresh_state SET refreshed_at=now()-interval '8 days';
SELECT public.refresh_player_search_caches();
SELECT set_config('request.jwt.claim.sub','db000000-0000-4000-8000-000000000001',true);
SELECT count(*) FROM generate_series(0,9) n CROSS JOIN LATERAL public.search_players(p_league_id=>'db100000-0000-4000-8000-000000000001',p_offset=>n*20) visible;
INSERT INTO public.nba_games(id,nba_game_id,season_year,game_date,week_number,home_team,away_team,status,game_time)
VALUES ('db300000-0000-4000-8000-000000009999','002load-live',public.current_season_year_et(),(now() AT TIME ZONE 'America/New_York')::date,1,'LDB','OPP','InProgress',now()-interval '1 hour');
INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,rebounds,assists,minutes_played)
SELECT id,'db300000-0000-4000-8000-000000009999',public.current_season_year_et(),1,20,5,5,15
FROM public.players WHERE id::text LIKE 'db200000-%' ORDER BY id LIMIT 30;
UPDATE public.player_game_stats SET points=21 WHERE game_id='db300000-0000-4000-8000-000000009999';
SELECT public.invoke_live_poll_if_due() FROM generate_series(1,20);
SELECT 'SELECT private.flush_player_stats_hints();' WHERE to_regprocedure('private.flush_player_stats_hints()') IS NOT NULL \gexec
ROLLBACK;
\o
COPY (SELECT calls,round(total_exec_time::numeric,3) AS total_ms,round(mean_exec_time::numeric,3) AS mean_ms,rows,query
FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query NOT LIKE '%pg_stat_statements%'
ORDER BY total_exec_time DESC) TO STDOUT WITH CSV HEADER;
