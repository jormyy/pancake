CREATE OR REPLACE FUNCTION public.renew_work_lease(p_invocation_key uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  WITH unlocked AS (
    SELECT id FROM private.work_items WHERE invocation_key=p_invocation_key AND status='running' AND lease_until>clock_timestamp()
    FOR UPDATE SKIP LOCKED
  )
  UPDATE private.work_items item SET lease_until=clock_timestamp()+interval '5 minutes'
  FROM unlocked WHERE item.id=unlocked.id;
  IF FOUND THEN RETURN true; END IF;
  RETURN EXISTS(SELECT 1 FROM private.work_items WHERE invocation_key=p_invocation_key AND status='running' AND lease_until>clock_timestamp());
END;
$$;
