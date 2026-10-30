BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; other record; before_version bigint; claims jsonb; claim jsonb; completed jsonb; cursor_id uuid;
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
  PERFORM pg_temp.check_rules(NOT claim ? 'trades','screen work contains no trade batch');
  completed:=public.view_refresh_work(f.league_id,NULL,jsonb_build_object('operation','complete','seasonId',f.season_id,
    'version',claim->'version','claimToken',claim->'claimToken'));
  PERFORM pg_temp.check_rules(completed='true','closed trades never hold the screen queue open');
  PERFORM private.refresh_queue_trade_revaluations(f.season_id,(claim->>'version')::bigint,'fixture');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-revaluation' AND league_id=f.league_id),
    'closed trades create no valuation work');
  INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id,status)
    SELECT f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'pending' FROM generate_series(1,21);
  PERFORM private.refresh_queue_trade_revaluations(f.season_id,(claim->>'version')::bigint,'fixture');
  PERFORM pg_temp.check_rules((SELECT count(*)=21 FROM private.work_items WHERE kind='trade-revaluation' AND league_id=f.league_id),
    'one league scan queues every changed open trade');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-revaluation-check' AND league_id=f.league_id),
    'one league scan creates no independent input checks');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-revaluation-scan' AND payload ? 'after' AND league_id=f.league_id),
    'one league scan needs no continuation');
  SELECT id INTO cursor_id FROM public.trades WHERE league_season_id=f.season_id AND status='pending' ORDER BY id LIMIT 1;
  PERFORM private.refresh_queue_trade_revaluations(f.season_id,(claim->>'version')::bigint,'fixture',cursor_id);
  PERFORM pg_temp.check_rules((SELECT count(*)=21 FROM private.work_items WHERE kind='trade-revaluation' AND league_id=f.league_id),
    'a legacy continuation reuses the existing valuation keys');
END;
$$;
DELETE FROM private.work_items;
SELECT private.work_enqueue(kind,'concurrency-fixture-'||kind) FROM private.work_kinds;
SELECT pg_temp.check_rules((SELECT count(*)=4 FROM private.work_claim(64)),'dispatcher claims at most four concurrent workers');
SELECT pg_temp.check_rules((SELECT count(*)=0 FROM private.work_claim(64)),'dispatcher keeps queued work when all slots are occupied');
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
