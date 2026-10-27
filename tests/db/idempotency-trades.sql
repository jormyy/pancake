\ir idempotency-support.sql
INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
SELECT f.league_id,f.season_id,f.member_ids[CASE WHEN p.n%2=1 THEN 1 ELSE 2 END],p.id,'draft'
FROM idempotency_fixture f CROSS JOIN idempotency_players p WHERE p.n<=8;
UPDATE league_members SET role='co_commissioner' WHERE id=(SELECT member_ids[3] FROM idempotency_fixture);
DO $$
DECLARE f record; trade uuid; counter uuid; payload jsonb; pair int; offered uuid; wanted uuid;
BEGIN
  SELECT * INTO f FROM idempotency_fixture;
  FOR pair IN 1..3 LOOP
    SELECT id INTO offered FROM idempotency_players WHERE n=pair*2-1;
    SELECT id INTO wanted FROM idempotency_players WHERE n=pair*2;
    payload := jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,'recipientMemberId',f.member_ids[2],
      'offerPlayerIds',ARRAY[offered],'requestPlayerIds',ARRAY[wanted]);
    trade := (pg_temp.retry('trade propose '||pair, f.user_ids[1], format('public.submit_trade_offer_atomic(%L,$request,%L,%L,%L::jsonb)',f.user_ids[1],f.member_ids[1],'propose',payload), 'public.submit_trade_offer_atomic')#>>'{}')::uuid;
    IF pair=1 THEN
      PERFORM pg_temp.retry('trade reject', f.user_ids[2], format('public.reject_trade_atomic(%L,%L,%L)',trade,f.member_ids[2],f.user_ids[2]), 'public.reject_trade_atomic');
    ELSIF pair=2 THEN
      payload := jsonb_build_object('tradeId',trade,'offerPlayerIds',ARRAY[wanted],'requestPlayerIds',ARRAY[offered]);
      counter := (pg_temp.retry('trade counter', f.user_ids[2], format('public.submit_trade_offer_atomic(%L,$request,%L,%L,%L::jsonb)',f.user_ids[2],f.member_ids[2],'counter',payload), 'public.submit_trade_offer_atomic')#>>'{}')::uuid;
      PERFORM pg_temp.retry('trade withdraw', f.user_ids[2], format('public.withdraw_trade_atomic(%L,%L,%L)',counter,f.member_ids[2],f.user_ids[2]), 'public.withdraw_trade_atomic');
    ELSE
      PERFORM pg_temp.retry('trade accept', f.user_ids[2], format('public.accept_trade_atomic(%L,%L)',trade,f.member_ids[2]), 'public.accept_trade_atomic');
      PERFORM pg_temp.retry('trade veto', f.user_ids[3], format('public.veto_trade_atomic(%L,%L)',trade,f.member_ids[3]), 'public.veto_trade_atomic');
    END IF;
  END LOOP;
END;
$$;
UPDATE leagues SET trade_veto_mode='member_vote', trade_veto_threshold_percent=100 WHERE id=(SELECT league_id FROM idempotency_fixture);
DO $$
DECLARE f record; trade uuid; payload jsonb; offered uuid; wanted uuid; result jsonb;
BEGIN
  SELECT * INTO f FROM idempotency_fixture;
  SELECT id INTO offered FROM idempotency_players WHERE n=7;
  SELECT id INTO wanted FROM idempotency_players WHERE n=8;
  payload := jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,'recipientMemberId',f.member_ids[2],
    'offerPlayerIds',ARRAY[offered],'requestPlayerIds',ARRAY[wanted]);
  trade := (pg_temp.retry('vote proposal', f.user_ids[1], format('public.submit_trade_offer_atomic(%L,$request,%L,%L,%L::jsonb)',f.user_ids[1],f.member_ids[1],'propose',payload), 'public.submit_trade_offer_atomic')#>>'{}')::uuid;
  PERFORM pg_temp.retry('vote acceptance', f.user_ids[2], format('public.accept_trade_atomic(%L,%L)',trade,f.member_ids[2]), 'public.accept_trade_atomic');
  result := pg_temp.retry('first vote', f.user_ids[4], format('public.veto_trade_atomic(%L,%L)',trade,f.member_ids[4]), 'public.veto_trade_atomic');
  PERFORM pg_temp.check_rules((result->>'vetoed')::boolean=false, 'one vote stays below the threshold');
  PERFORM pg_temp.retry('second vote', f.user_ids[3], format('public.veto_trade_atomic(%L,%L)',trade,f.member_ids[3]), 'public.veto_trade_atomic');
END;
$$;
\ir idempotency-cleanup.sql
