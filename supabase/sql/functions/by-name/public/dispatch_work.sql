CREATE OR REPLACE FUNCTION public.dispatch_work()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_count integer:=0; v_claimed integer;
BEGIN
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
