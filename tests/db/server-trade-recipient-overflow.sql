BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  players uuid[];
  payload jsonb;
  offer uuid;
  counter uuid;
  scenario int;
BEGIN
  PERFORM pg_temp.check_rules(to_regprocedure('private.validate_trade_rosters(uuid)') IS NULL
    AND to_regprocedure('private.validate_trade_rosters(uuid,uuid)') IS NOT NULL,
    'only the two-argument validator exists with a full-check default');
  FOR scenario IN 1..2 LOOP
    SELECT * INTO f FROM pg_temp.rules_fixture(2, 9490 + scenario);
    players := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
    UPDATE public.leagues SET allow_inactive_trades = true, roster_size = 2 WHERE id = f.league_id;
    INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
    SELECT id, 'Recipient', id::text, 'PG', ARRAY['PG'] FROM unnest(players) id;
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    SELECT f.league_id, f.season_id, f.member_ids[CASE WHEN ord <= 2 THEN 1 ELSE 2 END], id, 'draft'
    FROM unnest(players) WITH ORDINALITY AS player(id, ord);
    payload := jsonb_build_object('leagueId', f.league_id, 'leagueSeasonId', f.season_id,
      'recipientMemberId', f.member_ids[2], 'offerPlayerIds', ARRAY[players[1]],
      'requestPlayerIds', ARRAY[players[3]]);
    IF scenario = 1 THEN
      payload := payload || jsonb_build_object('offerPlayerIds', ARRAY[players[1], players[2]]);
    END IF;
    offer := public.submit_trade_offer_atomic(f.user_ids[1], gen_random_uuid(), f.member_ids[1], 'propose', payload);
    PERFORM pg_temp.check_rules(offer IS NOT NULL, 'offer sends in scenario ' || scenario);
    IF scenario = 1 THEN
      PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)', offer, f.member_ids[2]),
        'Rules team 2 must change its trade plan to meet the active roster limit.',
        'recipient must resolve overflow at acceptance');
      PERFORM public.set_trade_roster_plan_atomic(offer, f.member_ids[2], f.user_ids[2], '{}', '{}', ARRAY[players[4]]);
      PERFORM public.accept_trade_atomic(offer, f.member_ids[2]);
      PERFORM pg_temp.check_rules((SELECT status = 'accepted' FROM public.trades WHERE id = offer),
        'recipient accepts after selecting its own drop');
    ELSE
      counter := public.submit_trade_offer_atomic(f.user_ids[2], gen_random_uuid(), f.member_ids[2], 'counter',
        jsonb_build_object('tradeId', offer, 'offerPlayerIds', ARRAY[players[3], players[4]],
          'requestPlayerIds', ARRAY[players[1]]));
      PERFORM pg_temp.check_rules(counter IS NOT NULL, 'counter sends while the original proposer needs a drop');
      PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)', counter, f.member_ids[1]),
        'Rules team 1 must change its trade plan to meet the active roster limit.',
        'counter recipient must resolve overflow at acceptance');
    END IF;
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
