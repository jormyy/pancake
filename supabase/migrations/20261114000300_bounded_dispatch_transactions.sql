CREATE OR REPLACE FUNCTION public.dispatch_work()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_count integer:=0;
  v_started timestamptz:=clock_timestamp();
BEGIN
  IF (SELECT paused FROM private.worker_controls WHERE id) THEN RETURN 0; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('public.dispatch_work',0)) THEN RETURN 0; END IF;
  PERFORM private.enqueue_scheduled_work(now());
  LOOP
    EXIT WHEN v_count>=8 OR clock_timestamp()-v_started>=interval '2 seconds';
    SELECT * INTO v_item FROM private.work_claim(1);
    EXIT WHEN NOT FOUND;
    BEGIN
      PERFORM private.work_execute(v_item.id,v_item.lease_token);
    EXCEPTION WHEN OTHERS THEN
      PERFORM private.work_finish(v_item.id,v_item.lease_token,SQLERRM);
    END;
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION private.work_enqueue(p_kind text, p_key text, p_due_at timestamptz DEFAULT now(), p_payload jsonb DEFAULT '{}'::jsonb, p_league_id uuid DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM private.work_items
    WHERE kind=p_kind AND status IN ('pending','running','failed')
      AND (CASE WHEN kind='pre-tipoff' THEN payload->>'tipoffAt' ELSE md5(payload::text) END)
        =(CASE WHEN p_kind='pre-tipoff' THEN p_payload->>'tipoffAt' ELSE md5(p_payload::text) END)
  ) THEN RETURN NULL; END IF;
  INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
  VALUES(p_kind,p_key,p_due_at,p_payload,p_league_id)
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
