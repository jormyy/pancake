-- Canonical SQL source for public.update_lineup_slots_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.update_lineup_slots_atomic(
  p_league_id uuid,
  p_slots     jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_slots IS NULL OR jsonb_typeof(p_slots) <> 'array' THEN
    RAISE EXCEPTION 'p_slots must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_slots) > 16 THEN
    RAISE EXCEPTION 'Too many lineup slot entries.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.update_lineup_slots_atomic_unchecked(p_league_id, p_slots);
END;
$$;
