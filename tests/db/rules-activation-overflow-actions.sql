BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  players uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid()];
  injured uuid;
  active uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9388);
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, injury_status)
  SELECT id, 'Overflow', id::text, 'PG', ARRAY['PG'], 'Out' FROM unnest(players) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, is_on_ir, acquired_via)
  VALUES(f.league_id, f.season_id, f.member_ids[1], players[1], true, 'draft') RETURNING id INTO injured;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
  VALUES(f.league_id, f.season_id, f.member_ids[1], players[2], 'draft') RETURNING id INTO active;
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  PERFORM pg_temp.reject_rules(format('SELECT public.activate_roster_player_with_overflow_atomic(%L,%L,%L,%L)',
    injured, 'ir', active, 'taxi'), 'Invalid roster overflow action: taxi', 'overflow rejects unsupported taxi entry');
  PERFORM pg_temp.reject_rules(format('SELECT public.activate_roster_player_with_lineup_atomic(%L,%L,%L,%L,%L,%L,%L,%L,1,NULL)',
    injured, 'ir', active, 'taxi', f.member_ids[1], f.league_id, f.season_id, current_date),
    'Invalid roster overflow action: taxi', 'lineup overflow rejects unsupported taxi entry');
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM public.roster_players WHERE id = injured)
    AND (SELECT NOT is_on_taxi FROM public.roster_players WHERE id = active),
    'invalid actions preserve both roster states');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
