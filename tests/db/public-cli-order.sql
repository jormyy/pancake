BEGIN;
\ir rules-support.sql
SET LOCAL session_replication_role=replica;
CREATE TEMP TABLE sort_fixture AS SELECT * FROM pg_temp.rules_fixture(2,2037);
INSERT INTO public.players(id,first_name,last_name)
SELECT md5(i::text)::uuid,'Roster',i::text FROM generate_series(1,100) i;
INSERT INTO public.roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via)
SELECT md5(('r'||i)::text)::uuid,f.league_id,f.season_id,f.member_ids[1],md5(i::text)::uuid,'draft'
FROM sort_fixture f,generate_series(1,100) i;
DO $$
DECLARE f record; expected jsonb; actual jsonb; direction text;
BEGIN
  SELECT * INTO f FROM sort_fixture;
  SELECT jsonb_agg(id::text ORDER BY id) INTO expected FROM public.roster_players WHERE league_id=f.league_id;
  FOREACH direction IN ARRAY ARRAY['asc','desc'] LOOP
    SELECT jsonb_agg(page->'items'->0->>'id' ORDER BY page_index) INTO actual
    FROM generate_series(0,99) page_index
    CROSS JOIN LATERAL (SELECT public.public_read_v2(f.league_id,'rosters',jsonb_build_object('team',f.member_ids[1],'sort','isOnIR','direction',direction,'limit',1,'offset',page_index),repeat('a',64)) page) p;
    PERFORM pg_temp.check_rules(actual=expected,'tied roster pages use ascending IDs for '||direction);
    PERFORM pg_temp.check_rules(jsonb_array_length(actual)=100,'all tied roster rows remain reachable for '||direction);
  END LOOP;
END $$;
SELECT label FROM rules_checks ORDER BY label;
ROLLBACK;
