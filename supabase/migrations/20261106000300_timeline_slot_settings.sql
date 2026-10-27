CREATE OR REPLACE FUNCTION public.update_lineup_slots_atomic(
  p_league_id uuid,
  p_slots     jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  v_before jsonb;
  v_after jsonb;
BEGIN
  __request_context := private.request_begin('public.update_lineup_slots_atomic', jsonb_build_array(p_league_id, p_slots), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
BEGIN
  IF p_slots IS NULL OR jsonb_typeof(p_slots) <> 'array' THEN
    RAISE EXCEPTION 'p_slots must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_slots) > 16 THEN
    RAISE EXCEPTION 'Too many lineup slot entries.'
      USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('slot_type',slot_type,'slot_count',slot_count) ORDER BY slot_type),'[]')
    INTO v_before FROM public.lineup_slot_templates WHERE league_id=p_league_id;
  PERFORM public.update_lineup_slots_atomic_unchecked(p_league_id, p_slots);
  SELECT coalesce(jsonb_agg(jsonb_build_object('slot_type',slot_type,'slot_count',slot_count) ORDER BY slot_type),'[]')
    INTO v_after FROM public.lineup_slot_templates WHERE league_id=p_league_id;
  IF v_before IS DISTINCT FROM v_after THEN
    INSERT INTO public.league_events(league_id,kind,summary,detail)
      VALUES(p_league_id,'settings.changed','Lineup slots changed',
        jsonb_build_object('changes',jsonb_build_object('lineup_slots',jsonb_build_object('before',v_before,'after',v_after))));
  END IF;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;
