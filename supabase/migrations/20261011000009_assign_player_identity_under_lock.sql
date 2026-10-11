CREATE OR REPLACE FUNCTION public.assign_player_nba_id_atomic(p_player_id uuid, p_nba_id text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_nba_id text;
  v_owner_id uuid;
BEGIN
  IF p_nba_id IS NULL OR btrim(p_nba_id) = '' THEN
    RAISE EXCEPTION 'NBA identity is required' USING ERRCODE = '22023';
  END IF;

  PERFORM id FROM players
   WHERE id = p_player_id OR nba_id = p_nba_id
   ORDER BY id FOR UPDATE;

  SELECT nba_id INTO v_current_nba_id FROM players WHERE id = p_player_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_current_nba_id IS NOT NULL AND v_current_nba_id <> p_nba_id THEN
    RAISE EXCEPTION 'Conflicting NBA identity for player %', p_player_id USING ERRCODE = '23514';
  END IF;
  IF v_current_nba_id = p_nba_id THEN RETURN p_player_id; END IF;

  SELECT id INTO v_owner_id FROM players WHERE nba_id = p_nba_id FOR UPDATE;
  IF FOUND THEN
    -- Both identities remain locked while their dependent rows merge.
    PERFORM public.merge_players(v_owner_id, p_player_id);
    RETURN v_owner_id;
  END IF;

  UPDATE players SET nba_id = p_nba_id WHERE id = p_player_id;
  RETURN p_player_id;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_player_nba_id_atomic(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_player_nba_id_atomic(uuid, text) TO service_role;
