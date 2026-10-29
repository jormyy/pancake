BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE TABLE private.trade_revaluation_leagues(
  league_id uuid PRIMARY KEY REFERENCES public.leagues(id) ON DELETE CASCADE,
  next_allowed_at timestamptz NOT NULL
);
ALTER TABLE private.trade_revaluation_leagues OWNER TO postgres;
ALTER TABLE private.trade_revaluation_leagues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.trade_revaluation_leagues FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX work_items_revaluation_running ON private.work_items(league_id,lease_until)
  WHERE kind='trade-revaluation' AND status='running';
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
  FOR v_item IN SELECT item.* FROM private.work_items item
    WHERE item.status IN ('pending','failed') AND item.due_at<=now()
      AND NOT EXISTS(SELECT 1 FROM private.work_kinds kind WHERE kind.kind=item.kind AND kind.retired_at IS NOT NULL)
      AND (item.kind<>'trade-revaluation' OR
        (NOT EXISTS(SELECT 1 FROM private.work_items running WHERE running.kind='trade-revaluation'
          AND running.status='running' AND running.lease_until>clock_timestamp() AND running.league_id IS NOT DISTINCT FROM item.league_id)
        AND NOT EXISTS(SELECT 1 FROM private.trade_revaluation_leagues pace WHERE pace.league_id=item.league_id AND pace.next_allowed_at>now())))
    ORDER BY (item.kind IN ('trade-revaluation','trade-revaluation-check','trade-revaluation-scan')),item.due_at,item.id
    LIMIT 128 FOR UPDATE SKIP LOCKED
  LOOP
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
      RETURN NEXT v_item;
      v_count:=v_count+1;
      EXIT WHEN v_count>=v_budget;
    END IF;
  END LOOP;
END;
$$;
COMMIT;
