\set ON_ERROR_STOP on
BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; trade_id uuid; rows jsonb; picks jsonb; revision text; fetched timestamptz:=now()-interval '1 minute';
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
  IF NOT private.begin_trade_revaluation(trade_id,'test') THEN RAISE EXCEPTION 'Successful delayed values must rearm nightly analysis'; END IF;
  IF NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-revaluation-scan' AND league_id=f.league_id
    AND payload->>'sourcePublication'='true' AND status='pending') THEN RAISE EXCEPTION 'Successful values must queue analysis'; END IF;
  revision:=private.trade_revaluation_input_version(trade_id);
  PERFORM private.refresh_trade_values(f.league_id,f.season_id,2,jsonb_build_array(jsonb_build_object(
    'tradeId',trade_id,'revaluation',jsonb_build_object('inputVersion',revision,'modelVersion','test'))));
  UPDATE private.work_items SET status='succeeded' WHERE kind='trade-revaluation-scan' AND league_id=f.league_id;
  PERFORM public.publish_trade_values(rows,picks,'round-four-second',fetched+interval '1 second','json');
  IF private.begin_trade_revaluation(trade_id,'test') THEN RAISE EXCEPTION 'A second publication must not add another daily analysis'; END IF;
  IF (SELECT count(*) FROM private.work_items WHERE kind='trade-revaluation-scan' AND league_id=f.league_id
    AND payload->>'sourcePublication'='true')<>1 THEN RAISE EXCEPTION 'Only one extra analysis is allowed each day'; END IF;
END $$;
ROLLBACK;
