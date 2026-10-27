-- Canonical SQL source for public.update_league_configuration_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.update_league_configuration_atomic(
  p_league_id uuid,
  p_settings jsonb,
  p_slots jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.update_league_configuration_atomic', jsonb_build_array(p_league_id, p_settings, p_slots), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
BEGIN
  IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION 'p_settings must be a JSON object.'
      USING ERRCODE = '22023';
  END IF;

  IF p_settings <> '{}'::jsonb THEN
    PERFORM public.update_league_settings_atomic(p_league_id, p_settings);
  END IF;

  IF p_slots IS NOT NULL THEN
    PERFORM public.update_lineup_slots_atomic(p_league_id, p_slots);
  END IF;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;
