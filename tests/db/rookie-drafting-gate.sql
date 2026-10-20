BEGIN;
SET LOCAL statement_timeout='30s';
SELECT set_config('app.supabase_url','http://127.0.0.1:57421',true);
SELECT set_config('app.edge_internal_token','synthetic-post-gate-token',true);
DO $$
DECLARE
  usr uuid:=gen_random_uuid(); league uuid:=gen_random_uuid(); season uuid:=gen_random_uuid();
  initial_count bigint; first_count bigint; repeated_count bigint; next_count bigint;
BEGIN
  IF EXISTS(SELECT 1 FROM leagues WHERE status IN('active','playoffs','offseason','setup')) THEN
    RAISE EXCEPTION 'The drafting-only gate oracle requires an isolated empty stack';
  END IF;
  INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(usr,'authenticated','authenticated',usr||'@example.test','x',now(),'{}','{}',now(),now());
  INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(league,'Synthetic drafting cron gate',league::text,usr,'drafting');
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,8840,true);
  SELECT count(*) INTO initial_count FROM edge_invocations WHERE function_name='season-boundary';
  PERFORM invoke_season_boundary_if_due('2026-11-01 08:59:59 America/New_York');
  IF (SELECT count(*) FROM edge_invocations WHERE function_name='season-boundary')<>initial_count THEN
    RAISE EXCEPTION 'A drafting league dispatches before 09:00 ET';
  END IF;
  PERFORM invoke_season_boundary_if_due('2026-11-01 09:00:00 America/New_York');
  SELECT count(*)-initial_count INTO first_count FROM edge_invocations WHERE function_name='season-boundary';
  IF first_count<>1 THEN RAISE EXCEPTION 'Drafting-only fleet must dispatch at 09:00 ET, got %',first_count; END IF;
  PERFORM invoke_season_boundary_if_due('2026-11-01 09:00:01 America/New_York');
  PERFORM invoke_season_boundary_if_due('2026-11-01 23:59:59 America/New_York');
  PERFORM invoke_season_boundary_if_due('2026-11-02 00:00:00 America/New_York');
  SELECT count(*)-initial_count INTO repeated_count FROM edge_invocations WHERE function_name='season-boundary';
  IF repeated_count<>1 THEN RAISE EXCEPTION 'Repeated ET-day calls must keep one dispatch, got %',repeated_count; END IF;
  PERFORM invoke_season_boundary_if_due('2026-11-02 09:00:00 America/New_York');
  SELECT count(*)-initial_count INTO next_count FROM edge_invocations WHERE function_name='season-boundary';
  IF next_count<>2 THEN RAISE EXCEPTION 'The next ET day must dispatch once, got %',next_count; END IF;
  IF (SELECT attempts<>1 OR period_key<>'2026-11-02' FROM cron_dispatch_state WHERE job_key='season-boundary') THEN
    RAISE EXCEPTION 'A successful daily dispatch must not accumulate retries';
  END IF;
  RAISE NOTICE 'PASS SYNTHETIC drafting-only real dispatch counts: before=0 first=% repeats=% next-day=%',first_count,repeated_count,next_count;
END;
$$;
ROLLBACK;
