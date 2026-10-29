BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SET LOCAL search_path='';
DO $$
DECLARE target regclass;
BEGIN
  FOREACH target IN ARRAY ARRAY['public.sync_runs'::regclass,'public.weekly_lineups'::regclass,
    'public.standings_current'::regclass,'public.matchup_totals'::regclass,
    'public.player_season_averages'::regclass,'public.trade_value_cache'::regclass,
    'analytics.player_season_totals'::regclass] LOOP
    EXECUTE format('ALTER TABLE %s SET (fillfactor=90,autovacuum_vacuum_threshold=50,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_threshold=50,autovacuum_analyze_scale_factor=0.05)',target);
  END LOOP;
END;
$$;
COMMIT;
