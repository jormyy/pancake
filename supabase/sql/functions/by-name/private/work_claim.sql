-- Canonical SQL source for private.work_claim.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.work_claim(p_limit integer DEFAULT 64)
RETURNS SETOF private.work_items LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_budget integer; v_count integer:=0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('private.work_claim',0)) THEN RETURN; END IF;
  FOR v_item IN SELECT * FROM private.work_items WHERE status='running' AND lease_until<=now()
    ORDER BY lease_until,id LIMIT 500 FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE private.work_items SET lease_until=now()+interval '1 second' WHERE id=v_item.id;
    PERFORM private.work_finish(v_item.id,v_item.lease_token,'Worker lease expired');
  END LOOP;
  v_budget:=greatest(0,least(p_limit,4-(SELECT count(*)::integer FROM private.work_items WHERE status='running' AND lease_until>clock_timestamp())));
  IF v_budget=0 THEN RETURN; END IF;
  WHILE v_count<v_budget LOOP
    SELECT item.* INTO v_item FROM private.work_items item
      JOIN private.work_kinds kind ON kind.kind=item.kind AND kind.retired_at IS NULL
      CROSS JOIN LATERAL (
        SELECT CASE WHEN item.kind='matchup-forecasts' THEN
          (EXISTS(SELECT 1 FROM private.forecast_refresh_requests WHERE available_at<=now())
            OR EXISTS(SELECT 1 FROM private.matchup_forecast_expiries WHERE available_at<=now()))
          AND NOT EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty AND available_at<=now()
            AND NOT private.matchup_forecast_refresh_pending(matchup_id)
            AND (claimed_at IS NULL OR claimed_at<now()-interval '3 minutes'))
          ELSE item.kind IN('trade-revaluation','trade-revaluation-check','trade-revaluation-scan','forecast-inputs','notification-scan') END AS background
      ) priority
    WHERE item.status IN ('pending','failed') AND item.due_at<=now()
      AND (item.kind NOT IN('forecast-inputs','notification-scan') OR
        (SELECT count(*) FROM private.work_items WHERE status='running' AND lease_until>clock_timestamp())<3)
      AND (item.kind<>'trade-revaluation' OR
        (NOT EXISTS(SELECT 1 FROM private.work_items running WHERE running.kind='trade-revaluation'
          AND running.status='running' AND running.lease_until>clock_timestamp() AND running.league_id IS NOT DISTINCT FROM item.league_id)
        AND NOT EXISTS(SELECT 1 FROM private.trade_revaluation_leagues pace WHERE pace.league_id=item.league_id AND pace.next_allowed_at>now())))
    ORDER BY CASE WHEN item.kind='live-poll' THEN 0 ELSE 1 END,priority.background,CASE WHEN priority.background THEN kind.last_claimed_at END NULLS FIRST,item.due_at,item.id
    LIMIT 1 FOR UPDATE OF item SKIP LOCKED;
    EXIT WHEN NOT FOUND;
    IF v_item.kind='trade-revaluation' THEN
      IF EXISTS(SELECT 1 FROM private.work_items running WHERE running.kind='trade-revaluation' AND running.status='running'
        AND running.lease_until>clock_timestamp() AND running.league_id IS NOT DISTINCT FROM v_item.league_id) THEN CONTINUE; END IF;
      IF v_item.league_id IS NOT NULL THEN
        INSERT INTO private.trade_revaluation_leagues AS pace(league_id,next_allowed_at)
          VALUES(v_item.league_id,clock_timestamp()+interval '1 minute')
          ON CONFLICT(league_id) DO UPDATE SET next_allowed_at=EXCLUDED.next_allowed_at
          WHERE pace.next_allowed_at<=clock_timestamp();
        IF NOT FOUND THEN CONTINUE; END IF;
      END IF;
    END IF;
    UPDATE private.work_items item SET status='running',attempts=attempts+1,
      lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes',invocation_key=NULL
      WHERE item.id=v_item.id RETURNING item.* INTO v_item;
    IF FOUND THEN
      IF v_item.kind IN('trade-revaluation','trade-revaluation-check','trade-revaluation-scan','forecast-inputs','notification-scan','matchup-forecasts') THEN
        UPDATE private.work_kinds SET last_claimed_at=clock_timestamp() WHERE kind=v_item.kind;
      END IF;
      RETURN NEXT v_item;
      v_count:=v_count+1;
    END IF;
  END LOOP;
END;
$$;
