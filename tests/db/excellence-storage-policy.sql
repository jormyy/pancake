\set ON_ERROR_STOP on
\getenv excellence_port PANCAKE_TEST_DB_PORT
\if :{?excellence_port}
\else
  \set excellence_port 57422
\endif
SELECT :'HOST'='127.0.0.1' AND :'PORT'=:'excellence_port' AS correct_target \gset
\if :correct_target
\else
  DO $$ BEGIN RAISE EXCEPTION 'Use the assigned private database.'; END $$;
\endif
BEGIN;
DO $$
DECLARE target regclass; options text[];
BEGIN
  FOREACH target IN ARRAY ARRAY['public.sync_runs'::regclass,'public.weekly_lineups'::regclass,
    'public.standings_current'::regclass,'public.matchup_totals'::regclass,
    'public.player_season_averages'::regclass,'public.trade_value_cache'::regclass,
    'analytics.player_season_totals'::regclass] LOOP
    SELECT reloptions INTO options FROM pg_class WHERE oid=target;
    IF options IS NULL OR NOT options @> ARRAY['fillfactor=90','autovacuum_vacuum_threshold=50',
      'autovacuum_vacuum_scale_factor=0.02'] OR NOT options @>
      (CASE WHEN target=ANY(private.screen_statistics_targets())
        THEN ARRAY['autovacuum_analyze_threshold=25','autovacuum_analyze_scale_factor=0.02']
        ELSE ARRAY['autovacuum_analyze_threshold=50','autovacuum_analyze_scale_factor=0.05'] END) THEN
      RAISE EXCEPTION 'Missing churn policy for %',target;
    END IF;
  END LOOP;
END;
$$;
EXPLAIN (ANALYZE,BUFFERS) SELECT player_id,season_year,games_played,points
FROM analytics.player_season_totals ORDER BY player_id,season_year LIMIT 20;
ROLLBACK;
