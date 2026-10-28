\set ON_ERROR_STOP on
BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; ids uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()]; actual uuid[]; payload jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, public.current_season_year_et());
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,dynasty_rank)
    VALUES (ids[1],'Z','Rank one','PG',ARRAY['PG'],1),(ids[2],'A','Rank two','PG',ARRAY['PG'],2),
      (ids[3],'A','Unranked low','PG',ARRAY['PG'],NULL),(ids[4],'B','Unranked high','PG',ARRAY['PG'],NULL),
      (ids[5],'C','Unranked tie','PG',ARRAY['PG'],NULL),(ids[6],'D','No average','PG',ARRAY['PG'],NULL);
  INSERT INTO public.player_season_averages(league_id,league_season_id,player_id,season_year,averages,avg_fantasy_points,version)
    SELECT f.league_id, f.season_id, ids[n], public.current_season_year_et(), '{"games_played":1}', fp, 1
    FROM (VALUES (1,0),(2,100),(3,-2),(4,40),(5,40)) row(n,fp);
  SELECT array_agg(id) INTO actual FROM public.view_player_search(p_league_id=>f.league_id,p_include_player_ids=>ids,p_season_year=>public.current_season_year_et(),p_sort_by=>'dynasty');
  PERFORM pg_temp.check_rules(actual = ARRAY[ids[1],ids[2],ids[4],ids[5],ids[3],ids[6]], 'ranks precede season averages and stable name ties');
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  payload := public.view_players(f.league_id,f.member_ids[1],jsonb_build_object('includePlayerIds',to_jsonb(ids),'sortBy','dynasty','seasonYear',public.current_season_year_et()));
  SELECT array_agg((value->>'id')::uuid) INTO actual FROM jsonb_array_elements(payload->'players');
  PERFORM pg_temp.check_rules(actual = ARRAY[ids[1],ids[2],ids[4],ids[5],ids[3],ids[6]], 'screen view retains dynasty order');
  PERFORM pg_temp.check_rules(payload->'players'->0->>'dynasty_rank' = '1' AND payload->'players'->1->>'dynasty_rank' = '2', 'screen view includes ranks for stable client ordering');
  SELECT array_agg(id) INTO actual FROM public.view_player_search(p_league_id=>f.league_id,p_include_player_ids=>ids,p_season_year=>public.current_season_year_et(),p_sort_by=>'dynasty',p_sort_dir=>'asc',p_limit=>2,p_offset=>2);
  PERFORM pg_temp.check_rules(actual = ARRAY[ids[4],ids[5]], 'dynasty pagination and direction retain ranked-first order');
END $$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
