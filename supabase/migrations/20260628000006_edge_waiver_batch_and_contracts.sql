-- Bound waiver processing at the DB layer so scheduled Edge functions do not
-- own unbounded claim-drain loops.

CREATE OR REPLACE FUNCTION public.process_due_waiver_claims_atomic(
  p_process_date date,
  p_limit int DEFAULT 100
)
RETURNS TABLE (
  processed boolean,
  claim_id uuid,
  member_id uuid,
  player_id uuid,
  status waiver_claim_status,
  failure_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 0), 500);
  v_iteration int := 0;
  v_rows int;
BEGIN
  IF p_process_date IS NULL THEN
    RAISE EXCEPTION 'p_process_date is required.'
      USING ERRCODE = '22004';
  END IF;

  WHILE v_iteration < v_limit LOOP
    v_rows := 0;

    RETURN QUERY
    SELECT *
      FROM public.process_next_waiver_claim_atomic(p_process_date) AS processed_claim;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      RETURN;
    END IF;

    v_iteration := v_iteration + v_rows;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.process_due_waiver_claims_atomic(date, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_due_waiver_claims_atomic(date, int) FROM anon;
REVOKE ALL ON FUNCTION public.process_due_waiver_claims_atomic(date, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_due_waiver_claims_atomic(date, int) TO service_role;
