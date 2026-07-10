-- Canonical SQL source for public.update_lineup_slots_atomic_unchecked.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.update_lineup_slots_atomic_unchecked(
  p_league_id uuid,
  p_slots     jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_league       public.leagues%ROWTYPE;
  v_user_id      uuid := (SELECT auth.uid());
  v_entry        jsonb;
  v_slot_type    public.roster_slot_type;
  v_slot_count   int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  IF p_slots IS NULL OR jsonb_typeof(p_slots) <> 'array' THEN
    RAISE EXCEPTION 'p_slots must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  -- Lock the leagues row so the status check and the writes are serialized
  -- against any concurrent lifecycle RPC (set_league_status_atomic,
  -- advance_season_atomic, update_league_settings_atomic, etc.).
  SELECT *
    INTO v_league
    FROM public.leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  -- Authorization: commissioner / co-commissioner of THIS league only.
  -- Mirrors the slot_templates_insert/update RLS WITH CHECK clauses we
  -- bypass via SECURITY DEFINER.
  IF NOT private.is_commissioner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league commissioner can change lineup slots.'
      USING ERRCODE = '42501';
  END IF;

  -- Status gate: the lineup-slot layout determines which positions are
  -- starters and therefore which players accrue weekly fantasy points.
  -- Changing it after the draft has shipped silently rewrites the
  -- competitive contract of the league. Only 'setup' is allowed.
  IF v_league.status IS DISTINCT FROM 'setup'::public.league_status THEN
    RAISE EXCEPTION 'Lineup slots can only be modified during setup.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Iterate the jsonb array and upsert each entry. ON CONFLICT mirrors
  -- the prior client-side upsert(rows, { onConflict: 'league_id,slot_type' }).
  FOR v_entry IN
    SELECT value FROM jsonb_array_elements(p_slots)
  LOOP
    IF v_entry IS NULL OR jsonb_typeof(v_entry) <> 'object' THEN
      RAISE EXCEPTION 'Each slot entry must be a JSON object.'
        USING ERRCODE = '22023';
    END IF;

    IF NOT (v_entry ? 'slot_type') OR jsonb_typeof(v_entry -> 'slot_type') <> 'string' THEN
      RAISE EXCEPTION 'slot_type is required and must be a string.'
        USING ERRCODE = '22023';
    END IF;

    IF NOT (v_entry ? 'slot_count') OR jsonb_typeof(v_entry -> 'slot_count') <> 'number' THEN
      RAISE EXCEPTION 'slot_count is required and must be a number.'
        USING ERRCODE = '22023';
    END IF;

    -- Cast to roster_slot_type. An invalid enum value raises 22P02 with
    -- a clear "invalid input value for enum" message, which is good
    -- enough for the client error path.
    v_slot_type := (v_entry ->> 'slot_type')::public.roster_slot_type;
    v_slot_count := (v_entry ->> 'slot_count')::int;

    IF v_slot_count IS NULL OR v_slot_count <= 0 THEN
      RAISE EXCEPTION 'slot_count must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.lineup_slot_templates (league_id, slot_type, slot_count)
    VALUES (p_league_id, v_slot_type, v_slot_count)
    ON CONFLICT (league_id, slot_type)
    DO UPDATE SET slot_count = EXCLUDED.slot_count;
  END LOOP;
END;
$$;
