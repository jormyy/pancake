-- Canonical SQL source for private.run_retention.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.run_retention(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE
  v_rule record; v_entry record; v_counts jsonb; v_result jsonb:='{}'::jsonb;
  v_started timestamptz:=clock_timestamp(); v_error text;
BEGIN
  IF p_now IS NULL THEN RAISE EXCEPTION 'A retention time is required.' USING ERRCODE='22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('private.run_retention',0)) THEN
    RETURN jsonb_build_object('busy',true);
  END IF;
  FOR v_rule IN SELECT rules.* FROM private.retention_rules rules
    LEFT JOIN private.retention_status status USING(relation_name)
    WHERE rules.worker IS NOT NULL
    ORDER BY status.last_checked_at NULLS FIRST,rules.run_order,rules.relation_name
  LOOP
    EXIT WHEN clock_timestamp()-v_started>=interval '2 seconds';
    BEGIN
      EXECUTE format('SELECT private.%I($1)',v_rule.worker) INTO v_counts USING p_now;
      FOR v_entry IN SELECT key,value::bigint AS removed FROM jsonb_each_text(v_counts) LOOP
        INSERT INTO private.retention_status AS state(relation_name,last_checked_at,last_pruned_at,rows_pruned,last_rows_pruned,last_error)
        VALUES(v_entry.key,p_now,CASE WHEN v_entry.removed>0 THEN p_now END,v_entry.removed,v_entry.removed,NULL)
        ON CONFLICT(relation_name) DO UPDATE SET last_checked_at=p_now,
          last_pruned_at=COALESCE(EXCLUDED.last_pruned_at,state.last_pruned_at),
          rows_pruned=state.rows_pruned+EXCLUDED.rows_pruned,last_rows_pruned=EXCLUDED.last_rows_pruned,last_error=NULL;
      END LOOP;
      v_result:=v_result||v_counts;
    EXCEPTION WHEN OTHERS OR query_canceled THEN
      v_error:=left(SQLSTATE||': '||SQLERRM,1000);
      INSERT INTO private.retention_status AS state(relation_name,last_checked_at,last_error)
      VALUES(v_rule.relation_name,p_now,v_error)
      ON CONFLICT(relation_name) DO UPDATE SET last_checked_at=p_now,last_error=EXCLUDED.last_error;
      v_result:=v_result||jsonb_build_object(v_rule.relation_name,jsonb_build_object('error',v_error));
      IF SQLSTATE='57014' THEN RETURN v_result; END IF;
    END;
  END LOOP;
  RETURN v_result;
END;
$$;
