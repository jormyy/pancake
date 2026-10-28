BEGIN;
SET LOCAL statement_timeout='8s';
SET LOCAL lock_timeout='3s';
CREATE TEMP TABLE trade_budget_measurements(label text PRIMARY KEY, milliseconds numeric);
CREATE FUNCTION pg_temp.measure_trade(label text, command text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE started timestamptz:=clock_timestamp(); result jsonb; elapsed numeric;
BEGIN
  EXECUTE command INTO result;
  elapsed:=extract(epoch FROM clock_timestamp()-started)*1000;
  IF elapsed>=5000 THEN RAISE EXCEPTION '% exceeds the 5000 ms budget: % ms',label,elapsed; END IF;
  INSERT INTO trade_budget_measurements VALUES(label,elapsed);
  RETURN result;
END;
$$;
CREATE TEMP TABLE trade_budget_inputs AS
WITH sender AS (
  SELECT * FROM public.league_members WHERE id=:'sender_id'::uuid AND role='manager'
), receiver AS (
  SELECT * FROM public.league_members WHERE id=:'recipient_id'::uuid
), assets AS (
  SELECT sender.id member_id,sender.user_id,sender.league_id,receiver.id recipient_id,season.id season_id,
    ARRAY(SELECT player_id FROM public.roster_players WHERE league_season_id=season.id
      AND member_id=sender.id AND NOT is_on_ir AND NOT is_on_taxi ORDER BY player_id LIMIT 3) offered,
    ARRAY(SELECT player_id FROM public.roster_players WHERE league_season_id=season.id
      AND member_id=receiver.id AND is_on_taxi ORDER BY player_id LIMIT 1)
      || ARRAY(SELECT player_id FROM public.roster_players WHERE league_season_id=season.id
        AND member_id=receiver.id AND NOT is_on_ir AND NOT is_on_taxi ORDER BY player_id LIMIT 1) requested,
    ARRAY(SELECT player_id FROM public.roster_players WHERE league_season_id=season.id
      AND member_id=receiver.id AND is_on_taxi ORDER BY player_id LIMIT 1) incoming_taxi,
    ARRAY(SELECT player_id FROM public.roster_players WHERE league_season_id=season.id
      AND member_id=sender.id AND NOT is_on_ir AND NOT is_on_taxi ORDER BY player_id LIMIT 1 OFFSET 3) dropped,
    (SELECT player_id FROM public.roster_players WHERE league_season_id=season.id
      AND member_id=sender.id AND is_on_taxi ORDER BY player_id LIMIT 1) promoted
  FROM sender JOIN receiver ON receiver.league_id=sender.league_id
  JOIN public.league_seasons season ON season.league_id=sender.league_id AND season.is_current
)
SELECT *,gen_random_uuid() request_id,jsonb_build_object('leagueId',league_id,'leagueSeasonId',season_id,
  'recipientMemberId',recipient_id,'offerPlayerIds',offered,'requestPlayerIds',requested,
  'rosterPlan',jsonb_build_object('taxiPlayerIds',incoming_taxi,'irPlayerIds','[]'::jsonb,'dropPlayerIds',dropped,
    'rosterMoves',jsonb_build_array(jsonb_build_object('playerId',promoted,'destination','active')))) payload,
  (SELECT jsonb_agg(term) FROM (
    SELECT jsonb_build_object('fromMemberId',member_id,'toMemberId',recipient_id,'playerId',id) term FROM unnest(offered) id
    UNION ALL SELECT jsonb_build_object('fromMemberId',recipient_id,'toMemberId',member_id,'playerId',id) FROM unnest(requested) id
  ) terms) terms FROM assets;
DO $$
DECLARE f record; counts integer[];
BEGIN
  IF (SELECT count(*) FROM public.player_game_stats)<200000 THEN
    RAISE EXCEPTION 'Restore production-shaped data with at least 200000 player game rows.';
  END IF;
  IF (SELECT count(*) FROM trade_budget_inputs)<>1 THEN RAISE EXCEPTION 'Choose two teams in the same league and a manager sender.'; END IF;
  SELECT * INTO STRICT f FROM trade_budget_inputs;
  IF (SELECT count(*) FROM public.league_members WHERE league_id=f.league_id)<10 THEN RAISE EXCEPTION 'The league needs at least ten teams.'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.leagues WHERE id=f.league_id AND roster_size=20 AND ir_slots=2 AND taxi_slots=3) THEN
    RAISE EXCEPTION 'The league must use 20 active, 2 IR, and 3 taxi slots.';
  END IF;
  SELECT ARRAY[count(*) FILTER(WHERE NOT is_on_ir AND NOT is_on_taxi),count(*) FILTER(WHERE is_on_ir),count(*) FILTER(WHERE is_on_taxi)]
    INTO counts FROM public.roster_players WHERE league_season_id=f.season_id AND member_id=f.member_id;
  IF counts<>ARRAY[20,2,3] THEN RAISE EXCEPTION 'The sender must start with 20 active, 2 IR, and 3 taxi players.'; END IF;
  SELECT ARRAY[count(*) FILTER(WHERE NOT is_on_ir AND NOT is_on_taxi),count(*) FILTER(WHERE is_on_ir),count(*) FILTER(WHERE is_on_taxi)]
    INTO counts FROM public.roster_players WHERE league_season_id=f.season_id AND member_id=f.recipient_id;
  IF counts<>ARRAY[20,0,3] THEN RAISE EXCEPTION 'The recipient must start with 20 active, 0 IR, and 3 taxi players.'; END IF;
END;
$$;
\if :negative_control
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('public.propose_trade_atomic(uuid,uuid,uuid,uuid,uuid[],uuid[],uuid[],uuid[],text,timestamptz,integer,integer)'::regprocedure) INTO definition;
  EXECUTE regexp_replace(definition,E'\nBEGIN\n',E'\nBEGIN\n  PERFORM pg_sleep(5.1);\n');
END;
$$;
\endif
SAVEPOINT unplanned;
DO $$
DECLARE f record; trade uuid; counts integer[];
BEGIN
  SELECT * INTO STRICT f FROM trade_budget_inputs;
  trade:=(pg_temp.measure_trade('propose',format('SELECT to_jsonb(public.propose_trade_atomic(%L,%L,%L,%L,%L,%L,%L,%L))',
    f.league_id,f.season_id,f.member_id,f.recipient_id,f.offered,f.requested,'{}','{}'))#>>'{}')::uuid;
  SELECT ARRAY[count(*) FILTER(WHERE NOT on_ir AND NOT on_taxi),count(*) FILTER(WHERE on_ir),count(*) FILTER(WHERE on_taxi)]
    INTO counts FROM private.trade_resulting_roster(trade,f.member_id);
  IF counts<>ARRAY[18,2,4] THEN RAISE EXCEPTION 'The sender resulting roster must be 18 active, 2 IR, and 4 taxi.'; END IF;
  SELECT ARRAY[count(*) FILTER(WHERE NOT on_ir AND NOT on_taxi),count(*) FILTER(WHERE on_ir),count(*) FILTER(WHERE on_taxi)]
    INTO counts FROM private.trade_resulting_roster(trade,f.recipient_id);
  IF counts<>ARRAY[22,0,2] THEN RAISE EXCEPTION 'The recipient resulting roster must be 22 active, 0 IR, and 2 taxi.'; END IF;
  PERFORM pg_temp.measure_trade('roster-plan',format('SELECT to_jsonb(public.set_trade_roster_plan_atomic(%L,%L,%L,%L,%L,%L,%L))',
    trade,f.member_id,f.user_id,f.incoming_taxi,'{}',f.dropped,f.payload->'rosterPlan'->'rosterMoves'));
END;
$$;
SELECT jsonb_agg(to_jsonb(m)) AS raw_measurements FROM trade_budget_measurements m \gset
ROLLBACK TO unplanned;
DO $$
DECLARE f record; inputs jsonb; quote jsonb; trade uuid; replay uuid; before_rosters jsonb;
BEGIN
  SELECT * INTO STRICT f FROM trade_budget_inputs;
  SELECT jsonb_agg(to_jsonb(r) ORDER BY id) INTO before_rosters FROM public.roster_players r WHERE league_season_id=f.season_id;
  inputs:=pg_temp.measure_trade('estimate-inputs',format('SELECT public.get_trade_estimate_inputs(%L,%L,%L)',f.user_id,f.member_id,f.terms));
  quote:=pg_temp.measure_trade('estimate-snapshot',format('SELECT public.save_trade_estimate_quote(%L,%L,%L,%L,%L)',
    f.user_id,f.member_id,inputs,'{"teams":[],"assets":[]}','budget-fixture'));
  f.payload:=f.payload||jsonb_build_object('estimateId',quote->>'id');
  trade:=(pg_temp.measure_trade('submit-with-plan-and-estimate',format('SELECT to_jsonb(public.submit_trade_offer_atomic(%L,%L,%L,%L,%L))',
    f.user_id,f.request_id,f.member_id,'propose',f.payload))#>>'{}')::uuid;
  replay:=(pg_temp.measure_trade('receipt-replay',format('SELECT to_jsonb(public.submit_trade_offer_atomic(%L,%L,%L,%L,%L))',
    f.user_id,f.request_id,f.member_id,'propose',f.payload))#>>'{}')::uuid;
  IF replay IS DISTINCT FROM trade THEN RAISE EXCEPTION 'A retry must return the same trade.'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.trade_estimates WHERE trade_id=trade AND quote_id=(quote->>'id')::uuid) THEN
    RAISE EXCEPTION 'The trade must retain its exact estimate snapshot.';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM private.request_receipts WHERE request_id=f.request_id AND result=to_jsonb(trade)) THEN
    RAISE EXCEPTION 'The request guard must save its receipt.';
  END IF;
  IF before_rosters IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.roster_players r WHERE league_season_id=f.season_id) THEN
    RAISE EXCEPTION 'Proposing a trade must leave current rosters unchanged.';
  END IF;
  IF (SELECT sum(milliseconds) FROM trade_budget_measurements WHERE label IN('estimate-inputs','estimate-snapshot','submit-with-plan-and-estimate'))>=5000 THEN
    RAISE EXCEPTION 'Estimate and submission together exceed the 5000 ms budget.';
  END IF;
END;
$$;
SELECT jsonb_build_object('raw',:'raw_measurements'::jsonb,'submission',jsonb_agg(to_jsonb(m))) FROM trade_budget_measurements m;
ROLLBACK;
