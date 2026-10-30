-- Canonical SQL source for private.delete_projection_runs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.delete_projection_runs(p_ids uuid[],p_row_budget integer DEFAULT 10000)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_run uuid; v_rows integer:=0; v_runs integer:=0; v_count integer; v_batch integer;
  v_previous text:=COALESCE(current_setting('pancake.projection_cleanup',true),'');
BEGIN
  PERFORM set_config('pancake.projection_cleanup','on',true);
  FOR v_run IN SELECT id FROM public.projection_sync_runs WHERE id=ANY(p_ids)
    ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED
  LOOP
    LOOP
      v_batch:=LEAST(500,GREATEST(p_row_budget-v_rows,0));
      EXIT WHEN v_batch=0;
      WITH victims AS (
        SELECT id FROM public.fantasypros_projection_rows WHERE run_id=v_run
        ORDER BY id LIMIT v_batch FOR UPDATE SKIP LOCKED
      ) DELETE FROM public.fantasypros_projection_rows r USING victims v WHERE r.id=v.id;
      GET DIAGNOSTICS v_count=ROW_COUNT;
      v_rows:=v_rows+v_count;
      EXIT WHEN v_count<v_batch;
    END LOOP;
    DELETE FROM public.projection_sync_runs r WHERE id=v_run
      AND NOT EXISTS(SELECT 1 FROM public.fantasypros_projection_rows p WHERE p.run_id=r.id);
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_runs:=v_runs+v_count;
    EXIT WHEN v_rows>=p_row_budget;
  END LOOP;
  PERFORM set_config('pancake.projection_cleanup',v_previous,true);
  RETURN jsonb_build_object('projection_sync_runs',v_runs,'fantasypros_projection_rows',v_rows);
END;
$$;
