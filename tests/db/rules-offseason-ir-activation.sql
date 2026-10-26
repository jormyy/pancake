BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  v_players uuid[];
  injured uuid;
  active uuid;
  action text;
BEGIN
  FOREACH action IN ARRAY ARRAY['direct', 'overflow', 'lineup'] LOOP
    SELECT * INTO f FROM pg_temp.rules_fixture(2, 9386, 'offseason');
    v_players := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
    INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, injury_status)
    SELECT id, 'Offseason', id::text, 'PG', ARRAY['PG'], 'Out' FROM unnest(v_players) id;
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, is_on_ir, acquired_via)
    VALUES(f.league_id, f.season_id, f.member_ids[1], v_players[1], true, 'carry_over') RETURNING id INTO injured;
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES(f.league_id, f.season_id, f.member_ids[1], v_players[2], 'carry_over') RETURNING id INTO active;
    UPDATE public.players SET injury_status = NULL WHERE id = v_players[1];
    UPDATE public.leagues SET roster_size = CASE WHEN action = 'direct' THEN 3 ELSE 1 END WHERE id = f.league_id;
    PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
    IF action = 'direct' THEN
      PERFORM public.toggle_ir_atomic(injured, false, f.user_ids[1]);
    ELSIF action = 'overflow' THEN
      PERFORM public.activate_roster_player_with_overflow_atomic(injured, 'ir', active, 'drop');
    ELSE
      PERFORM public.activate_roster_player_with_lineup_atomic(injured, 'ir', active, 'drop',
        f.member_ids[1], f.league_id, f.season_id, current_date, 1, NULL);
    END IF;
    PERFORM pg_temp.check_rules((SELECT NOT is_on_ir FROM public.roster_players WHERE id = injured),
      action || ' activates a recovered IR player in offseason');
    UPDATE public.leagues SET roster_size = 4 WHERE id = f.league_id;
    INSERT INTO public.waiver_wire_log(league_id, league_season_id, player_id)
    VALUES(f.league_id, f.season_id, v_players[4]);
    PERFORM pg_temp.check_rules(public.create_waiver_claim_atomic(f.league_id, f.member_ids[1],
      v_players[4], NULL, f.user_ids[1]) IS NOT NULL, action || ' clears the offseason claim guard');
    UPDATE public.players SET injury_status = 'Out' WHERE id = v_players[1];
    PERFORM pg_temp.reject_rules(format('SELECT public.toggle_ir_atomic(%L,true,%L)', injured, f.user_ids[1]),
      'Roster moves are only allowed%', action || ' keeps offseason IR placement blocked');
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
