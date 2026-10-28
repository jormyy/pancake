BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; trade uuid; publication uuid; event_count int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9565);
  trade:=public.submit_trade_offer_atomic(f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',jsonb_build_object(
    'leagueId',f.league_id,'leagueSeasonId',f.season_id,'recipientMemberId',f.member_ids[2],
    'offerFaabAmount',1,'requestFaabAmount',2));
  PERFORM public.accept_trade_atomic(trade,f.member_ids[2]);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.league_events WHERE detail->>'id'=trade::text),
    'trade events leave the write transaction');
  SELECT id INTO STRICT publication FROM private.trade_publications WHERE league_id=f.league_id;
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-publication'
    AND payload->>'publicationId'=publication::text),'publication has durable work');
  PERFORM private.publish_trade_changes(publication);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.league_events WHERE kind='trade.sent' AND detail->>'id'=trade::text),
    'publication retains the sent event');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.league_events WHERE kind='trade.accepted' AND detail->>'id'=trade::text),
    'publication retains the acceptance event');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.screen_refresh_queue WHERE league_id=f.league_id AND dirty),
    'publication requests the screen refresh');
  SELECT count(*) INTO event_count FROM public.league_events WHERE detail->>'id'=trade::text;
  PERFORM private.publish_trade_changes(publication);
  PERFORM pg_temp.check_rules((SELECT count(*)=event_count FROM public.league_events WHERE detail->>'id'=trade::text),
    'publication replay does not duplicate events');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.trade_publications WHERE id=publication),
    'publication removes its saved work');
END;
$$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
