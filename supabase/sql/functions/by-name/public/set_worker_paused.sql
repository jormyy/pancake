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
