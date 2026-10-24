BEGIN;
\ir rules-support.sql

DO $$
DECLARE
  v_fixture record;
  v_seeded jsonb;
BEGIN
  SELECT * INTO v_fixture FROM pg_temp.rules_fixture(2, 9370, 'setup');
  PERFORM set_config('request.jwt.claim.sub', v_fixture.user_ids[1]::text, true);
  SELECT scoring_settings INTO v_seeded FROM public.leagues WHERE id = v_fixture.league_id;
  PERFORM pg_temp.check_rules(v_seeded @> '{"double_double":1.5,"triple_double":3}', 'seeded bonus defaults');
  PERFORM public.update_league_settings_atomic(v_fixture.league_id, '{"scoring_settings":{"points":2}}');
  PERFORM pg_temp.check_rules((SELECT scoring_settings = v_seeded || '{"points":2}'::jsonb
    FROM public.leagues WHERE id = v_fixture.league_id), 'partial scoring save preserves both bonuses');
  PERFORM public.update_league_settings_atomic(v_fixture.league_id, '{"scoring_settings":{"double_double":0,"triple_double":4}}');
  PERFORM pg_temp.check_rules((SELECT scoring_settings = v_seeded || '{"points":2,"double_double":0,"triple_double":4}'::jsonb
    FROM public.leagues WHERE id = v_fixture.league_id), 'bonus edits preserve all other weights');
  PERFORM public.update_league_settings_atomic(v_fixture.league_id, '{"weekly_add_limit":3}');
  PERFORM pg_temp.check_rules((SELECT scoring_settings = v_seeded || '{"points":2,"double_double":0,"triple_double":4}'::jsonb
    FROM public.leagues WHERE id = v_fixture.league_id), 'unrelated save preserves scoring');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
