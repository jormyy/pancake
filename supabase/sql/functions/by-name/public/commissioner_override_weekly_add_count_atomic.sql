-- Canonical SQL source for public.commissioner_override_weekly_add_count_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.commissioner_override_weekly_add_count_atomic(
  p_league_id uuid,
  p_member_id uuid,
  p_add_count int
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_season_id uuid;
  v_week int;
  v_count int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  IF p_add_count IS NULL OR p_add_count < 0 THEN
    RAISE EXCEPTION 'Current-week add count must be a non-negative integer.'
      USING ERRCODE = '22023';
  END IF;

  IF NOT private.is_commissioner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league commissioner can override add counts.'
      USING ERRCODE = '42501';
  END IF;

  SELECT id
    INTO v_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No active season found.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Member not found.'
      USING ERRCODE = 'P0002';
  END IF;

  v_week := private.current_add_week_number(p_league_id, v_season_id);

  INSERT INTO weekly_add_counts (
    league_id,
    league_season_id,
    member_id,
    week_number,
    add_count
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    v_week,
    p_add_count
  )
  ON CONFLICT ON CONSTRAINT weekly_add_counts_league_id_league_season_id_member_id_week_key DO UPDATE
     SET add_count = EXCLUDED.add_count,
         updated_at = now()
  RETURNING add_count INTO v_count;

  PERFORM private.log_league_activity(
    p_league_id,
    v_season_id,
    'commissioner_add_count_override',
    'Weekly add count overridden',
    NULL,
    NULL,
    p_member_id,
    NULL,
    NULL,
    NULL,
    jsonb_build_object('week_number', v_week, 'add_count', v_count)
  );

  RETURN v_count;
END;
$$;
