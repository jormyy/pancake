-- Real roles exercise both grant denial and RLS under accidental client grants.
-- All grants, fixtures, and queued loopback requests roll back.
BEGIN;
INSERT INTO public.cron_dispatch_state (job_key, period_key)
VALUES ('internal-rls-fixture', 'fixture');
INSERT INTO public.edge_invocations (function_name)
VALUES ('internal-rls-fixture');

DO $$
DECLARE role_name text; table_name text; command text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH table_name IN ARRAY ARRAY['cron_dispatch_state', 'edge_invocations'] LOOP
      IF has_table_privilege(role_name, 'public.' || table_name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        RAISE EXCEPTION '% unexpectedly has a grant on %', role_name, table_name;
      END IF;
      EXECUTE format('SET LOCAL ROLE %I', role_name);
      IF current_user <> role_name THEN RAISE EXCEPTION 'role switch did not take effect'; END IF;
      FOREACH command IN ARRAY ARRAY[
        format('SELECT * FROM public.%I', table_name),
        format('INSERT INTO public.%I DEFAULT VALUES', table_name),
        format('UPDATE public.%I SET %I = %I', table_name,
          CASE WHEN table_name = 'cron_dispatch_state' THEN 'period_key' ELSE 'function_name' END,
          CASE WHEN table_name = 'cron_dispatch_state' THEN 'period_key' ELSE 'function_name' END),
        format('DELETE FROM public.%I', table_name)
      ] LOOP
        BEGIN
          EXECUTE command;
          RAISE EXCEPTION 'client operation unexpectedly allowed: %', command;
        EXCEPTION WHEN insufficient_privilege THEN NULL;
        END;
      END LOOP;
      RESET ROLE;
    END LOOP;
  END LOOP;
END $$;

-- The actual service role retains reads and the existing SECURITY DEFINER write path.
SELECT set_config('app.supabase_url', 'http://127.0.0.1:1', true);
SELECT set_config('app.edge_internal_token', 'internal-rls-fixture-token', true);
SET LOCAL ROLE service_role;
DO $$
BEGIN
  IF current_user <> 'service_role' THEN RAISE EXCEPTION 'service role not active'; END IF;
  IF (SELECT count(*) FROM public.cron_dispatch_state WHERE job_key = 'internal-rls-fixture') <> 1
     OR (SELECT count(*) FROM public.edge_invocations WHERE function_name = 'internal-rls-fixture') <> 1 THEN
    RAISE EXCEPTION 'service role cannot read internal fixtures';
  END IF;
  PERFORM public.invoke_edge_function_at_et_time('internal-rls-dispatch', 3, 0, '2026-01-14 03:01:00 America/New_York');
  PERFORM public.invoke_edge_function_at_et_time('internal-rls-dispatch', 3, 0, '2026-01-14 04:00:00 America/New_York');
  IF (SELECT count(*) FROM public.cron_dispatch_state WHERE job_key = 'et-time:internal-rls-dispatch') <> 1
     OR (SELECT count(*) FROM public.edge_invocations WHERE function_name = 'internal-rls-dispatch') <> 1 THEN
    RAISE EXCEPTION 'service dispatch must write once through SECURITY DEFINER';
  END IF;
END $$;
RESET ROLE;

-- A future mistaken table grant must still reveal no rows and permit no writes.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cron_dispatch_state, public.edge_invocations TO anon, authenticated;
DO $$
DECLARE role_name text; visible_rows bigint; affected bigint;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', role_name);
    SELECT count(*) INTO visible_rows FROM public.cron_dispatch_state WHERE job_key = 'internal-rls-fixture';
    IF visible_rows <> 0 THEN RAISE EXCEPTION '% can see cron dispatch data after a grant', current_user; END IF;
    SELECT count(*) INTO visible_rows FROM public.edge_invocations WHERE function_name = 'internal-rls-fixture';
    IF visible_rows <> 0 THEN RAISE EXCEPTION '% can see invocation data after a grant', current_user; END IF;
    UPDATE public.cron_dispatch_state SET period_key = 'tampered' WHERE job_key = 'internal-rls-fixture';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'client updated dispatch data'; END IF;
    UPDATE public.edge_invocations SET error_message = 'tampered' WHERE function_name = 'internal-rls-fixture';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'client updated invocation data'; END IF;
    DELETE FROM public.cron_dispatch_state WHERE job_key = 'internal-rls-fixture';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'client deleted dispatch data'; END IF;
    DELETE FROM public.edge_invocations WHERE function_name = 'internal-rls-fixture';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'client deleted invocation data'; END IF;
    BEGIN
      INSERT INTO public.cron_dispatch_state (job_key, period_key) VALUES ('internal-rls-client', 'forbidden');
      RAISE EXCEPTION 'client inserted dispatch data';
    EXCEPTION WHEN insufficient_privilege THEN
      IF SQLERRM NOT LIKE '%row-level security%' THEN RAISE; END IF;
    END;
    BEGIN
      INSERT INTO public.edge_invocations (id, function_name) OVERRIDING SYSTEM VALUE VALUES (-987654321, 'internal-rls-client');
      RAISE EXCEPTION 'client inserted invocation data';
    EXCEPTION WHEN insufficient_privilege THEN
      IF SQLERRM NOT LIKE '%row-level security%' THEN RAISE; END IF;
    END;
    RESET ROLE;
  END LOOP;
  IF (SELECT count(*) FROM pg_class WHERE oid IN ('public.cron_dispatch_state'::regclass, 'public.edge_invocations'::regclass) AND relrowsecurity) <> 2 THEN
    RAISE EXCEPTION 'both internal tables must enable RLS';
  END IF;
  IF (SELECT period_key FROM public.cron_dispatch_state WHERE job_key = 'internal-rls-fixture') IS DISTINCT FROM 'fixture'
     OR (SELECT count(*) FROM public.edge_invocations WHERE function_name = 'internal-rls-fixture' AND error_message IS NULL) <> 1 THEN
    RAISE EXCEPTION 'client tests changed internal data';
  END IF;
END $$;
ROLLBACK;
