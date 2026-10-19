BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='2min';

CREATE TABLE private.league_hint_pending (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id uuid NOT NULL,
  details jsonb CHECK(details IS NULL OR (jsonb_typeof(details)='array' AND jsonb_array_length(details) BETWEEN 1 AND 16 AND octet_length(details::text)<=4096)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX league_hint_pending_created_idx ON private.league_hint_pending(created_at,id);
CREATE INDEX league_hint_pending_league_idx ON private.league_hint_pending(league_id,created_at,id);
ALTER TABLE private.league_hint_pending ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.league_hint_pending FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.publish_league_inventory_hint(p_league_id uuid,p_details jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  BEGIN
    IF pg_try_advisory_xact_lock(hashtextextended('league-inventory-hint:'||p_league_id::text,0)) THEN
      PERFORM 1 FROM public.league_change_hints
        WHERE league_id=p_league_id AND topic='inventory' FOR UPDATE NOWAIT;
      INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details)
        VALUES(p_league_id,'inventory',1,NULL,p_details)
      ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,
        scopes=NULL,details=EXCLUDED.details,updated_at=clock_timestamp();
      RETURN;
    END IF;
  EXCEPTION WHEN serialization_failure OR lock_not_available THEN
    NULL;
  END;
  INSERT INTO private.league_hint_pending(league_id,details) VALUES(p_league_id,p_details);
END;
$$;

CREATE OR REPLACE FUNCTION private.flush_league_inventory_hints(p_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit,1000),0),5000);
  v_league_id uuid;
  v_ids uuid[];
  v_details jsonb;
  v_processed integer := 0;
BEGIN
  FOR v_league_id IN
    SELECT DISTINCT pending.league_id FROM (
      SELECT league_id FROM private.league_hint_pending ORDER BY created_at,id LIMIT v_limit
    ) pending ORDER BY pending.league_id
  LOOP
    EXIT WHEN v_processed>=v_limit;
    BEGIN
      IF NOT pg_try_advisory_xact_lock(hashtextextended('league-inventory-hint:'||v_league_id::text,0)) THEN
        CONTINUE;
      END IF;
      SELECT array_agg(pending.id) INTO v_ids FROM (
        SELECT id FROM private.league_hint_pending WHERE league_id=v_league_id
          ORDER BY created_at,id LIMIT v_limit-v_processed FOR UPDATE SKIP LOCKED
      ) pending;
      IF v_ids IS NULL THEN CONTINUE; END IF;
      IF EXISTS(SELECT 1 FROM public.leagues WHERE id=v_league_id AND deleted_at IS NULL) THEN
        v_details := NULL;
        IF cardinality(v_ids)=1 THEN
          SELECT details INTO v_details FROM private.league_hint_pending WHERE id=v_ids[1];
        END IF;
        PERFORM 1 FROM public.league_change_hints
          WHERE league_id=v_league_id AND topic='inventory' FOR UPDATE NOWAIT;
        INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details)
          VALUES(v_league_id,'inventory',cardinality(v_ids),NULL,v_details)
        ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+EXCLUDED.revision,
          scopes=NULL,details=EXCLUDED.details,updated_at=clock_timestamp();
      END IF;
      DELETE FROM private.league_hint_pending WHERE id=ANY(v_ids);
      v_processed := v_processed+cardinality(v_ids);
    EXCEPTION WHEN serialization_failure OR lock_not_available THEN
      NULL;
    END;
  END LOOP;
  RETURN v_processed;
END;
$$;

CREATE OR REPLACE FUNCTION private.emit_league_inventory_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows text; v_details text; v_change record;
BEGIN
  IF TG_OP='INSERT' THEN v_rows := 'SELECT * FROM new_rows';
  ELSIF TG_OP='DELETE' THEN v_rows := 'SELECT * FROM old_rows';
  ELSE
    v_rows := $rows$SELECT n.* FROM new_rows n JOIN old_rows o USING(id)
      WHERE (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')
      UNION ALL SELECT o.* FROM old_rows o JOIN new_rows n USING(id)
      WHERE (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')$rows$;
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'draft_picks' THEN
      v_details := $details$SELECT pick.league_id,
        CASE WHEN season.id IS NOT NULL THEN jsonb_build_object(
          'resource','picks','season_id',season.id,'member_id',pick.current_owner_id) END AS detail
        FROM changed pick LEFT JOIN public.league_seasons season
          ON season.league_id=pick.league_id AND season.season_year=pick.season_year$details$;
    WHEN 'waiver_claims' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','claims','season_id',league_season_id) AS detail FROM changed$details$;
    WHEN 'waiver_wire_log' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','waivers','season_id',league_season_id) AS detail FROM changed$details$;
    WHEN 'waiver_priorities' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','priority','season_id',league_season_id,'member_id',member_id) AS detail FROM changed$details$;
    WHEN 'faab_balances' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','faab','season_id',league_season_id,'member_id',member_id) AS detail FROM changed$details$;
    WHEN 'league_seasons' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','season','season_id',id) AS detail FROM changed$details$;
    ELSE
      v_details := 'SELECT league_id,NULL::jsonb AS detail FROM changed';
  END CASE;
  FOR v_change IN EXECUTE format($query$
    WITH changed AS (%s),details AS (%s),distinct_details AS (
      SELECT DISTINCT details.league_id,details.detail FROM details
      JOIN public.leagues league ON league.id=details.league_id AND league.deleted_at IS NULL
    ) SELECT league_id,CASE WHEN count(*)<=16 AND bool_and(detail IS NOT NULL)
        THEN jsonb_agg(detail ORDER BY detail::text) END AS details
      FROM distinct_details GROUP BY league_id ORDER BY league_id
  $query$,v_rows,v_details) LOOP
    PERFORM private.publish_league_inventory_hint(v_change.league_id,v_change.details);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_unbounded_history()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sync_runs bigint := 0;
  v_edge_invocations bigint := 0;
  v_cron_runs bigint := 0;
  v_functions text[] := ARRAY['live-poll','sync-stats','sync-scores','close-expired-nominations','process-trades','source:nba-cdn-scoreboard'];
  v_cron_jobs text[] := ARRAY['nba-live-poll','nba-sync-stats','nba-sync-scores','nba-close-expired-nominations','nba-process-trades','nba-dispatch-stats-sync-jobs','edge-invocation-reconcile','pg-net-response-vacuum','league-inventory-hint-drain'];
BEGIN
  DELETE FROM public.sync_runs
   WHERE function_name = ANY(v_functions)
     AND status = 'success'
     AND error IS NULL
     AND finished_at < now() - interval '7 days';
  GET DIAGNOSTICS v_sync_runs = ROW_COUNT;

  DELETE FROM public.edge_invocations
   WHERE function_name = ANY(v_functions)
     AND status_code BETWEEN 200 AND 299
     AND error_message IS NULL
     AND worker_status IS DISTINCT FROM 'failed'
     AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL)
     AND reconciled_at < now() - interval '7 days';
  GET DIAGNOSTICS v_edge_invocations = ROW_COUNT;

  IF to_regclass('cron.job_run_details') IS NOT NULL THEN
    DELETE FROM cron.job_run_details AS run
     WHERE run.status = 'succeeded'
       AND run.end_time < now() - interval '7 days'
       AND (
         EXISTS (SELECT 1 FROM cron.job AS job WHERE job.jobid = run.jobid AND job.jobname = ANY(v_cron_jobs))
         OR (
           NOT EXISTS (SELECT 1 FROM cron.job AS job WHERE job.jobid = run.jobid)
           AND (run.command ~* '^\s*select\s+(public\.)?invoke_edge_function\(\s*''(live-poll|sync-stats|sync-scores|close-expired-nominations|process-trades)''\s*(,.*)?\s*\)\s*;?\s*$'
             OR run.command ~* '^\s*select\s+(public\.)?invoke_lineup_optimizer_if_due\(\s*\)\s*;?\s*$')
         )
       );
    GET DIAGNOSTICS v_cron_runs = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'sync_runs', v_sync_runs,
    'edge_invocations', v_edge_invocations,
    'cron_job_run_details', v_cron_runs,
    'projection_sync_runs', 0,
    'weekly_lineups', 0,
    'standings', 0,
    'roster_transactions', 0,
    'dynasty_news', 0
  );
END;
$$;

REVOKE ALL ON FUNCTION private.publish_league_inventory_hint(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.flush_league_inventory_hints(integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.emit_league_inventory_change() FROM PUBLIC,anon,authenticated,service_role;
SELECT cron.schedule('league-inventory-hint-drain','10 seconds','SELECT private.flush_league_inventory_hints(1000)');

COMMIT;
