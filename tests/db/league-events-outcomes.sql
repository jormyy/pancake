BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE event_fixture AS SELECT * FROM pg_temp.rules_fixture(3,9567);
GRANT SELECT ON event_fixture TO authenticated;
DO $$
DECLARE f record; player uuid:=gen_random_uuid(); claim uuid:=gen_random_uuid(); trade uuid; matchup uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO f FROM event_fixture;
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9567,1,(now() AT TIME ZONE 'America/New_York')::date,(now() AT TIME ZONE 'America/New_York')::date+6);
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions) VALUES(player,'Event','Player','PG',ARRAY['PG']);
  INSERT INTO public.waiver_claims(id,league_id,league_season_id,member_id,player_id,claim_order,priority_at_submission,process_date)
    VALUES(claim,f.league_id,f.season_id,f.member_ids[1],player,1,1,current_date);
  UPDATE public.waiver_claims SET status='failed_roster',failure_reason='Synthetic failure' WHERE id=claim;
  UPDATE public.waiver_claims SET status='failed_roster' WHERE id=claim;
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.league_events WHERE league_id=f.league_id AND kind='claim.failed'),'failed claim emits once');
  UPDATE public.waiver_claims SET status='succeeded' WHERE id=claim;
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.league_events WHERE league_id=f.league_id AND kind='claim.awarded'),'awarded claim enters the event log');
  trade:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'{}','{}','{}','{}',NULL,NULL,1,1);
  PERFORM public.accept_trade_atomic(trade,f.member_ids[2]);
  UPDATE public.trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=trade;
  PERFORM public.complete_accepted_trade_atomic(trade);
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.league_events WHERE league_id=f.league_id AND kind='trade.executed'),'real trade execution enters the event log');
  trade:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'{}','{}','{}','{}',NULL,NULL,2,2);
  PERFORM public.accept_trade_atomic(trade,f.member_ids[2]);
  PERFORM private.begin_trade_lifecycle_write();
  UPDATE public.trades SET status='vetoed',vetoed_at=now() WHERE id=trade;
  PERFORM private.end_trade_lifecycle_write('');
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.league_events WHERE league_id=f.league_id AND kind='trade.vetoed'),'vetoed trade enters the event log');
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(matchup,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]);
  UPDATE public.matchups SET is_finalized=true WHERE id=matchup;
  UPDATE public.matchups SET is_finalized=true WHERE id=matchup;
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.league_events WHERE league_id=f.league_id AND kind='scores.finalized'),'score finalization emits once');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(f.league_id,f.season_id,f.member_ids[1],player,'draft');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM public.auto_set_lineup_atomic(f.member_ids[1],f.league_id,f.season_id,(now() AT TIME ZONE 'America/New_York')::date,'[]');
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.league_events WHERE league_id=f.league_id AND kind='lineup.auto_set' AND member_id=f.member_ids[1]),'lineup auto-set enters the event log');
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules(NOT has_table_privilege('authenticated','public.league_events','INSERT'),'clients cannot forge events');
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  PERFORM pg_temp.check_rules(NOT has_table_privilege('anon','public.league_events','SELECT'),'anonymous clients cannot read events');
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM event_fixture;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.league_events WHERE league_id=f.league_id AND kind='claim.failed'),'claim owner reads failure');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[3]::text,true);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.league_events WHERE league_id=f.league_id AND kind='claim.failed'),'other managers cannot read private failed bids');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.league_events WHERE league_id=f.league_id AND kind='trade.executed'),'league members read completed trades');
  PERFORM set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.league_events WHERE league_id=f.league_id),'outsiders cannot read league events');
END;
$$;
RESET ROLE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
