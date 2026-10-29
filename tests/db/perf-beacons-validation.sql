BEGIN;

CREATE TEMP TABLE beacon_checks(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.check_beacon(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  INSERT INTO beacon_checks VALUES(label);
END;
$$;

INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000095001', 'authenticated', 'authenticated', 'beacon@example.test', 'x', now(), '{}', '{"username":"beacon_fixture"}', now(), now());
INSERT INTO public.leagues(id, name, slug, invite_code, commissioner_id, status)
VALUES ('00000000-0000-0000-0000-000000095101', 'Beacon fixture', 'beacon-fixture', NULL, '00000000-0000-0000-0000-000000095001', 'active');
INSERT INTO public.league_members(id, league_id, user_id, role, team_name)
VALUES ('00000000-0000-0000-0000-000000095201', '00000000-0000-0000-0000-000000095101', '00000000-0000-0000-0000-000000095001', 'commissioner', 'Beacon');

CREATE FUNCTION pg_temp.insert_beacon(payload jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.perf_beacons(member_id, screen, useful_ms, request_count, transfer_bytes, bytes_complete, cold, device_class, connection_type, app_version, sample_n)
  SELECT member_id, screen, useful_ms, request_count, transfer_bytes, bytes_complete, cold, device_class, connection_type, app_version, sample_n
  FROM jsonb_populate_record(NULL::public.perf_beacons, payload);
$$;

DO $$
DECLARE
  base jsonb := '{"member_id":"00000000-0000-0000-0000-000000095201","screen":"roster","useful_ms":100,"request_count":2,"transfer_bytes":1024,"bytes_complete":true,"cold":true,"device_class":"phone","connection_type":"4g","app_version":"1.0.0","sample_n":1}';
  patch jsonb;
  denied boolean;
  caller text;
BEGIN
  PERFORM pg_temp.insert_beacon(base);
  PERFORM pg_temp.check_beacon((SELECT count(*) = 1 FROM public.perf_beacons WHERE member_id = '00000000-0000-0000-0000-000000095201'), 'valid row accepted');
  FOR patch IN SELECT value FROM jsonb_array_elements('[{"screen":"/player/private-id"},{"useful_ms":-1},{"useful_ms":120001},{"request_count":-1},{"request_count":10001},{"transfer_bytes":-1},{"transfer_bytes":1000000001},{"sample_n":0},{"sample_n":10001},{"device_class":"exact-model"},{"connection_type":"wifi-name"},{"app_version":"email@example.test"},{"cold":null},{"bytes_complete":null},{"member_id":null},{"member_id":"00000000-0000-0000-0000-000000095999"},{"screen":null}]') LOOP
    denied := false;
    BEGIN
      PERFORM pg_temp.insert_beacon(base || patch);
    EXCEPTION WHEN check_violation OR not_null_violation OR foreign_key_violation THEN denied := true;
    END;
    PERFORM pg_temp.check_beacon(denied, 'malformed row rejected: ' || patch::text);
  END LOOP;
  FOREACH caller IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', caller);
    denied := false;
    BEGIN
      PERFORM pg_temp.insert_beacon(base);
    EXCEPTION WHEN insufficient_privilege THEN denied := true;
    END;
    RESET ROLE;
    PERFORM pg_temp.check_beacon(denied, caller || ' cannot insert directly');
    EXECUTE format('SET LOCAL ROLE %I', caller);
    denied := false;
    BEGIN
      PERFORM public.perf_summary(7);
    EXCEPTION WHEN insufficient_privilege THEN denied := true;
    END;
    RESET ROLE;
    PERFORM pg_temp.check_beacon(denied, caller || ' cannot read global metrics');
  END LOOP;
END;
$$;

DELETE FROM public.perf_beacons WHERE member_id = '00000000-0000-0000-0000-000000095201';
INSERT INTO public.perf_beacons(member_id, screen, useful_ms, request_count, transfer_bytes, bytes_complete, cold, device_class, connection_type, app_version, sample_n, received_at)
SELECT '00000000-0000-0000-0000-000000095201', screen, duration, 1, 1024, true, false, 'desktop', 'unknown', '1.0.0', 1,
  date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - age
FROM (VALUES ('roster', 100, interval '0 days'), ('roster', 200, interval '0 days'), ('roster', 300, interval '0 days'),
  ('roster', 400, interval '0 days'), ('players', 900, interval '0 days'), ('roster', 700, interval '1 day'),
  ('roster', 800, interval '31 days')) fixture(screen, duration, age);

SELECT pg_temp.check_beacon((SELECT samples = 4 AND p50_ms = 250 AND p95_ms = 385 FROM public.perf_summary(1) WHERE screen = 'roster' AND day = (now() AT TIME ZONE 'UTC')::date), 'p50 and p95 interpolate correctly');
SELECT pg_temp.check_beacon((SELECT samples = 1 AND p50_ms = 900 AND p95_ms = 900 FROM public.perf_summary(1) WHERE screen = 'players'), 'screens remain separate');
SELECT pg_temp.check_beacon((SELECT count(*) = 3 FROM public.perf_summary(2)), 'UTC days remain separate');
SELECT pg_temp.check_beacon((SELECT count(*) = 2 FROM public.perf_summary(1)), 'day filter excludes yesterday');
DO $$
DECLARE days integer; denied boolean;
BEGIN
  FOREACH days IN ARRAY ARRAY[0, 31, NULL::integer] LOOP
    denied := false;
    BEGIN PERFORM public.perf_summary(days); EXCEPTION WHEN invalid_parameter_value THEN denied := true; END;
    PERFORM pg_temp.check_beacon(denied, 'invalid day range: ' || coalesce(days::text, 'null'));
  END LOOP;
END;
$$;

DELETE FROM private.work_items WHERE kind='retention-prune';
SELECT private.enqueue_scheduled_work(((now() AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC'+interval '11 hours');
SELECT pg_temp.check_beacon(EXISTS(SELECT FROM private.work_items WHERE kind='retention-prune')
  AND EXISTS(SELECT FROM private.retention_rules WHERE relation_name='public.perf_beacons' AND worker='retain_perf_beacons'), 'daily retention work includes beacon pruning');
SELECT private.prune_perf_beacons();
SET LOCAL ROLE service_role;
SELECT * FROM public.perf_summary(30);
RESET ROLE;
SELECT pg_temp.check_beacon((SELECT count(*) = 6 FROM public.perf_beacons WHERE member_id = '00000000-0000-0000-0000-000000095201'), 'only rows older than thirty days expire');
SELECT count(*) AS passed FROM beacon_checks;
ROLLBACK;
