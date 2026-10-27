\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
BEGIN;
\ir rules-support.sql
DROP SCHEMA IF EXISTS idempotency_test CASCADE;
CREATE SCHEMA idempotency_test;
CREATE TABLE idempotency_test.applications(request_id uuid, relation text, operation text);
CREATE TEMP TABLE idempotency_fixture AS SELECT * FROM pg_temp.rules_fixture(4, 2901);
CREATE TEMP TABLE idempotency_players AS
SELECT gen_random_uuid() AS id, n FROM generate_series(1, 12) n;
INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, years_exp, injury_status)
SELECT id, 'Retry', n::text, 'PG', ARRAY['PG'], 0, 'Out' FROM idempotency_players;
UPDATE leagues SET waiver_mode='faab', faab_starting_budget=100, roster_size=12, taxi_slots=4, ir_slots=4,
  trade_veto_mode='commissioner', trade_veto_window_hours=24
WHERE id=(SELECT league_id FROM idempotency_fixture);
INSERT INTO faab_balances(league_id, league_season_id, member_id, balance)
SELECT league_id, season_id, unnest(member_ids), 100 FROM idempotency_fixture
ON CONFLICT(league_id, league_season_id, member_id) DO UPDATE SET balance=100;
CREATE FUNCTION idempotency_test.audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE id uuid := (NULLIF(current_setting('request.headers', true), '')::jsonb->>'x-request-id')::uuid;
BEGIN
  IF id IS NOT NULL THEN INSERT INTO idempotency_test.applications VALUES(id, TG_TABLE_NAME, TG_OP); END IF;
  RETURN NULL;
END;
$$;
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['leagues','league_members','lineup_slot_templates','lineup_optimizer_settings','notification_preferences',
    'weekly_lineups','waiver_claims','trades','trade_participants','trade_vetos','roster_players','roster_transactions',
    'snake_draft_picks','nominations','bids','league_announcements'] LOOP
    IF to_regclass('public.'||relation) IS NOT NULL THEN
      EXECUTE format('CREATE TRIGGER idempotency_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION idempotency_test.audit()', relation);
    END IF;
  END LOOP;
END;
$$;
CREATE FUNCTION idempotency_test.apply(id uuid, actor uuid, expression text, bypass boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb; service boolean := expression ~ '^public\.(submit_trade_offer_atomic|propose_trade_atomic|propose_multi_team_trade_atomic|accept_trade_atomic|accept_trade_with_plan_atomic|reject_trade_atomic|withdraw_trade_atomic|veto_trade_atomic|create_auction_nomination_atomic|place_auction_bid_atomic|withdraw_auction_nomination_atomic|auto_set_lineup_service_atomic)\('; 
BEGIN
  PERFORM set_config('statement_timeout', '10s', true);
  PERFORM set_config('request.jwt.claim.sub', CASE WHEN service THEN '' ELSE actor::text END, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', CASE WHEN service THEN NULL ELSE actor END, 'role', CASE WHEN service THEN 'service_role' ELSE 'authenticated' END)::text, true);
  PERFORM set_config('request.headers', jsonb_build_object('x-request-id', id, 'x-request-actor', actor)::text, true);
  IF bypass THEN PERFORM set_config('pancake.request_active', 'true', true); END IF;
  EXECUTE 'SELECT to_jsonb(' || replace(expression, '$request', quote_literal(id)) || ')' INTO result;
  PERFORM pg_sleep(0.15);
  RETURN COALESCE(result, 'null'::jsonb);
END;
$$;
CREATE FUNCTION pg_temp.retry(label text, actor uuid, expression text, function_name text, bypass boolean DEFAULT false, scope text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  id uuid := gen_random_uuid();
  first_result jsonb;
  second_result jsonb;
  replay_result jsonb;
  applied bigint;
  query text := format('SELECT idempotency_test.apply(%L, %L, %L, %L)', id, actor, expression, bypass);
BEGIN
  PERFORM extensions.dblink_connect('retry_a', 'host=' || host(inet_server_addr()) || ' port=' || current_setting('port') || ' dbname=' || current_database() || ' user=postgres password=postgres');
  PERFORM extensions.dblink_connect('retry_b', 'host=' || host(inet_server_addr()) || ' port=' || current_setting('port') || ' dbname=' || current_database() || ' user=postgres password=postgres');
  PERFORM extensions.dblink_send_query('retry_a', query);
  PERFORM extensions.dblink_send_query('retry_b', query);
  SELECT result INTO first_result FROM extensions.dblink_get_result('retry_a') AS t(result jsonb);
  SELECT result INTO second_result FROM extensions.dblink_get_result('retry_b') AS t(result jsonb);
  PERFORM extensions.dblink_disconnect('retry_a');
  PERFORM extensions.dblink_disconnect('retry_b');
  PERFORM pg_temp.check_rules(first_result IS NOT DISTINCT FROM second_result, label || ': concurrent results match');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.request_receipts r WHERE r.request_id=CASE WHEN scope IS NULL THEN id ELSE md5(id::text||':'||function_name||':'||scope)::uuid END AND r.actor=retry.actor AND r.function=function_name), label || ': one receipt');
  SELECT count(*) INTO applied FROM idempotency_test.applications WHERE request_id=id;
  PERFORM pg_temp.check_rules(applied>0, label || ': applies a write');
  replay_result := idempotency_test.apply(id, actor, expression);
  PERFORM pg_temp.check_rules(first_result IS NOT DISTINCT FROM replay_result, label || ': sequential result matches');
  replay_result := idempotency_test.apply(id, actor, expression);
  PERFORM pg_temp.check_rules(first_result IS NOT DISTINCT FROM replay_result, label || ': repeated result matches');
  PERFORM pg_temp.check_rules((SELECT count(*)=applied FROM idempotency_test.applications WHERE request_id=id), label || ': retries add no writes');
  RETURN first_result;
EXCEPTION WHEN OTHERS THEN
  IF 'retry_a'=ANY(COALESCE(extensions.dblink_get_connections(), ARRAY[]::text[])) THEN PERFORM extensions.dblink_disconnect('retry_a'); END IF;
  IF 'retry_b'=ANY(COALESCE(extensions.dblink_get_connections(), ARRAY[]::text[])) THEN PERFORM extensions.dblink_disconnect('retry_b'); END IF;
  RAISE;
END;
$$;
COMMIT;
