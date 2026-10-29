BEGIN;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';
\ir rules-support.sql
DO $$
DECLARE
  f record;
  players uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  offer uuid;
  i int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9589);
  UPDATE leagues SET roster_size = 2, ir_slots = 1, taxi_slots = 0, allow_inactive_trades = true,
    trade_veto_mode = 'commissioner', trade_veto_window_hours = 24 WHERE id = f.league_id;
  FOR i IN 1..6 LOOP
    INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, years_exp, injury_status)
    VALUES(players[i], 'Legality', 'Player ' || i, 'PG', ARRAY['PG'], 3, 'Out');
    INSERT INTO roster_players(league_id, league_season_id, member_id, player_id, is_on_ir, acquired_via)
    VALUES(f.league_id, f.season_id, f.member_ids[CASE WHEN i <= 3 THEN 1 ELSE 2 END], players[i], i IN (3, 6), 'draft');
  END LOOP;
  offer := public.submit_trade_offer_atomic(f.user_ids[1], gen_random_uuid(), f.member_ids[1], 'propose', jsonb_build_object(
    'leagueId', f.league_id, 'leagueSeasonId', f.season_id, 'recipientMemberId', f.member_ids[2],
    'offerPlayerIds', ARRAY[players[3]], 'requestPlayerIds', ARRAY[players[6]],
    'rosterPlan', jsonb_build_object('taxiPlayerIds', '[]'::jsonb, 'irPlayerIds', '[]'::jsonb, 'dropPlayerIds', ARRAY[players[1]])));
  PERFORM pg_temp.check_rules((SELECT drop_player_ids = ARRAY[players[1]] FROM trade_participants WHERE trade_id = offer AND member_id = f.member_ids[1]), 'proposal carries proposer drop');
  PERFORM pg_temp.check_rules((SELECT count(*) = 6 FROM roster_players WHERE league_season_id = f.season_id), 'proposal leaves all roster players in place');
  PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_with_plan_atomic(%L,%L,%L,%L,%L,%L)', offer, f.member_ids[2], f.user_ids[2], '{}', '{}', '{}'), '%Regular roster is % over the limit%', 'accept without required drop fails');
  PERFORM public.accept_trade_with_plan_atomic(offer, f.member_ids[2], f.user_ids[2], '{}', '{}', ARRAY[players[4]]);
  PERFORM pg_temp.check_rules((SELECT drop_player_ids = ARRAY[players[4]] FROM trade_participants WHERE trade_id = offer AND member_id = f.member_ids[2]), 'accept carries acceptor drop');
  PERFORM pg_temp.check_rules((SELECT count(*) = 6 FROM roster_players WHERE league_season_id = f.season_id), 'accept leaves planned drops until settlement');
  UPDATE trades SET veto_window_expires_at = now() - interval '1 minute' WHERE id = offer;
  PERFORM public.complete_accepted_trade_atomic(offer);
  PERFORM pg_temp.check_rules((SELECT status = 'completed' FROM trades WHERE id = offer), 'trade settles');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE league_season_id = f.season_id AND player_id IN (players[1], players[4])), 'both planned drops execute');
  PERFORM pg_temp.check_rules((SELECT count(*) = 2 FROM waiver_wire_log WHERE league_season_id = f.season_id AND player_id IN (players[1], players[4])), 'both drops enter waivers');
  PERFORM pg_temp.check_rules((SELECT member_id = f.member_ids[2] FROM roster_players WHERE league_season_id = f.season_id AND player_id = players[3]) AND
    (SELECT member_id = f.member_ids[1] FROM roster_players WHERE league_season_id = f.season_id AND player_id = players[6]), 'both incoming players transfer');
  FOR i IN 1..2 LOOP
    PERFORM private.assert_legal_roster(f.league_id, f.season_id, f.member_ids[i]);
    PERFORM pg_temp.check_rules((SELECT count(*) = 2 FROM roster_players WHERE league_season_id = f.season_id AND member_id = f.member_ids[i] AND NOT is_on_ir AND NOT is_on_taxi), 'resulting regular roster is legal for team ' || i);
  END LOOP;
END;
$$;
SELECT * FROM rules_checks ORDER BY label;
ROLLBACK;
