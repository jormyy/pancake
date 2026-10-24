BEGIN;
DO $$
DECLARE v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['public.counter_trade_atomic','public.counter_multi_team_trade_atomic',
    'public.edit_trade_atomic','public.edit_multi_team_trade_atomic','private.ensure_season_faab_balances',
    'private.invalidate_player_search_cache'] LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=v_name) THEN
      RAISE EXCEPTION 'Retired function remains: %',v_name;
    END IF;
  END LOOP;
  IF to_regclass('analytics.search_cache_source_state') IS NOT NULL THEN
    RAISE EXCEPTION 'Retired search cache source state remains';
  END IF;
  IF to_regprocedure('public.refresh_player_search_caches()') IS NULL
    OR to_regprocedure('analytics.seed_league_fantasy_avgs(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Release compatibility routines are missing';
  END IF;
END $$;
ROLLBACK;
