CREATE TABLE private.worker_controls (id boolean PRIMARY KEY DEFAULT true CHECK(id), paused boolean NOT NULL DEFAULT false, changed_at timestamptz NOT NULL DEFAULT clock_timestamp(), reason text);
INSERT INTO private.worker_controls(id) VALUES(true);
REVOKE ALL ON private.worker_controls FROM PUBLIC,anon,authenticated;
GRANT SELECT ON private.worker_controls TO service_role;

CREATE OR REPLACE FUNCTION public.set_worker_paused(p_paused boolean, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '250ms' SET statement_timeout = '3s' AS $$
DECLARE result jsonb;
BEGIN
  IF p_paused IS NULL THEN RAISE EXCEPTION 'A pause state is required.' USING ERRCODE='22023'; END IF;
  UPDATE private.worker_controls SET paused=p_paused,changed_at=clock_timestamp(),reason=left(p_reason,1000) WHERE id
    RETURNING jsonb_build_object('paused',paused,'changedAt',changed_at,'reason',reason) INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.set_worker_paused(boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_worker_paused(boolean,text) TO service_role;

CREATE OR REPLACE FUNCTION public.dispatch_work()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_count integer:=0; v_claimed integer;
BEGIN
  IF (SELECT paused FROM private.worker_controls WHERE id) THEN RETURN 0; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('public.dispatch_work',0)) THEN RETURN 0; END IF;
  PERFORM private.enqueue_scheduled_work(now());
  LOOP
  v_claimed:=0;
  FOR v_item IN SELECT * FROM private.work_claim(64-v_count) LOOP
    BEGIN
      PERFORM private.work_execute(v_item.id,v_item.lease_token);
    EXCEPTION WHEN OTHERS THEN
      PERFORM private.work_finish(v_item.id,v_item.lease_token,SQLERRM);
    END;
    v_count:=v_count+1; v_claimed:=v_claimed+1;
  END LOOP;
  EXIT WHEN v_claimed=0 OR v_count>=64;
  END LOOP;
  RETURN v_count;
END;
$$;
