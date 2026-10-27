\ir idempotency-support.sql
INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
SELECT f.league_id,f.season_id,f.member_ids[1],p.id,'draft' FROM idempotency_fixture f CROSS JOIN idempotency_players p WHERE p.n<=3;
DO $$
DECLARE f record; player uuid;
BEGIN
  SELECT * INTO f FROM idempotency_fixture;
  SELECT id INTO player FROM idempotency_players WHERE n=4;
  PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],player,'draft',gen_random_uuid());
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,is_on_taxi,acquired_via)
  VALUES(f.league_id,f.season_id,f.member_ids[1],player,true,'draft');
END;
$$;
DO $$
DECLARE f record; roster uuid; taxi uuid; free uuid;
BEGIN
  SELECT * INTO f FROM idempotency_fixture;
  SELECT r.id INTO roster FROM roster_players r JOIN idempotency_players p ON p.id=r.player_id WHERE p.n=1;
  SELECT r.id INTO free FROM roster_players r JOIN idempotency_players p ON p.id=r.player_id WHERE p.n=2;
  SELECT r.id INTO taxi FROM roster_players r JOIN idempotency_players p ON p.id=r.player_id WHERE p.n=4;
  PERFORM pg_temp.retry('IR move', f.user_ids[1], format('public.toggle_ir_atomic(%L,true,%L)',roster,f.user_ids[1]), 'public.toggle_ir_atomic');
  PERFORM pg_temp.retry('IR activation with drop', f.user_ids[1], format('public.activate_roster_player_with_overflow_atomic(%L,%L,%L,%L)',roster,'ir',free,'drop'), 'public.activate_roster_player_with_overflow_atomic');
  PERFORM pg_temp.retry('taxi activation', f.user_ids[1], format('public.toggle_taxi_atomic(%L,false,%L)',taxi,f.user_ids[1]), 'public.toggle_taxi_atomic');
  SELECT r.id INTO roster FROM roster_players r JOIN idempotency_players p ON p.id=r.player_id WHERE p.n=3;
  PERFORM pg_temp.retry('drop', f.user_ids[1], format('public.drop_player_atomic(%L,%L,NULL::uuid)',roster,f.season_id), 'public.drop_player_atomic');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM roster_transactions WHERE league_id=f.league_id AND transaction_type='fa_drop'), 'one transaction per intended drop');
END;
$$;
\ir idempotency-cleanup.sql
