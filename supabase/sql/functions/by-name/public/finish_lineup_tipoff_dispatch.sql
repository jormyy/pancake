CREATE OR REPLACE FUNCTION public.finish_lineup_tipoff_dispatch(p_tipoff_at timestamptz, p_token uuid, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.lineup_tipoff_dispatches
     SET status = CASE WHEN p_error IS NULL THEN 'succeeded' ELSE 'failed' END,
         error = p_error, finished_at = now()
   WHERE tipoff_at = p_tipoff_at AND token = p_token AND status = 'running';
$$;
