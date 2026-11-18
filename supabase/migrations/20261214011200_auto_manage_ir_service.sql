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
  v_roster_size int;
  v_ir_slots int;
  v_ir_before int;
  v_active_before int;
  v_ir_after int;
  v_active_after int;
  v_open_slots int;
  v_places int;
  v_candidate_count int;
  v_occupant_count int;
  v_selected_count int;
  v_designate_count int;
  v_swap_count int;
  v_uncertain_count int;
  v_index int;
  v_boundary_date date;
  v_user_id uuid;
  v_lock_id uuid;
  v_candidate record;
  v_occupant record;
  v_taxi record;
  v_return_date date;
  v_reliable boolean;
  v_cand_roster_ids uuid[] := ARRAY[]::uuid[];
  v_cand_player_ids uuid[] := ARRAY[]::uuid[];
  v_cand_names text[] := ARRAY[]::text[];
  v_cand_dates date[] := ARRAY[]::date[];
  v_cand_reliable boolean[] := ARRAY[]::boolean[];
  v_sorted_roster_ids uuid[];
  v_sorted_player_ids uuid[];
  v_sorted_names text[];
  v_sorted_dates date[];
  v_sorted_reliable boolean[];
  v_occ_roster_ids uuid[] := ARRAY[]::uuid[];
  v_occ_player_ids uuid[] := ARRAY[]::uuid[];
  v_occ_names text[] := ARRAY[]::text[];
  v_swapped_occupants uuid[] := ARRAY[]::uuid[];
  v_moves jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_notices jsonb := '[]'::jsonb;
  v_taxi_before jsonb;
  v_taxi_after jsonb;
  v_ids_before uuid[];
  v_ids_after uuid[];
  v_problems_before text[];
  v_problems_after text[];
  v_candidate_roster_id uuid;
  v_candidate_player_id uuid;
  v_occupant_roster_id uuid;
  v_occupant_player_id uuid;
  v_occupant_name text;
  v_active_now int;
BEGIN
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

  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));
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

  FOR v_candidate IN
    SELECT rp.id AS roster_player_id,
           rp.player_id,
           p.display_name AS player_name,
           p.injury_status,
           p.injury_expected_return
      FROM roster_players rp
      JOIN players p ON p.id = rp.player_id
     WHERE rp.league_id = p_league_id
       AND rp.league_season_id = p_league_season_id
       AND rp.member_id = p_member_id
       AND NOT rp.is_on_ir
       AND NOT rp.is_on_taxi
     ORDER BY rp.id
  LOOP
    IF NOT private.is_ir_designation(v_candidate.injury_status) THEN
      CONTINUE;
    END IF;
    IF private.roster_status_game_started(v_candidate.player_id) THEN
      v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate.player_id, 'reason', 'game_locked');
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM private.locked_assets(p_league_id, p_league_season_id, p_member_id) la
       WHERE la.asset_kind = 'player' AND la.asset_id = v_candidate.player_id
    ) THEN
      v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate.player_id, 'reason', 'reserved');
      CONTINUE;
    END IF;

    v_reliable := false;
    v_return_date := NULL;
    IF v_candidate.injury_expected_return ~ '^\d{4}-\d{2}-\d{2}$' THEN
      BEGIN
        v_return_date := v_candidate.injury_expected_return::date;
        IF v_return_date >= v_today THEN
          v_reliable := true;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_reliable := false;
        v_return_date := NULL;
      END;
    END IF;

    v_cand_roster_ids := v_cand_roster_ids || v_candidate.roster_player_id;
    v_cand_player_ids := v_cand_player_ids || v_candidate.player_id;
    v_cand_names := v_cand_names || v_candidate.player_name;
    v_cand_dates := v_cand_dates || v_return_date;
    v_cand_reliable := v_cand_reliable || v_reliable;
  END LOOP;

  FOR v_occupant IN
    SELECT rp.id AS roster_player_id,
           rp.player_id,
           p.display_name AS player_name,
           p.injury_status
      FROM roster_players rp
      JOIN players p ON p.id = rp.player_id
     WHERE rp.league_id = p_league_id
       AND rp.league_season_id = p_league_season_id
       AND rp.member_id = p_member_id
       AND rp.is_on_ir
     ORDER BY rp.id
  LOOP
    IF private.is_ir_designation(v_occupant.injury_status) THEN
      CONTINUE;
    END IF;
    IF private.roster_status_game_started(v_occupant.player_id) THEN
      v_skipped := v_skipped || jsonb_build_object('playerId', v_occupant.player_id, 'reason', 'game_locked');
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM private.locked_assets(p_league_id, p_league_season_id, p_member_id) la
       WHERE la.asset_kind = 'player' AND la.asset_id = v_occupant.player_id
    ) THEN
      v_skipped := v_skipped || jsonb_build_object('playerId', v_occupant.player_id, 'reason', 'reserved');
      CONTINUE;
    END IF;

    v_occ_roster_ids := v_occ_roster_ids || v_occupant.roster_player_id;
    v_occ_player_ids := v_occ_player_ids || v_occupant.player_id;
    v_occ_names := v_occ_names || v_occupant.player_name;
  END LOOP;

  FOR v_taxi IN
    SELECT rp.player_id,
           p.display_name AS player_name,
           p.career_regular_season_games
      FROM roster_players rp
      JOIN players p ON p.id = rp.player_id
     WHERE rp.league_id = p_league_id
       AND rp.league_season_id = p_league_season_id
       AND rp.member_id = p_member_id
       AND rp.is_on_taxi
     ORDER BY rp.id
  LOOP
    IF v_taxi.career_regular_season_games IS NOT NULL
       AND NOT private.taxi_player_eligible(p_league_id, v_taxi.player_id) THEN
      v_notices := v_notices || jsonb_build_object(
        'playerId', v_taxi.player_id,
        'playerName', v_taxi.player_name,
        'reason', 'taxi_ineligible',
        'action', 'Activate ' || v_taxi.player_name || ' from taxi or drop a player'
      );
    END IF;
  END LOOP;

  v_candidate_count := COALESCE(array_length(v_cand_roster_ids, 1), 0);
  v_occupant_count := COALESCE(array_length(v_occ_roster_ids, 1), 0);
  v_open_slots := GREATEST(v_ir_slots - v_ir_before, 0);
  v_places := v_open_slots + v_occupant_count;

  IF v_candidate_count > 0 THEN
    SELECT array_agg(roster_player_id ORDER BY reliable DESC, reliable_date DESC NULLS LAST, roster_player_id),
           array_agg(player_id ORDER BY reliable DESC, reliable_date DESC NULLS LAST, roster_player_id),
           array_agg(player_name ORDER BY reliable DESC, reliable_date DESC NULLS LAST, roster_player_id),
           array_agg(reliable_date ORDER BY reliable DESC, reliable_date DESC NULLS LAST, roster_player_id),
           array_agg(reliable ORDER BY reliable DESC, reliable_date DESC NULLS LAST, roster_player_id)
      INTO v_sorted_roster_ids, v_sorted_player_ids, v_sorted_names, v_sorted_dates, v_sorted_reliable
      FROM unnest(v_cand_roster_ids, v_cand_player_ids, v_cand_names, v_cand_dates, v_cand_reliable)
        AS t(roster_player_id, player_id, player_name, reliable_date, reliable);
  END IF;

  v_uncertain_count := 0;
  IF v_candidate_count > 0 THEN
    SELECT count(*) INTO v_uncertain_count FROM unnest(v_sorted_reliable) AS r WHERE NOT r;
  END IF;

  IF v_candidate_count <= v_places THEN
    v_selected_count := v_candidate_count;
  ELSE
    v_selected_count := 0;
    IF v_uncertain_count = 0 THEN
      v_index := LEAST(v_places, v_candidate_count - 1);
      WHILE v_index >= 1 LOOP
        IF v_sorted_dates[v_index] > v_sorted_dates[v_index + 1] THEN
          v_selected_count := v_index;
          EXIT;
        END IF;
        v_index := v_index - 1;
      END LOOP;
    END IF;
  END IF;

  IF v_selected_count < LEAST(v_places, v_candidate_count) THEN
    v_boundary_date := v_sorted_dates[v_selected_count + 1];
    FOR v_index IN (v_selected_count + 1)..v_candidate_count LOOP
      IF NOT v_sorted_reliable[v_index]
         OR v_sorted_dates[v_index] IS NOT DISTINCT FROM v_boundary_date THEN
        v_notices := v_notices || jsonb_build_object(
          'playerId', v_sorted_player_ids[v_index],
          'playerName', v_sorted_names[v_index],
          'reason', 'ir_choice_uncertain',
          'action', 'Choose who moves to IR'
        );
      END IF;
    END LOOP;
  END IF;

  v_designate_count := LEAST(v_open_slots, v_selected_count);
  v_swap_count := v_selected_count - v_designate_count;

  FOR v_index IN 1..v_designate_count LOOP
    v_candidate_roster_id := v_sorted_roster_ids[v_index];
    v_candidate_player_id := v_sorted_player_ids[v_index];
    BEGIN
      PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_candidate_player_id);
      PERFORM private.toggle_ir_for_activation(v_candidate_roster_id, true, v_user_id, NULL);
      v_moves := v_moves || jsonb_build_object('kind', 'designate', 'designatePlayerId', v_candidate_player_id);
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate_player_id, 'reason', SQLERRM);
    END;
  END LOOP;

  FOR v_index IN 1..v_swap_count LOOP
    v_candidate_roster_id := v_sorted_roster_ids[v_designate_count + v_index];
    v_candidate_player_id := v_sorted_player_ids[v_designate_count + v_index];
    v_occupant_roster_id := v_occ_roster_ids[v_index];
    v_occupant_player_id := v_occ_player_ids[v_index];
    BEGIN
      PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_candidate_player_id);
      PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_occupant_player_id);
      PERFORM private.toggle_ir_for_activation(v_candidate_roster_id, true, v_user_id, v_occupant_roster_id);
      PERFORM private.toggle_ir_for_activation(v_occupant_roster_id, false, v_user_id, NULL);
      v_swapped_occupants := v_swapped_occupants || v_occupant_roster_id;
      v_moves := v_moves || jsonb_build_object(
        'kind', 'swap',
        'designatePlayerId', v_candidate_player_id,
        'activatePlayerId', v_occupant_player_id
      );
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate_player_id, 'reason', SQLERRM);
    END;
  END LOOP;

  FOR v_index IN 1..v_occupant_count LOOP
    v_occupant_roster_id := v_occ_roster_ids[v_index];
    v_occupant_player_id := v_occ_player_ids[v_index];
    v_occupant_name := v_occ_names[v_index];
    IF v_occupant_roster_id = ANY(v_swapped_occupants) THEN
      CONTINUE;
    END IF;
    SELECT count(*) INTO v_active_now
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND member_id = p_member_id
       AND NOT is_on_ir
       AND NOT is_on_taxi;
    IF v_active_now < v_roster_size THEN
      BEGIN
        PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_occupant_player_id);
        PERFORM private.toggle_ir_for_activation(v_occupant_roster_id, false, v_user_id, NULL);
        v_moves := v_moves || jsonb_build_object('kind', 'activate', 'activatePlayerId', v_occupant_player_id);
      EXCEPTION WHEN OTHERS THEN
        v_skipped := v_skipped || jsonb_build_object('playerId', v_occupant_player_id, 'reason', SQLERRM);
      END;
    ELSE
      v_notices := v_notices || jsonb_build_object(
        'playerId', v_occupant_player_id,
        'playerName', v_occupant_name,
        'reason', 'healthy_ir_bench_full',
        'action', 'Drop a player, then activate ' || v_occupant_name
      );
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

REVOKE ALL ON FUNCTION public.auto_manage_ir_service(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_manage_ir_service(uuid, uuid, uuid) TO service_role;
