\set ON_ERROR_STOP on
\getenv post_test_api_url SUPABASE_URL
\getenv post_test_db_url SUPABASE_DB_URL
\getenv post_test_api_port PANCAKE_TEST_API_PORT
\getenv post_test_db_port PANCAKE_TEST_DB_PORT
\if :{?post_test_api_url}
\else
  \echo SUPABASE_URL is required
  DO $$ BEGIN RAISE EXCEPTION 'Database test configuration is missing or invalid.'; END $$;
\endif
\if :{?post_test_db_url}
\else
  \echo SUPABASE_DB_URL is required
  DO $$ BEGIN RAISE EXCEPTION 'Database test configuration is missing or invalid.'; END $$;
\endif
\if :{?post_test_api_port}
\else
  \set post_test_api_port 54321
\endif
\if :{?post_test_db_port}
\else
  \set post_test_db_port 54322
\endif
BEGIN;
SET LOCAL statement_timeout='30s';
SELECT set_config('app.supabase_url', :'post_test_api_url',true);
SELECT set_config('post.test_api_port', :'post_test_api_port',true) \gset
SELECT set_config('post.test_db_url', :'post_test_db_url',true) \gset
SELECT set_config('post.test_db_port', :'post_test_db_port',true) \gset
SELECT set_config('app.edge_internal_token','synthetic-post-gate-token',true);
DO $$
DECLARE
  usr uuid:=gen_random_uuid(); league uuid:=gen_random_uuid(); season uuid:=gen_random_uuid();
  initial_count bigint; first_count bigint; repeated_count bigint; next_count bigint;
BEGIN
  IF current_setting('post.test_api_port') !~ '^[0-9]+$' OR current_setting('post.test_db_port') !~ '^[0-9]+$'
    OR current_setting('app.supabase_url') !~ format('^http://(127[.]0[.]0[.]1|localhost):%s/?$',current_setting('post.test_api_port'))
    OR current_setting('post.test_db_url') !~ format('^postgres(ql)?://[^/@]+@(127[.]0[.]0[.]1|localhost):%s/[^?]+([?].*)?$',current_setting('post.test_db_port')) THEN
    RAISE EXCEPTION 'Only the expected loopback API and database ports are allowed';
  END IF;
  UPDATE leagues SET status='archived' WHERE status IN('active','playoffs','offseason','setup','drafting');
  DELETE FROM cron_dispatch_state WHERE job_key='season-boundary';
  INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(usr,'authenticated','authenticated',usr||'@example.test','x',now(),'{}','{}',now(),now());
  INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(league,'Synthetic drafting cron gate',league::text,usr,'drafting');
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,8840,true);
  SELECT count(*) INTO initial_count FROM edge_invocations WHERE function_name='season-boundary' AND xmin::text=pg_current_xact_id()::text;
  PERFORM invoke_season_boundary_if_due('2026-11-01 08:59:59 America/New_York');
  IF (SELECT count(*) FROM edge_invocations WHERE function_name='season-boundary' AND xmin::text=pg_current_xact_id()::text)<>initial_count THEN
    RAISE EXCEPTION 'A drafting league dispatches before 09:00 ET';
  END IF;
  PERFORM invoke_season_boundary_if_due('2026-11-01 09:00:00 America/New_York');
  SELECT count(*)-initial_count INTO first_count FROM edge_invocations WHERE function_name='season-boundary' AND xmin::text=pg_current_xact_id()::text;
  IF first_count<>1 THEN RAISE EXCEPTION 'Drafting-only fleet must dispatch at 09:00 ET, got %',first_count; END IF;
  PERFORM invoke_season_boundary_if_due('2026-11-01 09:00:01 America/New_York');
  PERFORM invoke_season_boundary_if_due('2026-11-01 23:59:59 America/New_York');
  PERFORM invoke_season_boundary_if_due('2026-11-02 00:00:00 America/New_York');
  SELECT count(*)-initial_count INTO repeated_count FROM edge_invocations WHERE function_name='season-boundary' AND xmin::text=pg_current_xact_id()::text;
  IF repeated_count<>1 THEN RAISE EXCEPTION 'Repeated ET-day calls must keep one dispatch, got %',repeated_count; END IF;
  PERFORM invoke_season_boundary_if_due('2026-11-02 09:00:00 America/New_York');
  SELECT count(*)-initial_count INTO next_count FROM edge_invocations WHERE function_name='season-boundary' AND xmin::text=pg_current_xact_id()::text;
  IF next_count<>2 THEN RAISE EXCEPTION 'The next ET day must dispatch once, got %',next_count; END IF;
  IF (SELECT attempts<>1 OR period_key<>'2026-11-02' FROM cron_dispatch_state WHERE job_key='season-boundary') THEN
    RAISE EXCEPTION 'A successful daily dispatch must not accumulate retries';
  END IF;
  RAISE NOTICE 'PASS SYNTHETIC drafting-only real dispatch counts: before=0 first=% repeats=% next-day=%',first_count,repeated_count,next_count;
END;
$$;
ROLLBACK;
