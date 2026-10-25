BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  player uuid := gen_random_uuid();
  roster uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(1, 9494);
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, injury_status)
  VALUES(player, 'Repeat', 'IR', 'PG', ARRAY['PG'], 'Out');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
  VALUES(f.league_id, f.season_id, f.member_ids[1], player, 'draft') RETURNING id INTO roster;
  PERFORM public.toggle_ir_atomic(roster, true, f.user_ids[1]);
  PERFORM public.toggle_ir_atomic(roster, true, f.user_ids[1]);
  PERFORM pg_temp.check_rules((SELECT count(*) = 1 FROM public.roster_transactions
    WHERE league_id = f.league_id AND transaction_type = 'ir_designate'), 'repeated IR placement writes one transaction');
  PERFORM public.toggle_ir_atomic(roster, false, f.user_ids[1]);
  PERFORM public.toggle_ir_atomic(roster, false, f.user_ids[1]);
  PERFORM pg_temp.check_rules((SELECT count(*) = 1 FROM public.roster_transactions
    WHERE league_id = f.league_id AND transaction_type = 'ir_return'), 'repeated IR return writes one transaction');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
