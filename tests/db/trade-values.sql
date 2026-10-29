BEGIN;
\ir rules-support.sql
\ir trade-values-fixture.sql
DO $$
DECLARE rows jsonb; picks jsonb; fetched timestamptz; snapshot_hash text; outcome jsonb; failed boolean;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('source_id',source_player_id,'name',source_player_name,'team',source_team,
    'positions',source_positions,'rank',source_rank,'value',trade_value,'age',age,'player_id',player_id,
    'reason','fixture','candidate_ids','[]'::jsonb)) INTO rows
    FROM public.dynasty_rankings WHERE source='onenumberhoops.com';
  SELECT jsonb_agg(jsonb_build_object('year',draft_year,'round',round,'tier',tier,'value',trade_value)) INTO picks
    FROM public.dynasty_pick_values WHERE round IN(1,2);
  SELECT fetched_at,content_sha256 INTO fetched,snapshot_hash FROM private.trade_value_sync_state WHERE id;
  PERFORM pg_temp.check_rules(jsonb_array_length(rows)=450,'all 450 players are stored');
  PERFORM pg_temp.check_rules(jsonb_array_length(picks)=18,'all 18 source picks are stored');
  PERFORM pg_temp.check_rules((SELECT count(*)=9 FROM public.dynasty_pick_values WHERE derived),'nine third-round bases exist');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.dynasty_pick_values third
    JOIN public.dynasty_pick_values second ON second.draft_year=third.draft_year AND second.tier=third.tier AND second.round=2
    WHERE third.round=3 AND third.trade_value<>round(second.trade_value*0.4,2)),'third-round bases are forty percent');
  failed:=false;
  BEGIN
    PERFORM public.publish_trade_values(rows-0,picks,'broken',clock_timestamp(),'json');
  EXCEPTION WHEN SQLSTATE '22023' THEN failed:=true;
  END;
  PERFORM pg_temp.check_rules(failed,'partial snapshots fail');
  failed:=false;
  BEGIN
    PERFORM public.publish_trade_values(jsonb_set(rows,'{0,value}','-1'),picks,'broken',clock_timestamp(),'json');
  EXCEPTION WHEN SQLSTATE '22023' THEN failed:=true;
  END;
  PERFORM pg_temp.check_rules(failed,'invalid values fail');
  failed:=false;
  BEGIN
    PERFORM public.publish_trade_values(rows,picks,'unclaimed',clock_timestamp(),'live');
  EXCEPTION WHEN SQLSTATE '40001' THEN failed:=true;
  END;
  PERFORM pg_temp.check_rules(failed,'live publication requires its fetch claim');
  outcome:=public.publish_trade_values(rows,picks,'old',fetched-interval '1 second','json');
  PERFORM pg_temp.check_rules(outcome->>'stale'='true','older snapshots cannot replace current values');
  PERFORM pg_temp.check_rules((SELECT content_sha256=snapshot_hash FROM private.trade_value_sync_state WHERE id),'failed and old imports leave the cache unchanged');
  PERFORM set_config('request.headers',jsonb_build_object('x-pancake-work-key',gen_random_uuid())::text,true);
  failed:=false;
  BEGIN
    PERFORM public.claim_trade_value_sync(gen_random_uuid());
  EXCEPTION WHEN SQLSTATE 'PT409' THEN failed:=true;
  END;
  PERFORM set_config('request.headers','{}',true);
  PERFORM pg_temp.check_rules(failed,'expired workers cannot reserve a source fetch');
  UPDATE private.trade_value_sync_state SET request_id=NULL,last_request_at=NULL,fetched_at=clock_timestamp()-interval '1 day' WHERE id;
  PERFORM pg_temp.check_rules(public.claim_trade_value_sync(gen_random_uuid()),'first daily claim succeeds');
  PERFORM pg_temp.check_rules(NOT public.claim_trade_value_sync(gen_random_uuid()),'second daily claim is cached');
  UPDATE private.trade_value_sync_state SET last_request_at=clock_timestamp()-interval '1 day' WHERE id;
  PERFORM pg_temp.check_rules(public.claim_trade_value_sync(gen_random_uuid()),'the next calendar day can fetch');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.publish_trade_values(jsonb,jsonb,text,timestamptz,text,uuid)','EXECUTE'),'members cannot publish source snapshots');
  PERFORM pg_temp.check_rules(NOT has_table_privilege('anon','public.trade_value_reviews','SELECT'),'anonymous users cannot read the review list');
  DELETE FROM private.work_items WHERE kind='sync-trade-values';
  PERFORM private.enqueue_scheduled_work('2026-03-08 07:00 America/New_York');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='sync-trade-values'),'daily sync waits until seven fifteen ET');
  PERFORM private.enqueue_scheduled_work('2026-03-08 07:15 America/New_York');
  PERFORM private.enqueue_scheduled_work('2026-03-08 07:30 America/New_York');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE kind='sync-trade-values'),'daily sync is enqueued once across catch-up ticks');
  UPDATE private.work_items SET status='succeeded' WHERE kind='sync-trade-values';
  PERFORM private.enqueue_scheduled_work('2026-03-09 07:15 America/New_York');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM private.work_items WHERE kind='sync-trade-values'),'next daily sync is enqueued');
  UPDATE public.trade_value_reviews SET resolved_player_id=candidate_ids[1] WHERE source_id='alexcaruso';
  PERFORM public.publish_trade_values(rows,picks,'review-race-fixture',clock_timestamp(),'json');
  PERFORM pg_temp.check_rules((SELECT player_id IS NOT NULL FROM public.dynasty_rankings
    WHERE source='onenumberhoops.com' AND source_player_id='alexcaruso'),'a stale worker match cannot erase a reviewed identity');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
