CREATE OR REPLACE FUNCTION public.renew_work_lease(p_invocation_key uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE private.work_items SET lease_until=now()+interval '90 seconds'
  WHERE invocation_key=p_invocation_key AND status='running' AND lease_until>now();
  RETURN FOUND;
END;
$$;
