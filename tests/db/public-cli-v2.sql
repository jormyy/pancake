BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE public_v2_fixture AS SELECT * FROM pg_temp.rules_fixture(2,2037);
SET LOCAL session_replication_role=replica;
DO $$
DECLARE
  league uuid; season uuid; members uuid[]; player uuid:=gen_random_uuid();
  trade uuid:=gen_random_uuid(); hidden uuid:=gen_random_uuid(); token_key text:=repeat('a',64);
  before_rows jsonb; after_rows jsonb; state text; source text; resource text;
BEGIN
  SELECT league_id,season_id,member_ids INTO league,season,members FROM public_v2_fixture;
  PERFORM pg_temp.check_rules(NOT has_function_privilege('anon','public.public_read_v2(uuid,text,jsonb,text)','EXECUTE'),'anonymous RPC denied');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.public_read_v2(uuid,text,jsonb,text)','EXECUTE'),'account RPC denied');
  PERFORM pg_temp.check_rules(has_function_privilege('service_role','public.public_read_v2(uuid,text,jsonb,text)','EXECUTE'),'service RPC allowed');
  PERFORM pg_temp.check_rules(NOT has_table_privilege('anon','private.public_api_buckets','SELECT'),'rate records private');
  SELECT pg_get_functiondef('public.public_read_v2(uuid,text,jsonb,text)'::regprocedure) INTO source;
  PERFORM pg_temp.check_rules(source NOT LIKE '%request.jwt%' AND source NOT LIKE '%public.view_%' AND source NOT LIKE '%auth.uid%','no member impersonation or screen calls');
  INSERT INTO public.players(id,first_name,last_name) VALUES(player,'Public','Fixture');
  INSERT INTO public.trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,status,accepted_at,completed_at)
    VALUES(trade,league,season,members[1],members[2],'completed',now(),now());
  before_rows:=public.public_read_v2(league,'trades','{}',token_key);
  PERFORM pg_temp.check_rules((before_rows->>'status')::integer=200 AND jsonb_array_length(before_rows->'items')=1,'completed trade visible');
  FOREACH state IN ARRAY ARRAY['pending','accepted','rejected','vetoed','expired'] LOOP
    INSERT INTO public.trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,status,notes)
      VALUES(hidden,league,season,members[1],members[2],state::public.trade_status,'PRIVATE_SENTINEL');
    after_rows:=public.public_read_v2(league,'trades','{}',token_key);
    PERFORM pg_temp.check_rules(after_rows=before_rows,'hidden trade state invariant '||state);
    after_rows:=public.public_read_v2(league,'trades',jsonb_build_object('trade',hidden),token_key);
    PERFORM pg_temp.check_rules(after_rows=public.public_read_v2(league,'trades',jsonb_build_object('trade',gen_random_uuid()),token_key),'private trade probe invariant '||state);
    DELETE FROM public.trades WHERE id=hidden;
  END LOOP;
  INSERT INTO public.waiver_claims(league_id,league_season_id,member_id,player_id,status,priority_at_submission,process_date)
    VALUES(league,season,members[1],player,'pending',1,current_date);
  FOREACH resource IN ARRAY ARRAY['leagues','league','seasons','teams','rosters','players','player-stats','projections','free-agents','standings','matchups','scores','schedule','drafts','draft-results','picks','trades','trade-assets','transactions'] LOOP
    IF resource<>'leagues' THEN
      after_rows:=public.public_read_v2(league,resource,CASE WHEN resource='rosters' THEN jsonb_build_object('team',members[1]) ELSE '{}' END,encode(extensions.digest(resource,'sha256'),'hex'));
    ELSE
      after_rows:=public.public_read_v2(NULL,resource,'{}',encode(extensions.digest(resource,'sha256'),'hex'));
    END IF;
    PERFORM pg_temp.check_rules((after_rows->>'status')::integer=200,'resource reads '||resource);
    PERFORM pg_temp.check_rules(after_rows::text NOT LIKE '%PRIVATE_SENTINEL%' AND after_rows::text NOT LIKE '%user_id%' AND after_rows::text NOT LIKE '%bid_amount%','private fields absent '||resource);
  END LOOP;
END;
$$;
SELECT label FROM rules_checks ORDER BY label;
ROLLBACK;
