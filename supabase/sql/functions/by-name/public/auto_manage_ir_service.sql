-- Canonical SQL source for public.auto_manage_ir_service.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.auto_manage_ir_service(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_league leagues%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_enabled boolean;
  v_roster_size int;
  v_ir_slots int;
  v_ir_before int;
  v_active_before int;
  v_ir_after int;
  v_active_after int;
  v_user_id uuid;
  v_lock_id uuid;
  v_plan jsonb;
  v_move jsonb;
  v_kind text;
  v_swap_kind text;
  v_candidate_roster_id uuid;
  v_candidate_player_id uuid;
  v_occupant_roster_id uuid;
  v_occupant_player_id uuid;
  v_candidate_status text;
  v_candidate_return date;
  v_occupant_status text;
  v_occupant_return date;
  v_occupant_on_ir boolean;
  v_moves jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_notices jsonb := '[]'::jsonb;
  v_taxi_before jsonb;
  v_taxi_after jsonb;
  v_ids_before uuid[];
  v_ids_after uuid[];
  v_problems_before text[];
  v_problems_after text[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));

  SELECT enabled INTO v_enabled
    FROM lineup_optimizer_settings
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

  SELECT * INTO v_member
    FROM league_members
   WHERE id = p_member_id AND league_id = p_league_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

  SELECT * INTO v_league FROM leagues WHERE id = p_league_id;
  IF NOT FOUND
     OR v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM league_seasons
     WHERE id = p_league_season_id AND league_id = p_league_id AND is_current
  ) THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

  v_user_id := v_member.user_id;
  v_roster_size := COALESCE(v_league.roster_size, 20);
  v_ir_slots := COALESCE(v_league.ir_slots, 2);

  FOR v_lock_id IN
    SELECT DISTINCT player_id
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND member_id = p_member_id
     ORDER BY player_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_lock_id::text));
  END LOOP;

  SELECT count(*) FILTER (WHERE is_on_ir),
         count(*) FILTER (WHERE NOT is_on_ir AND NOT is_on_taxi)
    INTO v_ir_before, v_active_before
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(rp) ORDER BY rp.id), '[]'::jsonb)
    INTO v_taxi_before
    FROM roster_players rp
   WHERE rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.member_id = p_member_id
     AND rp.is_on_taxi;

  SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[])
    INTO v_ids_before
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;

  SELECT COALESCE(array_agg(kind || ':' || COALESCE(roster_player_id::text, '') ORDER BY kind, roster_player_id), ARRAY[]::text[])
    INTO v_problems_before
    FROM private.roster_problems(p_league_id, p_league_season_id, p_member_id);

  v_plan := private.plan_auto_ir(p_league_id, p_league_season_id, p_member_id);
  v_skipped := COALESCE(v_plan->'skipped', '[]'::jsonb);
  v_notices := COALESCE(v_plan->'notices', '[]'::jsonb);

  FOR v_move IN SELECT * FROM jsonb_array_elements(COALESCE(v_plan->'moves', '[]'::jsonb)) LOOP
    v_kind := v_move->>'kind';
    IF v_kind = 'designate' THEN
      v_candidate_roster_id := (v_move->>'designateRosterPlayerId')::uuid;
      v_candidate_player_id := (v_move->>'designatePlayerId')::uuid;
      BEGIN
        PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_candidate_player_id);
        PERFORM private.toggle_ir_for_activation(v_candidate_roster_id, true, v_user_id, NULL);
        v_moves := v_moves || jsonb_build_object('kind', 'designate', 'designatePlayerId', v_candidate_player_id);
      EXCEPTION WHEN OTHERS THEN
        v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate_player_id, 'reason', SQLERRM);
      END;
    ELSIF v_kind = 'swap' THEN
      v_swap_kind := v_move->>'swapKind';
      v_candidate_roster_id := (v_move->>'designateRosterPlayerId')::uuid;
      v_candidate_player_id := (v_move->>'designatePlayerId')::uuid;
      v_occupant_roster_id := (v_move->>'activateRosterPlayerId')::uuid;
      v_occupant_player_id := (v_move->>'activatePlayerId')::uuid;
      IF v_swap_kind = 'incumbent' THEN
        BEGIN
          PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_candidate_player_id);
          PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_occupant_player_id);
          PERFORM private.toggle_ir_for_activation(v_candidate_roster_id, true, v_user_id, v_occupant_roster_id);
          SELECT p.injury_status, private.ir_reliable_return(p.injury_expected_return, v_today)
            INTO v_candidate_status, v_candidate_return
            FROM roster_players rp
            JOIN players p ON p.id = rp.player_id
           WHERE rp.id = v_candidate_roster_id;
          SELECT p.injury_status, private.ir_reliable_return(p.injury_expected_return, v_today), rp.is_on_ir
            INTO v_occupant_status, v_occupant_return, v_occupant_on_ir
            FROM roster_players rp
            JOIN players p ON p.id = rp.player_id
           WHERE rp.id = v_occupant_roster_id;
          IF NOT private.is_ir_designation(v_candidate_status)
             OR v_candidate_return IS NULL
             OR NOT v_occupant_on_ir
             OR NOT private.is_ir_designation(v_occupant_status)
             OR v_occupant_return IS NULL
             OR v_candidate_return <= v_occupant_return THEN
            RAISE EXCEPTION 'Incumbent exchange no longer valid.' USING ERRCODE = 'P0001';
          END IF;
          PERFORM private.toggle_ir_for_activation(v_occupant_roster_id, false, v_user_id, NULL);
          v_moves := v_moves || jsonb_build_object(
            'kind', 'swap',
            'designatePlayerId', v_candidate_player_id,
            'activatePlayerId', v_occupant_player_id
          );
        EXCEPTION WHEN OTHERS THEN
          v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate_player_id, 'reason', SQLERRM);
        END;
      ELSE
        BEGIN
          PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_candidate_player_id);
          PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_occupant_player_id);
          PERFORM private.toggle_ir_for_activation(v_candidate_roster_id, true, v_user_id, v_occupant_roster_id);
          PERFORM private.toggle_ir_for_activation(v_occupant_roster_id, false, v_user_id, NULL);
          v_moves := v_moves || jsonb_build_object(
            'kind', 'swap',
            'designatePlayerId', v_candidate_player_id,
            'activatePlayerId', v_occupant_player_id
          );
        EXCEPTION WHEN OTHERS THEN
          v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate_player_id, 'reason', SQLERRM);
        END;
      END IF;
    ELSIF v_kind = 'activate' THEN
      v_occupant_roster_id := (v_move->>'activateRosterPlayerId')::uuid;
      v_occupant_player_id := (v_move->>'activatePlayerId')::uuid;
      BEGIN
        PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_occupant_player_id);
        PERFORM private.toggle_ir_for_activation(v_occupant_roster_id, false, v_user_id, NULL);
        v_moves := v_moves || jsonb_build_object('kind', 'activate', 'activatePlayerId', v_occupant_player_id);
      EXCEPTION WHEN OTHERS THEN
        v_skipped := v_skipped || jsonb_build_object('playerId', v_occupant_player_id, 'reason', SQLERRM);
      END;
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(to_jsonb(rp) ORDER BY rp.id), '[]'::jsonb)
    INTO v_taxi_after
    FROM roster_players rp
   WHERE rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.member_id = p_member_id
     AND rp.is_on_taxi;
  IF v_taxi_after IS DISTINCT FROM v_taxi_before THEN
    RAISE EXCEPTION 'Auto IR management changed taxi rows.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[])
    INTO v_ids_after
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;
  IF v_ids_after IS DISTINCT FROM v_ids_before THEN
    RAISE EXCEPTION 'Auto IR management changed the roster membership.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(array_agg(kind || ':' || COALESCE(roster_player_id::text, '') ORDER BY kind, roster_player_id), ARRAY[]::text[])
    INTO v_problems_after
    FROM private.roster_problems(p_league_id, p_league_season_id, p_member_id);
  IF EXISTS (SELECT 1 FROM unnest(v_problems_after) AS p WHERE p <> ALL(v_problems_before)) THEN
    RAISE EXCEPTION 'Auto IR management introduced a new roster problem.' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) FILTER (WHERE is_on_ir),
         count(*) FILTER (WHERE NOT is_on_ir AND NOT is_on_taxi)
    INTO v_ir_after, v_active_after
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;

  IF v_ir_after > v_ir_slots
     AND NOT (v_ir_before > v_ir_slots AND v_ir_after <= v_ir_before) THEN
    RAISE EXCEPTION 'Auto IR management exceeded the IR capacity.' USING ERRCODE = 'P0001';
  END IF;
  IF v_active_after > v_roster_size
     AND NOT (v_active_before > v_roster_size AND v_active_after <= v_active_before) THEN
    RAISE EXCEPTION 'Auto IR management exceeded the active roster capacity.' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('moves', v_moves, 'skipped', v_skipped, 'notices', v_notices);
END;
$function$;
