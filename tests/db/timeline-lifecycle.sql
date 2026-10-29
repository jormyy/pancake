BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE timeline_fixture AS SELECT * FROM pg_temp.rules_fixture(3, 9572);
CREATE TEMP TABLE timeline_entities(claim uuid, trade uuid);
GRANT SELECT ON timeline_fixture, timeline_entities TO authenticated;
DO $$
DECLARE f record; player uuid := gen_random_uuid(); won uuid; lost uuid; sent uuid; counter uuid; matchup uuid := gen_random_uuid();
  day date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  SELECT * INTO f FROM timeline_fixture;
  UPDATE public.leagues SET waiver_mode='faab',faab_starting_budget=100 WHERE id=f.league_id;
  INSERT INTO public.faab_balances(league_id,league_season_id,member_id,balance)
    SELECT f.league_id,f.season_id,id,100 FROM unnest(f.member_ids) id
    ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9572,1,day,day+6);
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions) VALUES(player,'Timeline','Player','PG',ARRAY['PG']);
  won := public.create_waiver_claim_atomic(f.league_id,f.member_ids[1],player,NULL,f.user_ids[1],17);
  lost := public.create_waiver_claim_atomic(f.league_id,f.member_ids[2],player,NULL,f.user_ids[2],9);
  UPDATE public.waiver_claims SET process_date=day-1 WHERE id IN(won,lost);
  PERFORM public.process_due_waiver_claims_atomic(day);
  PERFORM pg_temp.check_rules((SELECT status='succeeded' FROM public.waiver_claims WHERE id=won),'real winning claim completes');
  PERFORM pg_temp.check_rules((SELECT status::text LIKE 'failed%' FROM public.waiver_claims WHERE id=lost),'real losing claim completes');
  sent := public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'{}','{}','{}','{}',NULL,NULL,1,1);
  counter := public.submit_trade_offer_atomic(f.user_ids[2],gen_random_uuid(),f.member_ids[2],'counter',
    jsonb_build_object('tradeId',sent,'recipientMemberId',f.member_ids[1],'offerFaabAmount',2,'requestFaabAmount',1));
  PERFORM public.accept_trade_atomic(counter,f.member_ids[1]);
  UPDATE public.trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=counter;
  PERFORM public.complete_accepted_trade_atomic(counter);
  PERFORM pg_temp.check_rules((SELECT status='completed' FROM public.trades WHERE id=counter),'real counter trade executes');
  PERFORM pg_temp.publish_rules_trades(f.league_id);
  INSERT INTO timeline_entities VALUES(lost,counter);
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM public.auto_set_lineup_atomic(f.member_ids[1],f.league_id,f.season_id,day,'[]');
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(matchup,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]);
  UPDATE public.matchups SET is_finalized=true WHERE id=matchup;
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; result jsonb; counterparty jsonb; missing text; expected_reason text; claim_id uuid; i int; cursor jsonb; page jsonb; paged_ids jsonb; expected_ids jsonb;
BEGIN
  SELECT * INTO f FROM timeline_fixture;
  SELECT claim INTO claim_id FROM timeline_entities;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[2]::text,true);
  SELECT failure_reason INTO expected_reason FROM public.waiver_claims WHERE id=claim_id;
  result := public.view_team_timeline(f.league_id,f.member_ids[2],NULL,100);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'events') e
    WHERE e->>'kind'='claim.failed' AND e->>'reason'=expected_reason AND e->'detail'->>'bid_amount'='9'),'loser reads exact recorded reason and bid');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  counterparty := public.view_team_timeline(f.league_id,f.member_ids[2],NULL,100);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(counterparty->'events') e WHERE e->>'kind'='claim.failed'),'winner cannot see losing bid');
  result := public.view_team_timeline(f.league_id,f.member_ids[1],NULL,100);
  SELECT string_agg(required.kind, ', ' ORDER BY required.kind) INTO missing
    FROM unnest(ARRAY['claim.awarded','trade.executed','lineup.auto_set','scores.finalized','trade.sent','trade.countered','trade.accepted']) required(kind)
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'events') e WHERE e->>'kind'=required.kind);
  PERFORM pg_temp.check_rules(missing IS NULL,'real actions recorded; missing: '||coalesce(missing,'none'));
  FOR i IN 1..2 LOOP
    PERFORM set_config('request.jwt.claim.sub',f.user_ids[i]::text,true);
    result := public.view_team_timeline(f.league_id,f.member_ids[i],NULL,100);
    PERFORM pg_temp.check_rules(result->'events'=(SELECT jsonb_agg(event ORDER BY (event->>'createdAt')::timestamptz DESC,(event->>'id')::bigint DESC)
      FROM jsonb_array_elements(result->'events') event),'real events retain descending order for team '||i);
    SELECT jsonb_agg(event->'id') INTO expected_ids FROM jsonb_array_elements(result->'events') event;
    cursor := NULL;
    paged_ids := '[]';
    LOOP
      page := public.view_team_timeline(f.league_id,f.member_ids[i],cursor,2);
      paged_ids := paged_ids || (SELECT coalesce(jsonb_agg(event->'id'),'[]') FROM jsonb_array_elements(page->'events') event);
      EXIT WHEN NOT (page->>'hasMore')::boolean;
      cursor := page->'nextCursor';
      IF jsonb_array_length(paged_ids)>100 THEN RAISE EXCEPTION 'Paging did not stop'; END IF;
    END LOOP;
    PERFORM pg_temp.check_rules(paged_ids=expected_ids,'real event paging has no gaps or duplicates for team '||i);
  END LOOP;

END;
$$;
RESET ROLE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
