\set ON_ERROR_STOP on
BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE screen_cost_fixture AS SELECT fixture.*,gen_random_uuid() AS player_id FROM pg_temp.rules_fixture(3,public.current_season_year_et()) fixture;
CREATE TEMP TABLE screen_cost_foreign AS SELECT * FROM pg_temp.rules_fixture(2,public.current_season_year_et());
INSERT INTO public.players(id,first_name,last_name) SELECT player_id,'Screen','Authorization' FROM screen_cost_fixture;
GRANT SELECT ON screen_cost_fixture,screen_cost_foreign TO authenticated;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; foreign_scope record; screen text; member integer; params jsonb; result jsonb;
BEGIN
  SELECT * INTO f FROM screen_cost_fixture;
  SELECT * INTO foreign_scope FROM screen_cost_foreign;
  params:=jsonb_build_object('playerId',f.player_id);
  FOREACH screen IN ARRAY ARRAY['view_players','view_trades','view_trade_block','view_player','view_home'] LOOP
    FOR member IN 1..3 LOOP
      PERFORM set_config('request.jwt.claim.sub',f.user_ids[member]::text,true);
      EXECUTE format('SELECT public.%I(%L,%L,%L::jsonb)',screen,f.league_id,f.member_ids[member],params) INTO result;
      PERFORM pg_temp.check_rules(result#>>'{context,memberId}'=f.member_ids[member]::text,screen||' validates manager '||member);
    END LOOP;
    PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
    PERFORM pg_temp.reject_rules(format('SELECT public.%I(%L,%L,%L::jsonb)',screen,f.league_id,f.member_ids[2],params),
      'This screen is not available.',screen||' rejects another manager identity');
    PERFORM pg_temp.reject_rules(format('SELECT public.%I(%L,%L,%L::jsonb)',screen,foreign_scope.league_id,f.member_ids[1],params),
      'This screen is not available.',screen||' rejects a foreign league');
    PERFORM pg_temp.reject_rules(format('SELECT public.%I(%L,%L,%L::jsonb)',screen,f.league_id,f.member_ids[1],params||jsonb_build_object('seasonId',foreign_scope.season_id)),
      'This season is not available.',screen||' rejects a foreign season');
    PERFORM pg_temp.reject_rules(format('SELECT public.%I(%L,%L,%L::jsonb)',screen,f.league_id,f.member_ids[1],'[]'),
      'View parameters must be an object.',screen||' rejects malformed parameters');
    PERFORM set_config('request.jwt.claim.sub','',true);
    PERFORM pg_temp.reject_rules(format('SELECT public.%I(%L,%L,%L::jsonb)',screen,f.league_id,f.member_ids[1],params),
      'This screen is not available.',screen||' rejects a missing identity');
  END LOOP;
END;
$$;
RESET ROLE;
UPDATE public.leagues SET deleted_at=now() WHERE id=(SELECT league_id FROM screen_cost_fixture);
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; screen text;
BEGIN
  SELECT * INTO f FROM screen_cost_fixture;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  FOREACH screen IN ARRAY ARRAY['view_players','view_trades','view_trade_block','view_player','view_home'] LOOP
    PERFORM pg_temp.reject_rules(format('SELECT public.%I(%L,%L,%L::jsonb)',screen,f.league_id,f.member_ids[1],jsonb_build_object('playerId',f.player_id)),
      'This screen is not available.',screen||' rejects a deleted league');
  END LOOP;
END;
$$;
RESET ROLE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
