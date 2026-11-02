\set ON_ERROR_STOP on
BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; trade_id uuid; rows jsonb; picks jsonb; revision text; source_version text; rejected boolean:=false; fetched timestamptz:=now()-interval '1 minute';
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,2027);
  INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id)
    VALUES(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2]) RETURNING id INTO trade_id;
  revision:=private.trade_revaluation_input_version(trade_id);
  PERFORM private.refresh_trade_values(f.league_id,f.season_id,1,jsonb_build_array(jsonb_build_object(
    'tradeId',trade_id,'revaluation',jsonb_build_object('inputVersion',revision,'modelVersion','test'))));
  IF private.begin_trade_revaluation(trade_id,'test') THEN RAISE EXCEPTION 'Completed nightly analysis must wait'; END IF;
  SELECT jsonb_agg(jsonb_build_object('source_id','round-four-'||i,'name','Synthetic '||i,'team','BOS',
    'positions',jsonb_build_array('PG'),'rank',i,'value',10,'player_id',NULL,'reason','synthetic','candidate_ids','[]'::jsonb))
    INTO rows FROM generate_series(1,450) i;
  SELECT jsonb_agg(jsonb_build_object('year',year,'round',round,'tier',tier,'value',10)) INTO picks
    FROM generate_series(2027,2029) year CROSS JOIN generate_series(1,2) round CROSS JOIN unnest(ARRAY['early','mid','late']) tier;
  UPDATE private.trade_value_sync_state SET fetched_at=fetched-interval '1 day' WHERE id;
  PERFORM public.publish_trade_values(rows,picks,'round-four-first',fetched,'json');
  PERFORM pg_temp.check_rules(NOT private.begin_trade_revaluation(trade_id,'test'),'publication waits for matching pick predictions');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-revaluation-scan' AND payload->>'sourcePublication'='true'),'publication does not queue reanalysis early');
  SELECT content_sha256 INTO source_version FROM private.trade_value_sync_state WHERE id;
  INSERT INTO public.draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES(f.league_id,2028,1,f.member_ids[1],f.member_ids[1]) ON CONFLICT DO NOTHING;
  PERFORM pg_temp.check_rules(NOT public.complete_pick_prediction_refresh('old-source'),'old prediction source cannot rearm analysis');
  BEGIN
    PERFORM public.complete_pick_prediction_refresh(source_version);
  EXCEPTION WHEN SQLSTATE '40001' THEN rejected:=true;
  END;
  PERFORM pg_temp.check_rules(rejected,'incomplete predictions cannot rearm analysis');
  UPDATE public.draft_picks SET prediction_source_sha256=source_version;
  PERFORM pg_temp.check_rules(public.complete_pick_prediction_refresh(source_version),'matching predictions complete');
  IF NOT private.begin_trade_revaluation(trade_id,'test') THEN RAISE EXCEPTION 'Successful delayed values must rearm nightly analysis'; END IF;
  IF NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-revaluation-scan' AND league_id=f.league_id
    AND payload->>'sourcePublication'='true' AND status='pending') THEN RAISE EXCEPTION 'Successful values must queue analysis'; END IF;
  revision:=private.trade_revaluation_input_version(trade_id);
  PERFORM private.refresh_trade_values(f.league_id,f.season_id,2,jsonb_build_array(jsonb_build_object(
    'tradeId',trade_id,'revaluation',jsonb_build_object('inputVersion',revision,'modelVersion','test'))));
  UPDATE private.work_items SET status='succeeded' WHERE kind='trade-revaluation-scan' AND league_id=f.league_id;
  PERFORM public.publish_trade_values(rows,picks,'round-four-second',fetched+interval '1 second','json');
  PERFORM pg_temp.check_rules(NOT public.complete_pick_prediction_refresh(source_version),'prior completion cannot rearm a newer publication');
  SELECT content_sha256 INTO source_version FROM private.trade_value_sync_state WHERE id;
  UPDATE public.draft_picks SET prediction_source_sha256=source_version;
  PERFORM public.complete_pick_prediction_refresh(source_version);
  IF private.begin_trade_revaluation(trade_id,'test') THEN RAISE EXCEPTION 'A second publication must not add another daily analysis'; END IF;
  IF (SELECT count(*) FROM private.work_items WHERE kind='trade-revaluation-scan' AND league_id=f.league_id
    AND payload->>'sourcePublication'='true')<>1 THEN RAISE EXCEPTION 'Only one extra analysis is allowed each day'; END IF;
END $$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
