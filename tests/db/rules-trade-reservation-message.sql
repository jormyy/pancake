BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  players uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  offer uuid;
  roster uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9391);
  UPDATE public.leagues SET allow_inactive_trades = true WHERE id = f.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
  SELECT id, 'Reserved', id::text, 'PG', ARRAY['PG'] FROM unnest(players) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
  VALUES(f.league_id, f.season_id, f.member_ids[1], players[1], 'draft') RETURNING id INTO roster;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
  VALUES(f.league_id, f.season_id, f.member_ids[1], players[2], 'draft'),
    (f.league_id, f.season_id, f.member_ids[2], players[3], 'draft');
  offer := public.propose_trade_atomic(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2],
    ARRAY[players[2]], ARRAY[players[3]], '{}', '{}');
  PERFORM public.set_trade_roster_plan_atomic(offer, f.member_ids[1], f.user_ids[1], '{}', '{}', ARRAY[players[1]]);
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  PERFORM pg_temp.reject_rules(format('SELECT public.drop_player_atomic(%L)', roster),
    'Locked by trade %', 'pending planned drops receive an accurate reservation message');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
