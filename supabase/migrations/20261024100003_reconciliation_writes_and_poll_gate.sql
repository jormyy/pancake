BEGIN;

CREATE OR REPLACE FUNCTION private.reconcile_edge_invocations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reconciled integer := 0;
  v_row record;
  v_claim record;
  v_error text;
  v_run uuid;
BEGIN
  FOR v_row IN
    SELECT inv.*, resp.status_code AS response_status, resp.error_msg, resp.timed_out,
           left(resp.content, 500) AS content
      FROM public.edge_invocations AS inv
      LEFT JOIN net._http_response AS resp ON resp.id = inv.request_id
     WHERE inv.reconciled_at IS NULL AND inv.queued_at < now() - interval '1 minute'
     ORDER BY inv.queued_at LIMIT 500 FOR UPDATE OF inv SKIP LOCKED
  LOOP
    v_error := CASE
      WHEN v_row.error_msg IS NOT NULL THEN v_row.error_msg
      WHEN v_row.timed_out IS TRUE THEN 'timed out'
      WHEN v_row.response_status NOT BETWEEN 200 AND 299
        THEN 'HTTP ' || v_row.response_status || ': ' || COALESCE(v_row.content, '')
      ELSE NULL END;
    UPDATE public.edge_invocations
       SET status_code = v_row.response_status, error_message = v_error
     WHERE id = v_row.id
       AND (status_code, error_message) IS DISTINCT FROM (v_row.response_status, v_error);

    IF v_row.worker_started_at IS NOT NULL THEN
      IF v_row.worker_finished_at IS NULL THEN
        IF v_row.worker_started_at >= now() - interval '10 minutes' THEN CONTINUE; END IF;
        UPDATE public.sync_runs SET status = 'failed', finished_at = now(),
          error = 'worker did not finish within 10 minutes' WHERE id = v_row.sync_run_id;
        UPDATE public.edge_invocations SET worker_status = 'failed' WHERE id = v_row.id;
      END IF;
    ELSIF v_row.response_status BETWEEN 200 AND 299 AND v_error IS NULL THEN
      NULL;
    ELSE
      IF v_row.invocation_key IS NOT NULL AND v_row.queued_at >= now() - interval '10 minutes' THEN
        CONTINUE;
      END IF;
      IF v_error IS NULL THEN
        IF v_row.invocation_key IS NULL AND v_row.queued_at >= now() - interval '2 hours' THEN CONTINUE; END IF;
        v_error := CASE WHEN v_row.invocation_key IS NULL THEN
          'no response recorded within 2 hours (request never sent or pg_net purged it)'
          ELSE 'no worker or response recorded within 10 minutes' END;
      END IF;
      INSERT INTO public.sync_runs (function_name, started_at, finished_at, status, error)
      VALUES ('cron:' || v_row.function_name, v_row.queued_at, now(), 'failed', v_error)
      RETURNING id INTO v_run;
      UPDATE public.edge_invocations SET sync_run_id = v_run, error_message = v_error WHERE id = v_row.id;
    END IF;
    UPDATE public.edge_invocations SET reconciled_at = now() WHERE id = v_row.id;
    v_reconciled := v_reconciled + 1;
  END LOOP;

  FOR v_claim IN
    SELECT * FROM public.cron_dispatch_state WHERE attempts < 3 FOR UPDATE SKIP LOCKED
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.edge_invocations WHERE dispatch_job_key = v_claim.job_key
       AND dispatch_period_key = v_claim.period_key AND dispatch_claimed_at = v_claim.dispatched_at
    ) AND NOT EXISTS (
      SELECT 1 FROM public.edge_invocations WHERE dispatch_job_key = v_claim.job_key
       AND dispatch_period_key = v_claim.period_key AND dispatch_claimed_at = v_claim.dispatched_at
       AND reconciled_at IS NULL
    ) THEN
      IF EXISTS (
        SELECT 1 FROM public.edge_invocations WHERE dispatch_job_key = v_claim.job_key
         AND dispatch_period_key = v_claim.period_key AND dispatch_claimed_at = v_claim.dispatched_at
         AND (worker_status = 'failed' OR (worker_status IS NULL
           AND (status_code IS NULL OR status_code NOT BETWEEN 200 AND 299)))
      ) THEN
        UPDATE public.cron_dispatch_state SET retry_after = clock_timestamp() + interval '5 minutes'
         WHERE job_key = v_claim.job_key AND retry_after IS NULL;
      ELSE
        UPDATE public.cron_dispatch_state SET retry_after = NULL
         WHERE job_key = v_claim.job_key AND retry_after IS NOT NULL;
      END IF;
    END IF;
  END LOOP;
  RETURN v_reconciled;
END;
$$;


CREATE OR REPLACE FUNCTION public.invoke_live_poll_if_due()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.live_poll_leases WHERE lock_key = 779001 AND expires_at > clock_timestamp()) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.get_live_poll_work()) THEN
    PERFORM public.invoke_edge_function('live-poll');
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.edge_invocations
    WHERE function_name = 'sync-scores' AND queued_at > clock_timestamp() - interval '30 minutes') THEN
    RETURN;
  END IF;
  IF EXISTS (
    WITH candidates AS MATERIALIZED (
      SELECT season.id, matchup.week_number, week.week_end, bool_and(matchup.is_finalized) AS is_finalized
      FROM public.league_seasons season
      JOIN public.leagues league ON league.id = season.league_id
      JOIN public.matchups matchup ON matchup.league_season_id = season.id
      JOIN public.season_weeks week ON week.season_year = season.season_year
        AND week.week_number = COALESCE(matchup.end_week_number, matchup.week_number)
      WHERE season.is_current AND league.status IN ('active', 'playoffs') AND NOT matchup.is_voided
        AND (matchup.matchup_type = 'regular_season' OR NOT private.playoff_matchup_is_consumed(matchup.id))
        AND NOT EXISTS (SELECT 1 FROM public.matchups final
          WHERE final.league_season_id = season.id AND final.matchup_type = 'playoff_final'
            AND final.is_finalized AND NOT final.is_voided)
        AND NOT (matchup.week_number = ANY(season.skipped_weeks))
        AND NOT EXISTS (SELECT 1 FROM private.retired_score_inputs retired WHERE retired.league_season_id = season.id)
        AND week.week_end <= (clock_timestamp() AT TIME ZONE 'America/New_York')::date
      GROUP BY season.id, matchup.week_number, week.week_end
    ), season_tokens AS MATERIALIZED (
      SELECT candidate.id,
        CASE WHEN NOT EXISTS (
          SELECT 1 FROM public.matchups stored WHERE stored.league_season_id = candidate.id
            AND stored.matchup_type <> 'regular_season'
        ) THEN private.score_input_token(candidate.id, max(candidate.week_number)) END AS input_token
      FROM candidates candidate GROUP BY candidate.id
    )
    SELECT 1 FROM candidates candidate
    JOIN season_tokens season_token ON season_token.id = candidate.id
    LEFT JOIN private.score_week_certificates certificate
      ON certificate.league_season_id = candidate.id AND certificate.week_number = candidate.week_number
    WHERE NOT candidate.is_finalized
      OR candidate.week_end >= (clock_timestamp() AT TIME ZONE 'America/New_York')::date - 4
      OR certificate.input_token IS NULL
      OR certificate.input_token IS DISTINCT FROM CASE WHEN season_token.input_token IS NULL
        THEN private.score_input_token(candidate.id, candidate.week_number)
        ELSE (SELECT jsonb_object_agg(input.key, input.value) FROM jsonb_each(season_token.input_token) input
          WHERE CASE WHEN split_part(input.key, ':', 1) IN ('nba', 'lineup', 'result')
            THEN split_part(input.key, ':', 3)::int <= candidate.week_number ELSE true END)
      END
  ) THEN
    PERFORM public.invoke_edge_function('sync-scores');
  END IF;
END;
$$;

COMMIT;
