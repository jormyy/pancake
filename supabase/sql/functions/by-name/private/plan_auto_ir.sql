-- Canonical SQL source for private.plan_auto_ir.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.plan_auto_ir(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_league leagues%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_roster_size int;
  v_ir_slots int;
  v_ir_count int;
  v_active_count int;
  v_open_slots int;
  v_free_places int;
  v_pool_places int;
  v_candidate_count int;
  v_occupant_count int;
  v_incumbent_count int;
  v_pool_count int;
  v_selected_count int;
  v_designate_count int;
  v_healthy_swap_count int;
  v_incumbent_swap_count int;
  v_uncertain_count int;
  v_index int;
  v_boundary_date date;
  v_candidate record;
  v_occupant record;
  v_taxi record;
  v_return_date date;
  v_active_eligible_count int := 0;
  v_cand_roster_ids uuid[] := ARRAY[]::uuid[];
  v_cand_player_ids uuid[] := ARRAY[]::uuid[];
  v_cand_names text[] := ARRAY[]::text[];
  v_cand_dates date[] := ARRAY[]::date[];
  v_cand_reliable boolean[] := ARRAY[]::boolean[];
  v_occ_roster_ids uuid[] := ARRAY[]::uuid[];
  v_occ_player_ids uuid[] := ARRAY[]::uuid[];
  v_occ_names text[] := ARRAY[]::text[];
  v_inc_roster_ids uuid[] := ARRAY[]::uuid[];
  v_inc_player_ids uuid[] := ARRAY[]::uuid[];
  v_inc_names text[] := ARRAY[]::text[];
  v_inc_dates date[] := ARRAY[]::date[];
  v_pool_roster_ids uuid[];
  v_pool_player_ids uuid[];
  v_pool_names text[];
  v_pool_dates date[];
  v_pool_reliable boolean[];
  v_pool_is_incumbent boolean[];
  v_sorted_roster_ids uuid[];
  v_sorted_player_ids uuid[];
  v_sorted_names text[];
  v_sorted_dates date[];
  v_sorted_reliable boolean[];
  v_sorted_is_incumbent boolean[];
  v_placed_contender_roster_ids uuid[] := ARRAY[]::uuid[];
  v_placed_contender_player_ids uuid[] := ARRAY[]::uuid[];
  v_exchange_incumbent_roster_ids uuid[] := ARRAY[]::uuid[];
  v_exchange_incumbent_player_ids uuid[] := ARRAY[]::uuid[];
  v_moves jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_notices jsonb := '[]'::jsonb;
  v_active_now int;
  v_unplaced_eligible_active int;
  v_unplaced_usable_active int;
  v_swap_available boolean;
  v_occupant_roster_id uuid;
  v_occupant_player_id uuid;
  v_occupant_name text;
  v_placed_count int;
BEGIN
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

  v_roster_size := COALESCE(v_league.roster_size, 20);
  v_ir_slots := COALESCE(v_league.ir_slots, 2);

  SELECT count(*) FILTER (WHERE is_on_ir),
         count(*) FILTER (WHERE NOT is_on_ir AND NOT is_on_taxi)
    INTO v_ir_count, v_active_count
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;

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
    v_active_eligible_count := v_active_eligible_count + 1;
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

    v_return_date := private.ir_reliable_return(v_candidate.injury_expected_return, v_today);
    v_cand_roster_ids := v_cand_roster_ids || v_candidate.roster_player_id;
    v_cand_player_ids := v_cand_player_ids || v_candidate.player_id;
    v_cand_names := v_cand_names || v_candidate.player_name;
    v_cand_dates := v_cand_dates || v_return_date;
    v_cand_reliable := v_cand_reliable || (v_return_date IS NOT NULL);
  END LOOP;

  FOR v_occupant IN
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
       AND rp.is_on_ir
     ORDER BY rp.id
  LOOP
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

    IF NOT private.is_ir_designation(v_occupant.injury_status) THEN
      v_occ_roster_ids := v_occ_roster_ids || v_occupant.roster_player_id;
      v_occ_player_ids := v_occ_player_ids || v_occupant.player_id;
      v_occ_names := v_occ_names || v_occupant.player_name;
    ELSE
      v_return_date := private.ir_reliable_return(v_occupant.injury_expected_return, v_today);
      IF v_return_date IS NOT NULL THEN
        v_inc_roster_ids := v_inc_roster_ids || v_occupant.roster_player_id;
        v_inc_player_ids := v_inc_player_ids || v_occupant.player_id;
        v_inc_names := v_inc_names || v_occupant.player_name;
        v_inc_dates := v_inc_dates || v_return_date;
      END IF;
    END IF;
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
  v_incumbent_count := COALESCE(array_length(v_inc_roster_ids, 1), 0);
  v_open_slots := GREATEST(v_ir_slots - v_ir_count, 0);
  v_free_places := v_open_slots + v_occupant_count;
  v_pool_places := v_free_places + v_incumbent_count;

  IF v_candidate_count <= v_free_places THEN
    v_placed_contender_roster_ids := v_cand_roster_ids;
    v_placed_contender_player_ids := v_cand_player_ids;
  ELSE
    v_pool_roster_ids := v_cand_roster_ids || v_inc_roster_ids;
    v_pool_player_ids := v_cand_player_ids || v_inc_player_ids;
    v_pool_names := v_cand_names || v_inc_names;
    v_pool_dates := v_cand_dates || v_inc_dates;
    v_pool_reliable := v_cand_reliable || array_fill(true, ARRAY[v_incumbent_count]);
    v_pool_is_incumbent := array_fill(false, ARRAY[v_candidate_count]) || array_fill(true, ARRAY[v_incumbent_count]);
    v_pool_count := v_candidate_count + v_incumbent_count;

    SELECT array_agg(roster_player_id ORDER BY reliable DESC, reliable_date DESC NULLS LAST, is_incumbent ASC, roster_player_id),
           array_agg(player_id ORDER BY reliable DESC, reliable_date DESC NULLS LAST, is_incumbent ASC, roster_player_id),
           array_agg(player_name ORDER BY reliable DESC, reliable_date DESC NULLS LAST, is_incumbent ASC, roster_player_id),
           array_agg(reliable_date ORDER BY reliable DESC, reliable_date DESC NULLS LAST, is_incumbent ASC, roster_player_id),
           array_agg(reliable ORDER BY reliable DESC, reliable_date DESC NULLS LAST, is_incumbent ASC, roster_player_id),
           array_agg(is_incumbent ORDER BY reliable DESC, reliable_date DESC NULLS LAST, is_incumbent ASC, roster_player_id)
      INTO v_sorted_roster_ids, v_sorted_player_ids, v_sorted_names, v_sorted_dates, v_sorted_reliable, v_sorted_is_incumbent
      FROM unnest(v_pool_roster_ids, v_pool_player_ids, v_pool_names, v_pool_dates, v_pool_reliable, v_pool_is_incumbent)
        AS t(roster_player_id, player_id, player_name, reliable_date, reliable, is_incumbent);

    SELECT count(*) INTO v_uncertain_count FROM unnest(v_sorted_reliable) AS r WHERE NOT r;

    v_selected_count := 0;
    IF v_uncertain_count = 0 THEN
      v_index := LEAST(v_pool_places, v_pool_count - 1);
      WHILE v_index >= 1 LOOP
        IF v_sorted_dates[v_index] > v_sorted_dates[v_index + 1] THEN
          v_selected_count := v_index;
          EXIT;
        END IF;
        v_index := v_index - 1;
      END LOOP;
    END IF;

    FOR v_index IN 1..v_selected_count LOOP
      IF NOT v_sorted_is_incumbent[v_index] THEN
        v_placed_contender_roster_ids := v_placed_contender_roster_ids || v_sorted_roster_ids[v_index];
        v_placed_contender_player_ids := v_placed_contender_player_ids || v_sorted_player_ids[v_index];
      END IF;
    END LOOP;

    FOR v_index IN REVERSE v_pool_count..(v_selected_count + 1) LOOP
      IF v_sorted_is_incumbent[v_index] THEN
        v_exchange_incumbent_roster_ids := v_exchange_incumbent_roster_ids || v_sorted_roster_ids[v_index];
        v_exchange_incumbent_player_ids := v_exchange_incumbent_player_ids || v_sorted_player_ids[v_index];
      END IF;
    END LOOP;

    IF v_selected_count < LEAST(v_pool_places, v_pool_count) THEN
      v_boundary_date := v_sorted_dates[v_selected_count + 1];
      FOR v_index IN (v_selected_count + 1)..v_pool_count LOOP
        IF NOT v_sorted_is_incumbent[v_index]
           AND (NOT v_sorted_reliable[v_index]
                OR v_sorted_dates[v_index] IS NOT DISTINCT FROM v_boundary_date) THEN
          v_notices := v_notices || jsonb_build_object(
            'playerId', v_sorted_player_ids[v_index],
            'playerName', v_sorted_names[v_index],
            'reason', 'ir_choice_uncertain',
            'action', 'Choose who moves to IR'
          );
        END IF;
      END LOOP;
    END IF;
  END IF;

  v_placed_count := COALESCE(array_length(v_placed_contender_roster_ids, 1), 0);
  v_designate_count := LEAST(v_open_slots, v_placed_count);
  v_healthy_swap_count := LEAST(v_occupant_count, v_placed_count - v_designate_count);
  v_incumbent_swap_count := v_placed_count - v_designate_count - v_healthy_swap_count;

  FOR v_index IN 1..v_designate_count LOOP
    v_moves := v_moves || jsonb_build_object(
      'kind', 'designate',
      'designatePlayerId', v_placed_contender_player_ids[v_index],
      'designateRosterPlayerId', v_placed_contender_roster_ids[v_index]
    );
  END LOOP;

  FOR v_index IN 1..v_healthy_swap_count LOOP
    v_moves := v_moves || jsonb_build_object(
      'kind', 'swap',
      'swapKind', 'healthy',
      'designatePlayerId', v_placed_contender_player_ids[v_designate_count + v_index],
      'designateRosterPlayerId', v_placed_contender_roster_ids[v_designate_count + v_index],
      'activatePlayerId', v_occ_player_ids[v_index],
      'activateRosterPlayerId', v_occ_roster_ids[v_index]
    );
  END LOOP;

  FOR v_index IN 1..v_incumbent_swap_count LOOP
    v_moves := v_moves || jsonb_build_object(
      'kind', 'swap',
      'swapKind', 'incumbent',
      'designatePlayerId', v_placed_contender_player_ids[v_designate_count + v_healthy_swap_count + v_index],
      'designateRosterPlayerId', v_placed_contender_roster_ids[v_designate_count + v_healthy_swap_count + v_index],
      'activatePlayerId', v_exchange_incumbent_player_ids[v_index],
      'activateRosterPlayerId', v_exchange_incumbent_roster_ids[v_index]
    );
  END LOOP;

  v_active_now := v_active_count - v_designate_count;
  v_unplaced_eligible_active := v_active_eligible_count - v_placed_count;
  v_unplaced_usable_active := v_candidate_count - v_placed_count;
  v_swap_available := v_unplaced_usable_active > 0;
  FOR v_index IN (v_healthy_swap_count + 1)..v_occupant_count LOOP
    v_occupant_roster_id := v_occ_roster_ids[v_index];
    v_occupant_player_id := v_occ_player_ids[v_index];
    v_occupant_name := v_occ_names[v_index];
    IF v_active_now < v_roster_size THEN
      v_moves := v_moves || jsonb_build_object(
        'kind', 'activate',
        'activatePlayerId', v_occupant_player_id,
        'activateRosterPlayerId', v_occupant_roster_id
      );
      v_active_now := v_active_now + 1;
    ELSE
      v_notices := v_notices || jsonb_build_object(
        'playerId', v_occupant_player_id,
        'playerName', v_occupant_name,
        'reason', CASE
          WHEN v_unplaced_usable_active > 0 THEN 'healthy_ir_swap_available'
          WHEN v_unplaced_eligible_active > 0 THEN 'healthy_ir_swap_locked'
          ELSE 'healthy_ir_bench_full' END,
        'action', CASE
          WHEN v_unplaced_usable_active > 0 THEN 'Swap ' || v_occupant_name || ' with an injured player'
          WHEN v_unplaced_eligible_active > 0 THEN 'Swap ' || v_occupant_name || ' with an injured player after their game or pending move clears'
          ELSE 'Drop a player, then activate ' || v_occupant_name END
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object('moves', v_moves, 'skipped', v_skipped, 'notices', v_notices);
END;
$function$;
