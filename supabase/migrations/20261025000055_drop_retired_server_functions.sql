DROP FUNCTION IF EXISTS public.counter_trade_atomic(uuid,uuid,uuid,uuid[],uuid[],uuid[],uuid[],text,timestamptz,int,int);
DROP FUNCTION IF EXISTS public.counter_multi_team_trade_atomic(uuid,uuid,uuid,uuid[],jsonb,text,timestamptz);
DROP FUNCTION IF EXISTS public.edit_trade_atomic(uuid,uuid,uuid,uuid[],uuid[],uuid[],uuid[],text,timestamptz,int,int);
DROP FUNCTION IF EXISTS public.edit_multi_team_trade_atomic(uuid,uuid,uuid,uuid[],jsonb,text,timestamptz);
DROP FUNCTION IF EXISTS private.ensure_season_faab_balances(uuid,uuid);
DROP FUNCTION IF EXISTS private.invalidate_player_search_cache();
DROP TABLE IF EXISTS analytics.search_cache_source_state;
