BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE public_v2_fixture AS SELECT * FROM pg_temp.rules_fixture(2,2037);
SET LOCAL session_replication_role=replica;
DO $$
DECLARE
  league uuid; season uuid; members uuid[]; player uuid:=gen_random_uuid();
  trade uuid:=gen_random_uuid(); hidden uuid:=gen_random_uuid(); token_key text:=repeat('a',64);
  before_rows jsonb; after_rows jsonb; state text; source text; resource text; invalid_params jsonb; admission integer;
BEGIN
  SELECT league_id,season_id,member_ids INTO league,season,members FROM public_v2_fixture;
  PERFORM pg_temp.check_rules(NOT has_function_privilege('anon','public.public_read_v2(uuid,text,jsonb,text)','EXECUTE'),'anonymous RPC denied');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.public_read_v2(uuid,text,jsonb,text)','EXECUTE'),'account RPC denied');
  PERFORM pg_temp.check_rules(has_function_privilege('service_role','public.public_read_v2(uuid,text,jsonb,text)','EXECUTE'),'service RPC allowed');
  PERFORM pg_temp.check_rules(NOT has_table_privilege('anon','private.public_api_buckets','SELECT'),'rate records private');
  SELECT pg_get_functiondef('public.public_read_v2(uuid,text,jsonb,text)'::regprocedure) INTO source;
  PERFORM pg_temp.check_rules(source NOT LIKE '%request.jwt%' AND source NOT LIKE '%public.view_%' AND source NOT LIKE '%auth.uid%','no member impersonation or screen calls');
  PERFORM pg_temp.check_rules(source NOT LIKE '%public_api_buckets%' AND source NOT LIKE '%public_admit_read%','read transaction owns no rate-counter locks');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('anon','public.public_admit_read(text)','EXECUTE') AND NOT has_function_privilege('authenticated','public.public_admit_read(text)','EXECUTE'),'admission RPC remains private');
  FOR invalid_params IN SELECT value FROM jsonb_array_elements('[[],null,42,{"team":"bad"},{"player":true},{"draft":[]},{"trade":null},{"limit":"nope"},{"limit":{}},{"limit":0},{"limit":51},{"offset":-1},{"offset":"999999999999999999999999"},{"season":"bad"},{"week":61},{"query":[]},{"sort":false},{"direction":null}]'::jsonb) LOOP
    after_rows:=public.public_read_v2(league,'teams',invalid_params,token_key);
    PERFORM pg_temp.check_rules(after_rows=jsonb_build_object('status',400),'malformed parameters return fixed error '||invalid_params::text);
  END LOOP;
  FOR admission IN 1..60 LOOP
    PERFORM public.public_admit_read(encode(extensions.digest(league::text,'sha256'),'hex'));
  END LOOP;
  PERFORM pg_temp.check_rules(public.public_admit_read(encode(extensions.digest(league::text,'sha256'),'hex'))=jsonb_build_object('status',429,'retryAfter',60),'client quota rejects excess');
  PERFORM pg_temp.check_rules(public.public_admit_read(encode(extensions.digest(season::text,'sha256'),'hex'))=jsonb_build_object('status',200),'client quota does not exhaust another client');
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
  before_rows:=public.public_read_v2(league,'free-agents',jsonb_build_object('query','Public','limit',1,'sort','name'),token_key);
  INSERT INTO public.waiver_claims(league_id,league_season_id,member_id,player_id,status,priority_at_submission,process_date)
    VALUES(league,season,members[1],player,'pending',1,current_date);
  after_rows:=public.public_read_v2(league,'free-agents',jsonb_build_object('query','Public','limit',1,'sort','name'),token_key);
  PERFORM pg_temp.check_rules(after_rows=before_rows,'pending claim does not change free-agent page');
  UPDATE public.waiver_claims SET bid_amount=999999,claim_order=10 WHERE league_id=league;
  after_rows:=public.public_read_v2(league,'free-agents',jsonb_build_object('query','Public','limit',1,'sort','name'),token_key);
  PERFORM pg_temp.check_rules(after_rows=before_rows,'private bid and claim order do not change free-agent page');
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
