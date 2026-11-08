BEGIN;
\ir rules-support.sql
SET LOCAL session_replication_role=replica;
CREATE TEMP TABLE projection_fixture AS SELECT * FROM pg_temp.rules_fixture(2,2037);
INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
VALUES(2037,1,current_date-3,current_date+3) ON CONFLICT DO NOTHING;
INSERT INTO public.players(id,first_name,last_name,nba_team)
SELECT md5('public-projection-test-'||i)::uuid,'Projection',lpad(i::text,4,'0'),'BOS'
FROM generate_series(1,1206) i;
INSERT INTO public.player_projections(player_id,season_year,week_number,projected_points,projected_stat_points,projected_minutes,fetched_at)
SELECT md5('public-projection-test-'||i)::uuid,2037,1,i,i,30,now()
FROM generate_series(1,1205) i;
DO $$
DECLARE f record; got jsonb; expected jsonb; sampled uuid[];
BEGIN
  SELECT * INTO f FROM projection_fixture;
  PERFORM pg_temp.check_rules(NOT has_function_privilege('anon','private.public_projection_rows(uuid,integer,date)','EXECUTE') AND NOT has_function_privilege('authenticated','private.public_projection_rows(uuid,integer,date)','EXECUTE'),'unpaged projection helper is private');
  PERFORM pg_temp.check_rules(has_function_privilege('service_role','private.public_projection_rows(uuid,integer,date)','EXECUTE'),'service role can use projection helper');
  SELECT array_agg(md5('public-projection-test-'||i)::uuid) INTO sampled FROM generate_series(1186,1206) i;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.player_id) INTO expected
  FROM unnest(sampled) id CROSS JOIN LATERAL public.get_league_projection_rows(f.league_id,2037,current_date,'today',ARRAY[id],1,0) p;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.player_id) INTO got
  FROM private.public_projection_rows(f.league_id,2037,current_date) p WHERE p.player_id=ANY(sampled);
  PERFORM pg_temp.check_rules(got=expected,'set-wise rows retain existing projection values and null behavior');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM private.public_projection_rows(f.league_id,2037,current_date))=1205,'projection helper retains more than one thousand results');
  got:=public.public_read_v2(f.league_id,'projections',jsonb_build_object('query','Projection','sort','points','direction','desc','limit',1),repeat('a',64));
  PERFORM pg_temp.check_rules(got->'items'->0->>'id'=md5('public-projection-test-1205')::uuid::text AND (got->>'hasMore')::boolean,'projection sorting happens across the complete set before pagination');
  got:=public.public_read_v2(f.league_id,'projections',jsonb_build_object('player',md5('public-projection-test-1206')::uuid),repeat('a',64));
  PERFORM pg_temp.check_rules(jsonb_array_length(got->'items')=1 AND got->'items'->0->'points'='null'::jsonb,'players without projections remain visible');
  got:=public.public_read_v2(f.league_id,'projections',jsonb_build_object('query','Projection','sort','points','direction','desc','limit',1,'offset',1205),repeat('a',64));
  PERFORM pg_temp.check_rules(got->'items'->0->>'id'=md5('public-projection-test-1206')::uuid::text AND NOT (got->>'hasMore')::boolean,'last page retains null projections and exact hasMore');
END $$;
SELECT label FROM rules_checks ORDER BY label;
ROLLBACK;
