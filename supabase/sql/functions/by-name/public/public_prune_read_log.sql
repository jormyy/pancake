CREATE OR REPLACE FUNCTION public.public_prune_read_log()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='100ms' SET statement_timeout='3s' AS $$
BEGIN
  RETURN (private.retain_public_read_log(now())->>'public.public_read_log')::integer;
END;
$$;
