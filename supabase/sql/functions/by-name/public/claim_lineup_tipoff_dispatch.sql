-- Canonical SQL source for public.claim_lineup_tipoff_dispatch.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.claim_lineup_tipoff_dispatch(p_tipoff_at timestamptz, p_token uuid, p_scope text DEFAULT NULL)
RETURNS date
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_date date;
  v_scope text := COALESCE(p_scope, '');
  v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
BEGIN
  IF p_scope IS NULL AND EXISTS (
    SELECT 1 FROM public.lineup_tipoff_dispatches
     WHERE tipoff_at = p_tipoff_at AND token = p_token AND scope <> ''
  ) THEN
    RAISE EXCEPTION 'Tipoff claim requires its work scope.' USING ERRCODE = 'PT409';
  END IF;
  SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
   WHERE tipoff_at = p_tipoff_at AND scope = v_scope AND token = p_token AND status = 'queued'
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_scope <> '' AND NOT private.tipoff_scope_admits(v_scope, v_scope::uuid, true) THEN
    UPDATE public.lineup_tipoff_dispatches
       SET status = 'failed', error = 'Tipoff scope is no longer active.', finished_at = now()
     WHERE tipoff_at = p_tipoff_at AND scope = v_scope AND token = p_token AND status = 'queued';
    RETURN NULL;
  END IF;
  UPDATE public.lineup_tipoff_dispatches
     SET status = 'running', lease_until = now() + interval '45 seconds'
   WHERE tipoff_at = p_tipoff_at AND scope = v_scope AND token = p_token AND status = 'queued'
     AND lease_until > clock_timestamp()
     AND game_date = (now() AT TIME ZONE 'America/New_York')::date
     AND tipoff_at > now() - interval '1 minute'
  RETURNING game_date INTO v_date;
  RETURN v_date;
END;
$$;
