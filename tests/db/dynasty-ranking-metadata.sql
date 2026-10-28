BEGIN;

CREATE TEMP TABLE ranking_before AS TABLE public.dynasty_rankings;

DO $$
DECLARE result jsonb;
BEGIN
  SELECT public.replace_dynasty_rankings('retired-metadata-probe',now(),
    jsonb_build_array(jsonb_build_object('source_rank',1,'source_player_name','Retired Player')),
    1,'points','https://example.test/retired',jsonb_build_array('obsolete')) INTO result;
  IF result IS DISTINCT FROM '{"retired":true,"source":"onenumberhoops.com"}'::jsonb THEN
    RAISE EXCEPTION 'Retired ranking writer must return its retirement result';
  END IF;
  IF EXISTS((SELECT * FROM public.dynasty_rankings EXCEPT SELECT * FROM ranking_before)
    UNION ALL (SELECT * FROM ranking_before EXCEPT SELECT * FROM public.dynasty_rankings)) THEN
    RAISE EXCEPTION 'Retired ranking writer must preserve every row';
  END IF;
END;
$$;

ROLLBACK;
