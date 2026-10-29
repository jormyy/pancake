CREATE SCHEMA IF NOT EXISTS perf_lab;
CREATE TABLE IF NOT EXISTS perf_lab.metrics_boundaries(name text,phase text,at timestamptz,PRIMARY KEY(name,phase));
CREATE TABLE IF NOT EXISTS perf_lab.metrics_seen(name text,phase text,PRIMARY KEY(name,phase));
TRUNCATE perf_lab.metrics_seen,perf_lab.metrics_boundaries;
CREATE OR REPLACE FUNCTION perf_lab.tag_job() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE job text:=nullif(current_setting('request.headers',true),'')::jsonb->>'x-l4c-job';
  v_window text; v_at timestamptz;
BEGIN
  PERFORM pg_stat_force_next_flush();
  IF job IS NULL OR job !~ '^[a-z0-9-]+$' OR to_regprocedure('season_sim.time(timestamptz)') IS NULL
    OR to_regprocedure('pg_catalog.season_sim_native_now()') IS NULL THEN RETURN; END IF;
  v_at:=season_sim.time();
  SELECT beginning.name INTO v_window FROM perf_lab.metrics_boundaries beginning JOIN perf_lab.metrics_boundaries ending USING(name)
    WHERE beginning.phase='before' AND ending.phase='after' AND v_at>=beginning.at AND v_at<ending.at;
  IF v_window IS NOT NULL THEN
    PERFORM set_config('application_name','l4c:'||v_window||':'||job,true);
    PERFORM set_config('log_min_duration_statement','0',true);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION perf_lab.tag_job() FROM PUBLIC;
GRANT USAGE ON SCHEMA perf_lab TO authenticator,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION perf_lab.tag_job() TO authenticator,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION perf_lab.observe_boundary() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE boundary record; payload jsonb; v_at timestamptz;
BEGIN
  IF to_regprocedure('season_sim.time(timestamptz)') IS NULL
    OR to_regprocedure('pg_catalog.season_sim_native_now()') IS NULL THEN RETURN; END IF;
  v_at:=season_sim.time();
  FOR boundary IN SELECT b.* FROM perf_lab.metrics_boundaries b WHERE b.at<=v_at AND NOT EXISTS(
    SELECT FROM perf_lab.metrics_seen s WHERE s.name=b.name AND s.phase=b.phase) ORDER BY b.at,b.name LOOP
    PERFORM pg_stat_clear_snapshot();
    SELECT jsonb_build_object('name',boundary.name,'phase',boundary.phase,'expectedAt',boundary.at,'at',v_at,
      'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',funcname,'calls',calls,'ms',total_time)),'[]')
        FROM pg_stat_user_functions WHERE funcname IN ('roll_setup_league_seasons','reconcile_edge_invocations','public_prune_read_log')),
      'vacuum',(SELECT jsonb_build_object('calls',coalesce(sum(calls),0),'ms',coalesce(sum(total_exec_time),0))
        FROM extensions.pg_stat_statements WHERE ltrim(query) ILIKE 'VACUUM%net._http_response%')) INTO payload;
    INSERT INTO perf_lab.metrics_seen VALUES(boundary.name,boundary.phase);
    RAISE LOG 'L4C_BOUNDARY %',payload;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION perf_lab.observe_boundary() FROM PUBLIC;
ALTER ROLE authenticator SET pgrst.db_pre_request='perf_lab.tag_job';
NOTIFY pgrst,'reload config';
