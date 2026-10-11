CREATE OR REPLACE FUNCTION private.lock_nba_source(p_year int, p_shared boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_year IS NULL THEN RAISE EXCEPTION 'Game season is required.' USING ERRCODE='22023'; END IF;
  IF (p_shared AND NOT pg_try_advisory_xact_lock_shared(hashtext('nba-source'),p_year))
     OR (NOT p_shared AND NOT pg_try_advisory_xact_lock(hashtext('nba-source'),p_year)) THEN
    RAISE EXCEPTION 'Game inputs are being updated. Retry this operation.' USING ERRCODE='40001';
  END IF;
END;
$$;
