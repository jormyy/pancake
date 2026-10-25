BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  offer uuid;
  actual int;
  balances int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9493);
  UPDATE public.leagues SET waiver_mode = 'faab', faab_starting_budget = 100 WHERE id = f.league_id;
  offer := public.propose_trade_atomic(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2],
    '{}', '{}', '{}', '{}', NULL, NULL, 30, 1);
  PERFORM public.accept_trade_atomic(offer, f.member_ids[2]);
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  SELECT faab_balance INTO actual FROM public.get_member_transaction_state(
    p_member_id => f.member_ids[1], p_league_id => f.league_id);
  PERFORM pg_temp.check_rules(actual = 70, 'client transaction state excludes accepted outgoing FAAB');
  PERFORM set_config('request.jwt.claim.sub', '', true);
  UPDATE public.trades SET veto_window_expires_at = now() - interval '1 minute' WHERE id = offer;
  PERFORM public.complete_accepted_trade_atomic(offer);
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  SELECT faab_balance INTO actual FROM public.get_member_transaction_state(
    p_member_id => f.member_ids[1], p_league_id => f.league_id);
  PERFORM pg_temp.check_rules(actual = 71, 'settled trades no longer reserve FAAB');
  DELETE FROM public.faab_balances WHERE member_id = f.member_ids[1];
  SELECT count(*) INTO balances FROM public.faab_balances;
  SELECT faab_balance INTO actual FROM public.get_member_transaction_state(
    p_member_id => f.member_ids[1], p_league_id => f.league_id);
  PERFORM pg_temp.check_rules(actual = 100 AND balances = (SELECT count(*) FROM public.faab_balances),
    'stable transaction state uses the default without inserting a balance');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
