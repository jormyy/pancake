BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; other record; before_version bigint; claims jsonb; claim jsonb; values_batch jsonb; completed jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9592);
  SELECT * INTO other FROM pg_temp.rules_fixture(2,9593);
  UPDATE private.screen_refresh_queue SET dirty=false,claimed_at=NULL,claim_token=NULL;
  PERFORM private.refresh_queue_screen_views(f.league_id);
  SELECT version INTO before_version FROM private.screen_refresh_queue WHERE league_season_id=f.season_id;
  PERFORM private.refresh_queue_screen_views(f.league_id);
  PERFORM pg_temp.check_rules((SELECT version=before_version FROM private.screen_refresh_queue WHERE league_season_id=f.season_id),'unclaimed dirty changes coalesce');
  PERFORM private.refresh_queue_screen_views(other.league_id);
  claims:=public.view_refresh_work(p_params=>' {"operation":"claim","limit":10}'::jsonb);
  PERFORM pg_temp.check_rules(jsonb_array_length(claims)=1,'one run claims at most one season');
  UPDATE private.screen_refresh_queue SET dirty=(league_season_id=f.season_id),claimed_at=NULL,claim_token=NULL;
  INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id,status)
    SELECT f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'withdrawn' FROM generate_series(1,21);
  claims:=public.view_refresh_work(); claim:=claims->0;
  PERFORM pg_temp.check_rules(jsonb_array_length(claim->'trades')=20,'valuation work is capped at twenty trades');
  SELECT jsonb_agg(jsonb_build_object('tradeId',item->>'tradeId','revaluation','{}'::jsonb)) INTO values_batch FROM jsonb_array_elements(claim->'trades') item;
  completed:=public.view_refresh_work(f.league_id,NULL,jsonb_build_object('operation','complete','seasonId',f.season_id,'version',claim->'version','claimToken',claim->'claimToken','tradeValues',values_batch));
  PERFORM pg_temp.check_rules(completed='false','partial valuation publication keeps continuation work');
  UPDATE private.screen_refresh_queue SET available_at=now()-interval '1 second' WHERE league_season_id=f.season_id;
  claim:=public.view_refresh_work()->0;
  PERFORM pg_temp.check_rules(jsonb_array_length(claim->'trades')=1,'continuation reads only the remaining trade');
  SELECT jsonb_agg(jsonb_build_object('tradeId',item->>'tradeId','revaluation','{}'::jsonb)) INTO values_batch FROM jsonb_array_elements(claim->'trades') item;
  completed:=public.view_refresh_work(f.league_id,NULL,jsonb_build_object('operation','complete','seasonId',f.season_id,'version',claim->'version','claimToken',claim->'claimToken','tradeValues',values_batch));
  PERFORM pg_temp.check_rules(completed='true','complete valuation publication clears the queue');
END;
$$;
DELETE FROM private.work_items;
SELECT private.work_enqueue(kind,'concurrency-fixture-'||kind) FROM private.work_kinds;
SELECT pg_temp.check_rules((SELECT count(*)=8 FROM private.work_claim(64)),'dispatcher claims at most eight concurrent workers');
SELECT pg_temp.check_rules((SELECT count(*)=0 FROM private.work_claim(64)),'dispatcher keeps queued work when all slots are occupied');
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
