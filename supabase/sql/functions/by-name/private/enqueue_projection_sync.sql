CREATE OR REPLACE FUNCTION private.enqueue_projection_sync(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_work record;
BEGIN
  FOR v_work IN SELECT * FROM private.projection_sync_due_work(p_now) LOOP
    PERFORM private.work_enqueue(v_work.job_key,v_work.period_key,p_now);
  END LOOP;
END;
$$;
