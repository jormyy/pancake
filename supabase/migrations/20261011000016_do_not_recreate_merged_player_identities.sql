CREATE OR REPLACE FUNCTION public.update_existing_player_metadata(p_updates jsonb)
RETURNS int
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_updated int;
BEGIN
  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' OR jsonb_array_length(p_updates) > 500 THEN
    RAISE EXCEPTION 'Player updates must be an array of at most 500 rows.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_updates) AS r(id uuid) GROUP BY id HAVING id IS NULL OR count(*) > 1) THEN
    RAISE EXCEPTION 'Player update identities must be present and unique.' USING ERRCODE = '22023';
  END IF;

  -- A concurrent merge can delete a queued identity. Never recreate it.
  PERFORM p.id FROM players p JOIN jsonb_to_recordset(p_updates) AS r(id uuid) ON r.id = p.id
   ORDER BY p.id FOR UPDATE OF p;
  UPDATE players p SET
    first_name = r.first_name,
    last_name = r.last_name,
    nba_team = r.nba_team,
    position = r.position,
    eligible_positions = r.eligible_positions,
    status = r.status,
    injury_status = r.injury_status,
    years_exp = r.years_exp,
    updated_at = r.updated_at
  FROM jsonb_to_recordset(p_updates) AS r(
    id uuid, first_name text, last_name text, nba_team text, position nba_position,
    eligible_positions text[], status text, injury_status text, years_exp int, updated_at timestamptz
  )
  WHERE p.id = r.id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.update_existing_player_metadata(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_existing_player_metadata(jsonb) TO service_role;
