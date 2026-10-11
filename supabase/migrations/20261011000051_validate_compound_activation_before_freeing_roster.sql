BEGIN;

-- Canonical SQL source for private.lock_roster_activation.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.lock_roster_activation(
  p_activate_roster_player_id uuid,
  p_activate_source text,
  p_free_roster_player_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_target roster_players%ROWTYPE;
  v_free roster_players%ROWTYPE;
  v_current roster_players%ROWTYPE;
  v_player_id uuid;
BEGIN
  IF p_activate_source IS NULL OR p_activate_source NOT IN ('ir', 'taxi') THEN
    RAISE EXCEPTION 'Invalid activation source.' USING ERRCODE = '22023';
  END IF;

  SELECT rp.* INTO v_target FROM roster_players AS rp
   JOIN league_members AS member ON member.id = rp.member_id
   WHERE rp.id = p_activate_roster_player_id AND member.user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to activate this roster player.' USING ERRCODE = '42501';
  END IF;

  IF p_free_roster_player_id IS NOT NULL THEN
    SELECT * INTO v_free FROM roster_players
     WHERE id = p_free_roster_player_id
       AND league_id = v_target.league_id AND league_season_id = v_target.league_season_id
       AND member_id = v_target.member_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The freed player must belong to the same roster.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_target.league_id::text), hashtext(v_target.member_id::text));
  FOR v_player_id IN
    SELECT DISTINCT id FROM unnest(ARRAY[v_target.player_id, v_free.player_id]) AS id
     WHERE id IS NOT NULL ORDER BY id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_target.league_id::text), hashtext(v_player_id::text));
  END LOOP;
  PERFORM 1 FROM roster_players WHERE id IN (p_activate_roster_player_id, p_free_roster_player_id)
   ORDER BY id FOR UPDATE;

  SELECT * INTO v_current FROM roster_players
   WHERE id = v_target.id AND league_id = v_target.league_id AND league_season_id = v_target.league_season_id
     AND member_id = v_target.member_id AND player_id = v_target.player_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This roster changed. Refresh and try again.' USING ERRCODE = 'P0001';
  END IF;
  IF (p_activate_source = 'ir' AND NOT v_current.is_on_ir)
     OR (p_activate_source = 'taxi' AND NOT v_current.is_on_taxi) THEN
    RAISE EXCEPTION 'This player is no longer on %. Refresh your roster and try again.', upper(p_activate_source)
      USING ERRCODE = 'P0001';
  END IF;

  IF p_free_roster_player_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM roster_players WHERE id = v_free.id AND league_id = v_target.league_id
      AND league_season_id = v_target.league_season_id AND member_id = v_target.member_id
      AND player_id = v_free.player_id
  ) THEN
    RAISE EXCEPTION 'This roster changed. Refresh and try again.' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Canonical SQL source for public.activate_roster_player_with_overflow_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.activate_roster_player_with_overflow_atomic(
  p_activate_roster_player_id uuid,
  p_activate_source text,
  p_free_roster_player_id uuid,
  p_free_action text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required.'
      USING ERRCODE = '42501';
  END IF;

  IF p_activate_roster_player_id = p_free_roster_player_id THEN
    RAISE EXCEPTION 'Activation target and freed roster slot must be different players.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_roster_activation(
    p_activate_roster_player_id, p_activate_source, p_free_roster_player_id
  );

  CASE p_free_action
    WHEN 'drop' THEN
      PERFORM public.drop_player_atomic(p_free_roster_player_id);
    WHEN 'ir' THEN
      PERFORM public.toggle_ir_atomic(p_free_roster_player_id, true, v_user_id);
    WHEN 'taxi' THEN
      PERFORM public.toggle_taxi_atomic(p_free_roster_player_id, true, v_user_id);
    ELSE
      RAISE EXCEPTION 'Invalid roster overflow action: %', p_free_action
        USING ERRCODE = '22023';
  END CASE;

  CASE p_activate_source
    WHEN 'ir' THEN
      PERFORM public.toggle_ir_atomic(p_activate_roster_player_id, false, v_user_id);
    WHEN 'taxi' THEN
      PERFORM public.toggle_taxi_atomic(p_activate_roster_player_id, false, v_user_id);
    ELSE
      RAISE EXCEPTION 'Invalid activation source: %', p_activate_source
        USING ERRCODE = '22023';
  END CASE;
END;
$$;

-- Canonical SQL source for public.activate_roster_player_with_lineup_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.activate_roster_player_with_lineup_atomic(
  p_activate_roster_player_id uuid,
  p_activate_source text,
  p_free_roster_player_id uuid,
  p_free_action text,
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_week_number int,
  p_slot_type roster_slot_type DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_activate_player_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required.'
      USING ERRCODE = '42501';
  END IF;

  IF (p_free_roster_player_id IS NULL AND p_free_action IS NOT NULL)
     OR (p_free_roster_player_id IS NOT NULL AND p_free_action IS NULL) THEN
    RAISE EXCEPTION 'Overflow player and overflow action must be provided together.'
      USING ERRCODE = '22023';
  END IF;

  IF p_free_roster_player_id IS NOT NULL
     AND p_activate_roster_player_id = p_free_roster_player_id THEN
    RAISE EXCEPTION 'Activation target and freed roster slot must be different players.'
      USING ERRCODE = '22023';
  END IF;

  IF p_slot_type = 'IR'::roster_slot_type THEN
    RAISE EXCEPTION 'Use roster IR actions instead of lineup IR assignment.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_roster_activation(
    p_activate_roster_player_id, p_activate_source, p_free_roster_player_id
  );

  IF NOT EXISTS (
    SELECT 1 FROM roster_players WHERE id = p_activate_roster_player_id
      AND member_id = p_member_id AND league_id = p_league_id AND league_season_id = p_league_season_id
  ) THEN
    RAISE EXCEPTION 'Activated player is not on this roster.' USING ERRCODE = 'P0002';
  END IF;

  IF p_free_roster_player_id IS NOT NULL THEN
    CASE p_free_action
      WHEN 'drop' THEN
        PERFORM public.drop_player_atomic(p_free_roster_player_id);
      WHEN 'ir' THEN
        PERFORM public.toggle_ir_atomic(p_free_roster_player_id, true, v_user_id);
      WHEN 'taxi' THEN
        PERFORM public.toggle_taxi_atomic(p_free_roster_player_id, true, v_user_id);
      ELSE
        RAISE EXCEPTION 'Invalid roster overflow action: %', p_free_action
          USING ERRCODE = '22023';
    END CASE;
  END IF;

  CASE p_activate_source
    WHEN 'ir' THEN
      PERFORM public.toggle_ir_atomic(p_activate_roster_player_id, false, v_user_id);
    WHEN 'taxi' THEN
      PERFORM public.toggle_taxi_atomic(p_activate_roster_player_id, false, v_user_id);
    ELSE
      RAISE EXCEPTION 'Invalid activation source: %', p_activate_source
        USING ERRCODE = '22023';
  END CASE;

  IF p_slot_type IS NOT NULL AND p_slot_type <> 'BE'::roster_slot_type THEN
    SELECT player_id
      INTO v_activate_player_id
      FROM public.roster_players
     WHERE id = p_activate_roster_player_id
       AND member_id = p_member_id
       AND league_id = p_league_id
       AND league_season_id = p_league_season_id;

    IF v_activate_player_id IS NULL THEN
      RAISE EXCEPTION 'Activated player is not on this roster.'
        USING ERRCODE = 'P0002';
    END IF;

    PERFORM public.set_player_slot_atomic(
      p_member_id,
      p_league_id,
      p_league_season_id,
      v_activate_player_id,
      p_game_date,
      p_slot_type,
      p_week_number
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.lock_roster_activation(uuid,text,uuid) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
