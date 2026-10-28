BEGIN;
\ir rules-support.sql
DO $$
DECLARE fixture record; v_player_id uuid; value_row record; profile jsonb; v_pick_id uuid; v_trade_id uuid; v_draft_id uuid; inputs jsonb;
BEGIN
  SELECT * INTO fixture FROM pg_temp.rules_fixture(2,2027,'active');
  SELECT ranking.player_id INTO v_player_id FROM public.dynasty_rankings ranking
    WHERE source='onenumberhoops.com' AND source_player_id='victorwembanyama';
  PERFORM pg_temp.check_rules(v_player_id IS NOT NULL,'recorded source player is matched');
  INSERT INTO public.dynasty_rankings(source,source_rank,source_player_name,player_id,fetched_at)
    VALUES('hashtagbasketball.com',9001,'Legacy Wembanyama',v_player_id,now()+interval '1 day');
  PERFORM set_config('request.jwt.claim.sub',fixture.user_ids[1]::text,true);
  SELECT * INTO value_row FROM public.get_dynasty_forecast_inputs(fixture.league_id,fixture.member_ids[1],2027,ARRAY[v_player_id],'',1,0);
  PERFORM pg_temp.check_rules(value_row.ranking_source='hashtagbasketball.com' AND value_row.five_year_rank=9001 AND value_row.trade_value IS NULL,
    'ranking reader uses Hashtag while both sources exist');
  profile:=public.view_player(fixture.league_id,fixture.member_ids[1],jsonb_build_object('playerId',v_player_id));
  PERFORM pg_temp.check_rules(NOT (profile->'player' ? 'trade_value'),'profile does not show trade calculator values');
  INSERT INTO public.draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES(fixture.league_id,2028,1,fixture.member_ids[1],fixture.member_ids[1]) RETURNING id INTO v_pick_id;
  INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id,status)
    VALUES(fixture.league_id,fixture.season_id,fixture.member_ids[1],fixture.member_ids[2],'pending') RETURNING id INTO v_trade_id;
  INSERT INTO public.trade_items(trade_id,side,pick_id,from_member_id,to_member_id)
    VALUES(v_trade_id,'proposer',v_pick_id,fixture.member_ids[1],fixture.member_ids[2]);
  profile:=public.view_trade_details(fixture.league_id,fixture.member_ids[1],jsonb_build_object('tradeId',v_trade_id,'includeRosterPreview',false));
  PERFORM pg_temp.check_rules((profile->'trade'->'routedItems'->0->>'tradeValue')::numeric=496.7,'unknown pick slot uses the stored middle tier');
  UPDATE public.draft_picks SET predicted_trade_value=623.4,
    predicted_value_bands='{"early":750.1,"mid":496.7,"late":391.4}',
    predicted_tier_odds='{"early":0.5,"mid":0.5,"late":0}' WHERE id=v_pick_id;
  profile:=public.view_trade_details(fixture.league_id,fixture.member_ids[1],jsonb_build_object('tradeId',v_trade_id,'includeRosterPreview',false));
  PERFORM pg_temp.check_rules((profile->'trade'->'routedItems'->0->>'tradeValue')::numeric=623.4,'trade detail reads the predicted pick blend');
  inputs:=private.build_trade_estimate_inputs(fixture.user_ids[1],fixture.member_ids[1],jsonb_build_array(jsonb_build_object(
    'fromMemberId',fixture.member_ids[1],'toMemberId',fixture.member_ids[2],'pickId',v_pick_id)),false);
  PERFORM pg_temp.check_rules((inputs->'picks'->0->'valueBands'->>'mid')::numeric=623.4,'live estimate freezes the predicted pick blend');
  inputs:=public.get_trade_estimate_reanalysis_inputs(v_trade_id,'pick-reader-fixture');
  PERFORM pg_temp.check_rules((inputs->'picks'->0->'valueBands'->>'mid')::numeric=623.4,'historical re-analysis freezes the predicted pick blend');
  UPDATE public.draft_picks SET predicted_trade_value=NULL,predicted_value_bands=NULL,predicted_tier_odds=NULL WHERE id=v_pick_id;
  INSERT INTO public.drafts(league_id,league_season_id) VALUES(fixture.league_id,fixture.season_id) RETURNING id INTO v_draft_id;
  INSERT INTO public.snake_draft_picks(draft_id,draft_pick_id,member_id,overall_pick,pick_in_round,round)
    VALUES(v_draft_id,v_pick_id,fixture.member_ids[1],1,1,1);
  profile:=public.view_trade_details(fixture.league_id,fixture.member_ids[1],jsonb_build_object('tradeId',v_trade_id,'includeRosterPreview',false));
  PERFORM pg_temp.check_rules((profile->'trade'->'routedItems'->0->>'tradeValue')::numeric=750.1,'known pick slot uses the stored early tier');
  DELETE FROM public.dynasty_rankings ranking WHERE ranking.source='onenumberhoops.com' AND ranking.player_id=v_player_id;
  SELECT * INTO value_row FROM public.get_dynasty_forecast_inputs(fixture.league_id,fixture.member_ids[1],2027,ARRAY[v_player_id],'',1,0);
  PERFORM pg_temp.check_rules(value_row.ranking_source='hashtagbasketball.com' AND value_row.five_year_rank=9001
    AND value_row.trade_value IS NULL,'removing trade values leaves the Hashtag ranking intact');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
