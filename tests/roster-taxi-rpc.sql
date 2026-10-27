BEGIN;
\ir db/rules-support.sql
DO $$
DECLARE f record; active_player uuid := gen_random_uuid(); taxi_player uuid := gen_random_uuid(); ordinary_player uuid := gen_random_uuid(); claim uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(1, public.current_season_year_et());
  UPDATE leagues SET roster_size = 1, taxi_slots = 1 WHERE id = f.league_id;
  INSERT INTO players(id, first_name, last_name, position, eligible_positions, years_exp, career_regular_season_games)
  VALUES (active_player, 'Client', 'Active', 'PG', ARRAY['PG'], 3, 200),
         (taxi_player, 'Client', 'Taxi', 'PG', ARRAY['PG'], 1, 64),
         (ordinary_player, 'Client', 'Ordinary', 'PG', ARRAY['PG'], 3, 200);
  INSERT INTO roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
  VALUES (f.league_id, f.season_id, f.member_ids[1], active_player, 'draft');
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  claim := public.create_waiver_claim_atomic(p_member_id => f.member_ids[1], p_league_id => f.league_id,
    p_player_id => taxi_player, p_user_id => f.user_ids[1], p_to_ir => false, p_to_taxi => true);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE player_id = taxi_player),
    'taxi claim waits for its scheduled award');
  UPDATE waiver_claims SET process_date = (now() AT TIME ZONE 'America/New_York')::date - 1 WHERE id = claim;
  PERFORM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM roster_players WHERE member_id = f.member_ids[1]
    AND player_id = taxi_player AND is_on_taxi AND NOT is_on_ir), 'client named arguments award taxi with a full active roster');
  UPDATE leagues SET roster_size = 2 WHERE id = f.league_id;
  claim := public.create_waiver_claim_atomic(p_member_id => f.member_ids[1], p_league_id => f.league_id,
    p_player_id => ordinary_player, p_user_id => f.user_ids[1], p_to_ir => false, p_to_taxi => false);
  UPDATE waiver_claims SET process_date = (now() AT TIME ZONE 'America/New_York')::date - 1 WHERE id = claim;
  PERFORM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM roster_players WHERE member_id = f.member_ids[1]
    AND player_id = ordinary_player AND NOT is_on_taxi AND NOT is_on_ir), 'client named false arguments keep active placement');
  BEGIN
    PERFORM public.create_waiver_claim_atomic(p_member_id => f.member_ids[1], p_league_id => f.league_id,
      p_player_id => ordinary_player, p_user_id => f.user_ids[1], p_to_ir => true, p_to_taxi => true);
    RAISE EXCEPTION 'Expected mutually exclusive destinations';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    PERFORM pg_temp.check_rules(SQLERRM = 'Choose IR or taxi, not both.', 'client cannot request both destinations');
  END;
  PERFORM public.activate_roster_player_with_overflow_atomic(
    p_activate_roster_player_id => (SELECT id FROM roster_players WHERE player_id = taxi_player AND member_id = f.member_ids[1]),
    p_activate_source => 'taxi',
    p_free_roster_player_id => (SELECT id FROM roster_players WHERE player_id = active_player AND member_id = f.member_ids[1]),
    p_free_action => 'drop');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM roster_players WHERE member_id = f.member_ids[1]
    AND player_id = taxi_player AND NOT is_on_taxi AND NOT is_on_ir), 'client taxi recovery uses the taxi activation source');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
