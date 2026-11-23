\set ON_ERROR_STOP on
BEGIN;
\ir ../rules-support.sql

CREATE FUNCTION pg_temp.denied(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM IS DISTINCT FROM 'Not authorized to act for this member.' THEN RAISE; END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION pg_temp.offer(p_user uuid, p_member uuid, p_recipient uuid, p_league uuid, p_season uuid)
RETURNS uuid LANGUAGE sql AS $$
  SELECT public.submit_trade_offer_atomic(p_user, gen_random_uuid(), p_member, 'propose',
    jsonb_build_object('leagueId', p_league, 'leagueSeasonId', p_season,
      'recipientMemberId', p_recipient, 'offerFaabAmount', 1, 'requestFaabAmount', 1));
$$;

CREATE FUNCTION pg_temp.as_request(p_request uuid, p_actor uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.headers', jsonb_build_object('x-request-id', p_request, 'x-request-actor', p_actor)::text, true);
$$;

DO $$
DECLARE
  f record;
  rejected uuid;
  withdrawn uuid;
  reject_request uuid := gen_random_uuid();
  withdraw_request uuid := gen_random_uuid();
  replacement uuid := gen_random_uuid();
  reject_sql text;
  withdraw_sql text;
  first jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9593);
  rejected := pg_temp.offer(f.user_ids[1], f.member_ids[1], f.member_ids[2], f.league_id, f.season_id);
  withdrawn := pg_temp.offer(f.user_ids[2], f.member_ids[2], f.member_ids[1], f.league_id, f.season_id);
  reject_sql := format('SELECT public.reject_trade_atomic(%L,%L,%L)', rejected, f.member_ids[2], f.user_ids[2]);
  withdraw_sql := format('SELECT public.withdraw_trade_atomic(%L,%L,%L)', withdrawn, f.member_ids[2], f.user_ids[2]);

  PERFORM pg_temp.as_request(reject_request, f.user_ids[2]);
  first := public.reject_trade_atomic(rejected, f.member_ids[2], f.user_ids[2]);
  PERFORM pg_temp.check_rules(public.reject_trade_atomic(rejected, f.member_ids[2], f.user_ids[2]) = first,
    'the recipient replays the committed rejection');
  PERFORM pg_temp.as_request(withdraw_request, f.user_ids[2]);
  first := public.withdraw_trade_atomic(withdrawn, f.member_ids[2], f.user_ids[2]);
  PERFORM pg_temp.check_rules(public.withdraw_trade_atomic(withdrawn, f.member_ids[2], f.user_ids[2]) = first,
    'the proposer replays the committed withdrawal');

  INSERT INTO auth.users(id, email) VALUES (replacement, replacement::text || '@example.test');
  UPDATE public.league_members SET user_id = replacement WHERE id = f.member_ids[2];

  PERFORM pg_temp.as_request(reject_request, f.user_ids[2]);
  IF NOT pg_temp.denied(reject_sql) THEN
    RAISE EXCEPTION 'BUG: a former owner replays a trade rejection without membership';
  END IF;
  PERFORM pg_temp.as_request(withdraw_request, f.user_ids[2]);
  IF NOT pg_temp.denied(withdraw_sql) THEN
    RAISE EXCEPTION 'BUG: a former owner replays a trade withdrawal without membership';
  END IF;
  PERFORM pg_temp.check_rules(true, 'former owners cannot replay rejections or withdrawals');

  PERFORM pg_temp.check_rules(
    (SELECT array_agg(status::text ORDER BY id = rejected DESC) FROM public.trades WHERE id IN (rejected, withdrawn))
      = ARRAY['rejected', 'withdrawn'],
    'denied replays leave both trades in their committed state');
END;
$$;
SELECT count(*) AS trade_action_replay_checks FROM rules_checks;
ROLLBACK;
