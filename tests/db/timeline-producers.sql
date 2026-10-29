BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE timeline_fixture AS SELECT * FROM pg_temp.rules_fixture(3,9573);
GRANT SELECT ON timeline_fixture TO authenticated;
DO $$
DECLARE f record; d record; a record; nomination public.nominations; trade uuid; draft uuid := gen_random_uuid(); player uuid := gen_random_uuid(); asset uuid; event_count bigint; mock uuid := gen_random_uuid();
BEGIN
  SELECT * INTO f FROM timeline_fixture;
  UPDATE public.leagues SET waiver_mode='faab' WHERE id=f.league_id;
  INSERT INTO public.faab_balances(league_id,league_season_id,member_id,balance)
    SELECT f.league_id,f.season_id,id,100 FROM unnest(f.member_ids) id
    ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;
  trade := public.propose_multi_team_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids,
    jsonb_build_array(jsonb_build_object('fromMemberId',f.member_ids[1],'toMemberId',f.member_ids[2],'faabAmount',1),
      jsonb_build_object('fromMemberId',f.member_ids[2],'toMemberId',f.member_ids[3],'faabAmount',1),
      jsonb_build_object('fromMemberId',f.member_ids[3],'toMemberId',f.member_ids[1],'faabAmount',1)),NULL,NULL);
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.league_events WHERE league_id=f.league_id AND kind='trade.sent'),'multi-team offer emits once');
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT jsonb_array_length(detail->'member_ids')=3 FROM public.league_events WHERE league_id=f.league_id AND kind='trade.sent'),'offer records all participants');
  PERFORM public.accept_trade_atomic(trade,f.member_ids[2]);
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.league_events WHERE league_id=f.league_id AND kind='trade.accepted'),'partial acceptance emits once');
  UPDATE public.trade_participants SET accepted_at=accepted_at WHERE trade_id=trade;
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.league_events WHERE league_id=f.league_id AND kind='trade.accepted'),'unchanged acceptance emits no duplicate');
  PERFORM public.accept_trade_atomic(trade,f.member_ids[3]);
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM public.league_events WHERE league_id=f.league_id AND kind='trade.accepted'),'final participant acceptance emits once');
  UPDATE public.trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=trade;
  PERFORM public.complete_accepted_trade_atomic(trade);
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT detail->'member_ids' @> to_jsonb(f.member_ids) FROM public.league_events WHERE league_id=f.league_id AND kind='trade.executed'),'execution retains historical participants');
  trade := public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'{}','{}','{}','{}',NULL,NULL,1,1);
  PERFORM public.accept_trade_atomic(trade,f.member_ids[2]);
  UPDATE public.trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=trade;
  PERFORM public.expire_trade_completion_failure_atomic(trade,'Receiving roster no longer fits.');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM public.update_league_settings_atomic(f.league_id,'{"weekly_add_limit":3}');
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.league_events WHERE league_id=f.league_id AND kind='settings.changed'
    AND detail->'changes'->'weekly_add_limit'->>'after'='3'),'settings RPC records changed value');
  SELECT count(*) INTO event_count FROM public.league_events WHERE league_id=f.league_id;
  PERFORM public.update_league_settings_atomic(f.league_id,'{"weekly_add_limit":3}');
  UPDATE public.leagues SET invite_code='ABCD1234ABCD1234' WHERE id=f.league_id;
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT count(*)=event_count FROM public.league_events WHERE league_id=f.league_id),'unchanged settings and private codes add no event');
  UPDATE public.leagues SET status='setup' WHERE id=f.league_id;
  PERFORM public.update_lineup_slots_atomic(f.league_id,'[{"slot_type":"PG","slot_count":2}]');
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.league_events WHERE league_id=f.league_id AND summary='Lineup slots changed'
    AND detail->'changes' ? 'lineup_slots'),'lineup slot settings record their resulting configuration');
  SELECT count(*) INTO event_count FROM public.league_events WHERE league_id=f.league_id;
  PERFORM public.update_lineup_slots_atomic(f.league_id,'[{"slot_type":"PG","slot_count":2}]');
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT count(*)=event_count FROM public.league_events WHERE league_id=f.league_id),'unchanged lineup slots add no event');
  UPDATE public.leagues SET status='active' WHERE id=f.league_id;

  PERFORM set_config('request.jwt.claim.sub','',true);
  SELECT * INTO d FROM pg_temp.rules_fixture(2,9574,'offseason');
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
    VALUES(player,'Timeline','Rookie','PG',ARRAY['PG'],0,1);
  INSERT INTO public.drafts(id,league_id,league_season_id,draft_type,status,is_mock,pick_timer_seconds)
    VALUES(draft,d.league_id,d.season_id,'snake','in_progress',false,60);
  INSERT INTO public.draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES(d.league_id,9574,1,d.member_ids[1],d.member_ids[1]) RETURNING id INTO asset;
  INSERT INTO public.snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,draft_pick_id)
    VALUES(draft,1,1,1,d.member_ids[1],asset),(draft,2,1,2,d.member_ids[2],NULL);
  PERFORM public.make_snake_pick_atomic(draft,d.member_ids[1],player);
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.league_events WHERE league_id=d.league_id AND member_id=d.member_ids[1]
    AND kind='pick.made' AND detail->>'player_id'=player::text AND detail->>'pick_number'='1'),'real rookie pick enters the timeline');
  UPDATE public.snake_draft_picks SET player_id=player WHERE draft_id=draft AND overall_pick=1;
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.league_events WHERE league_id=d.league_id AND kind='pick.made'),'unchanged pick emits no duplicate');
  INSERT INTO public.drafts(id,league_id,league_season_id,draft_type,status,is_mock,pick_timer_seconds)
    VALUES(mock,d.league_id,d.season_id,'snake','in_progress',true,60);
  INSERT INTO public.snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,player_id,picked_at)
    VALUES(mock,1,1,1,d.member_ids[1],player,now());
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.league_events WHERE league_id=d.league_id AND kind='pick.made'),'mock picks stay out of the team timeline');
  SELECT * INTO a FROM pg_temp.rules_fixture(2,9575,'drafting');
  draft := gen_random_uuid();
  player := gen_random_uuid();
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,years_exp)
    VALUES(player,'Timeline','Auction','PG',ARRAY['PG'],3);
  INSERT INTO public.drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
    VALUES(draft,a.league_id,a.season_id,'auction','in_progress',false,1);
  INSERT INTO public.draft_orders(draft_id,member_id,position) VALUES(draft,a.member_ids[1],1),(draft,a.member_ids[2],2);
  INSERT INTO public.draft_budgets(draft_id,member_id,initial_budget,remaining)
    VALUES(draft,a.member_ids[1],200,200),(draft,a.member_ids[2],200,200);
  nomination := public.create_auction_nomination_atomic(draft,a.member_ids[1],player,a.user_ids[1],5);
  PERFORM public.place_auction_bid_atomic(draft,a.member_ids[1],nomination.id,3,a.user_ids[1]);
  UPDATE public.nominations SET countdown_expires_at=now()-interval '1 second' WHERE id=nomination.id;
  PERFORM public.close_auction_nomination_atomic(nomination.id);
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.league_events WHERE league_id=a.league_id AND member_id=a.member_ids[1]
    AND kind='pick.made' AND detail->>'player_id'=player::text AND detail->>'final_price'='3'),'real auction award enters the timeline');
  PERFORM public.close_auction_nomination_atomic(nomination.id);
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.league_events WHERE league_id=a.league_id AND kind='pick.made'),'auction close retry emits no duplicate');

END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; result jsonb;
BEGIN
  SELECT * INTO f FROM timeline_fixture;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[3]::text,true);
  result := public.view_team_timeline(f.league_id,f.member_ids[3],NULL,100);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'events') event WHERE event->>'kind'='trade.sent'),'third participant reads its own multi-team offer');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'events') event WHERE event->>'kind'='settings.changed'),'settings affect every team');
  PERFORM pg_temp.reject_rules('SELECT detail FROM public.league_events LIMIT 1','%permission denied%','direct reads cannot bypass private detail projection');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'events') event WHERE event->>'kind'='trade.expired'),'unrelated team cannot read private trade failure');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  result := public.view_team_timeline(f.league_id,f.member_ids[1],NULL,100);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'events') event WHERE event->>'kind'='trade.expired'
    AND event->>'reason'='Receiving roster no longer fits.'),'trade failure shows its exact recorded completion reason');

END;
$$;
RESET ROLE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
