\set ON_ERROR_STOP on
BEGIN;
\ir excellence-fixture.sql
DO $$
DECLARE owner_id uuid; league uuid; before_plan jsonb; after_plan jsonb; available jsonb; missing uuid;
BEGIN
  SELECT p.current_owner_id,p.league_id INTO STRICT owner_id,league FROM public.draft_picks p
  WHERE NOT p.is_used AND NOT EXISTS(SELECT FROM public.trade_items i JOIN public.trades t ON t.id=i.trade_id
    WHERE i.pick_id=p.id AND t.status IN ('pending','accepted'))
  GROUP BY p.current_owner_id,p.league_id HAVING max(p.season_year)=2030 AND bool_or(p.season_year=2028)
  ORDER BY p.current_owner_id LIMIT 1;
  EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT p.id FROM public.draft_picks p WHERE p.league_id=$1 AND p.season_year=2031 AND p.current_owner_id=$2 AND NOT p.is_used AND NOT EXISTS(SELECT FROM public.trade_items i JOIN public.trades t ON t.id=i.trade_id WHERE i.pick_id=p.id AND t.status IN (''pending'',''accepted'')) ORDER BY p.round LIMIT 1'
    INTO before_plan USING league,owner_id;
  SELECT p.id INTO missing FROM public.draft_picks p WHERE p.league_id=league AND p.season_year=2031 AND p.current_owner_id=owner_id AND NOT p.is_used;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'The old fourth-year lookup unexpectedly has an asset'; END IF;
  EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT coalesce(json_agg(json_build_object(''id'',p.id,''season_year'',p.season_year,''round'',p.round)),''[]'') FROM public.draft_picks p WHERE p.league_id=$1 AND p.current_owner_id=$2 AND NOT p.is_used AND NOT EXISTS(SELECT FROM public.trade_items i JOIN public.trades t ON t.id=i.trade_id WHERE i.pick_id=p.id AND t.status IN (''pending'',''accepted''))'
    INTO after_plan USING league,owner_id;
  SELECT jsonb_agg(jsonb_build_object('id',p.id,'season_year',p.season_year,'round',p.round)) INTO available FROM public.draft_picks p
    WHERE p.league_id=league AND p.current_owner_id=owner_id AND NOT p.is_used AND p.season_year>2027
      AND NOT EXISTS(SELECT FROM public.trade_items i JOIN public.trades t ON t.id=i.trade_id WHERE i.pick_id=p.id AND t.status IN ('pending','accepted'));
  IF coalesce(jsonb_array_length(available),0)=0 THEN RAISE EXCEPTION 'The corrected lookup lacks a real future asset'; END IF;
  RAISE NOTICE 'Before plan: %',before_plan;
  RAISE NOTICE 'After plan: %',after_plan;
END;
$$;
ROLLBACK;
