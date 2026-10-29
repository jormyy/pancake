CREATE OR REPLACE FUNCTION private.enqueue_notifications(p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='250ms' SET statement_timeout='3s' AS $$
DECLARE inserted integer;
BEGIN
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)>1000 THEN
    RAISE EXCEPTION 'At most 1000 notification rows are required' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,data,category)
  SELECT incoming.dedupe_key,incoming.member_id,incoming.event_type,incoming.title,incoming.body,incoming.data,incoming.category
  FROM jsonb_to_recordset(p_rows) incoming(dedupe_key text,member_id uuid,event_type text,title text,body text,data jsonb,category text)
  ON CONFLICT(dedupe_key) DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  RETURN inserted;
END;
$$;
