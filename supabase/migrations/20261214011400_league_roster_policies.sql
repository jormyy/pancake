CREATE TABLE private.league_roster_policies (
  league_id uuid PRIMARY KEY REFERENCES public.leagues(id) ON DELETE CASCADE,
  weekly_roster_floor smallint CHECK (weekly_roster_floor BETWEEN 1 AND 30),
  auto_ir_all_members boolean NOT NULL DEFAULT false,
  floor_activated_at timestamptz,
  ir_activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.league_roster_policies OWNER TO postgres;
ALTER TABLE private.league_roster_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.league_roster_policies FROM PUBLIC, anon, authenticated;

INSERT INTO private.retention_rules(relation_name,retention_rule) VALUES
('private.league_roster_policies','One policy row per league; league deletion cascades')
ON CONFLICT(relation_name) DO UPDATE SET retention_rule=EXCLUDED.retention_rule;





CREATE OR REPLACE FUNCTION private.league_auto_ir_all_members(p_league_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    (SELECT policy.auto_ir_all_members
       FROM private.league_roster_policies policy
      WHERE policy.league_id = p_league_id
        AND policy.ir_activated_at IS NOT NULL),
    false
  );
$function$;

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
  v_league_auto_ir boolean;
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
  v_planned_contender_return date;
  v_planned_incumbent_return date;
  v_compared_player_id uuid;
  v_compared_return date;
  v_compared_on_ir boolean;
  v_moves jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_notices jsonb := '[]'::jsonb;
  v_taxi_before jsonb;
  v_taxi_after jsonb;
  v_ids_before uuid[];
  v_ids_after uuid[];
  v_problems_before text[];
  v_problems_after text[];
  v_transient text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));

  SELECT enabled INTO v_enabled
    FROM lineup_optimizer_settings
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;
  v_league_auto_ir := private.league_auto_ir_all_members(p_league_id);
  IF NOT COALESCE(v_enabled, false) AND NOT v_league_auto_ir THEN
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

  SELECT enabled INTO v_enabled
    FROM lineup_optimizer_settings
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id
   FOR SHARE;
  v_league_auto_ir := private.league_auto_ir_all_members(p_league_id);
  IF NOT COALESCE(v_enabled, false) AND NOT v_league_auto_ir THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

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
        IF SQLSTATE IN ('55P03', '40001', '40P01', '57014') THEN v_transient := SQLSTATE; END IF;
        v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate_player_id, 'reason', SQLERRM, 'sqlstate', SQLSTATE);
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
          SELECT p.injury_status, private.ir_reliable_return(p.injury_expected_return, v_today)
            INTO v_candidate_status, v_candidate_return
            FROM roster_players rp
            JOIN players p ON p.id = rp.player_id
           WHERE rp.id = v_candidate_roster_id
           FOR SHARE OF p;
          SELECT p.injury_status, private.ir_reliable_return(p.injury_expected_return, v_today), rp.is_on_ir
            INTO v_occupant_status, v_occupant_return, v_occupant_on_ir
            FROM roster_players rp
            JOIN players p ON p.id = rp.player_id
           WHERE rp.id = v_occupant_roster_id
           FOR SHARE OF p;
          v_planned_contender_return := (v_move->>'plannedContenderReturn')::date;
          v_planned_incumbent_return := (v_move->>'plannedIncumbentReturn')::date;
          IF NOT private.is_ir_designation(v_candidate_status)
             OR v_candidate_return IS NULL
             OR v_planned_contender_return IS NULL
             OR v_candidate_return <> v_planned_contender_return
             OR NOT v_occupant_on_ir
             OR NOT private.is_ir_designation(v_occupant_status)
             OR v_occupant_return IS NULL
             OR v_planned_incumbent_return IS NULL
             OR v_occupant_return <> v_planned_incumbent_return
             OR v_planned_contender_return <= v_planned_incumbent_return THEN
            RAISE EXCEPTION 'Incumbent exchange no longer valid.' USING ERRCODE = 'P0001';
          END IF;
          FOR v_compared_player_id IN
            SELECT (value)::uuid
              FROM jsonb_array_elements_text(COALESCE(v_move->'comparedIncumbentPlayerIds', '[]'::jsonb))
             ORDER BY 1
          LOOP
            SELECT private.ir_reliable_return(p.injury_expected_return, v_today), rp.is_on_ir
              INTO v_compared_return, v_compared_on_ir
              FROM roster_players rp
              JOIN players p ON p.id = rp.player_id
             WHERE rp.league_id = p_league_id
               AND rp.league_season_id = p_league_season_id
               AND rp.member_id = p_member_id
               AND rp.player_id = v_compared_player_id
             FOR SHARE OF p;
            IF v_compared_on_ir AND v_compared_return IS NOT NULL AND v_compared_return <= v_planned_incumbent_return THEN
              RAISE EXCEPTION 'Incumbent exchange no longer valid.' USING ERRCODE = 'P0001';
            END IF;
          END LOOP;
          PERFORM private.toggle_ir_for_activation(v_candidate_roster_id, true, v_user_id, v_occupant_roster_id);
          PERFORM private.toggle_ir_for_activation(v_occupant_roster_id, false, v_user_id, NULL);
          v_moves := v_moves || jsonb_build_object(
            'kind', 'swap',
            'designatePlayerId', v_candidate_player_id,
            'activatePlayerId', v_occupant_player_id
          );
        EXCEPTION WHEN OTHERS THEN
          IF SQLSTATE IN ('55P03', '40001', '40P01', '57014') THEN v_transient := SQLSTATE; END IF;
          v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate_player_id, 'reason', SQLERRM, 'sqlstate', SQLSTATE);
        END;
      ELSE
        BEGIN
          PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_candidate_player_id);
          PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_occupant_player_id);
          SELECT p.injury_status, rp.is_on_ir
            INTO v_occupant_status, v_occupant_on_ir
            FROM roster_players rp
            JOIN players p ON p.id = rp.player_id
           WHERE rp.id = v_occupant_roster_id
           FOR SHARE OF p;
          IF NOT v_occupant_on_ir OR private.is_ir_designation(v_occupant_status) THEN
            RAISE EXCEPTION 'Healthy occupant is no longer activatable.' USING ERRCODE = 'P0001';
          END IF;
          PERFORM private.toggle_ir_for_activation(v_candidate_roster_id, true, v_user_id, v_occupant_roster_id);
          PERFORM private.toggle_ir_for_activation(v_occupant_roster_id, false, v_user_id, NULL);
          v_moves := v_moves || jsonb_build_object(
            'kind', 'swap',
            'designatePlayerId', v_candidate_player_id,
            'activatePlayerId', v_occupant_player_id
          );
        EXCEPTION WHEN OTHERS THEN
          IF SQLSTATE IN ('55P03', '40001', '40P01', '57014') THEN v_transient := SQLSTATE; END IF;
          v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate_player_id, 'reason', SQLERRM, 'sqlstate', SQLSTATE);
        END;
      END IF;
    ELSIF v_kind = 'activate' THEN
      v_occupant_roster_id := (v_move->>'activateRosterPlayerId')::uuid;
      v_occupant_player_id := (v_move->>'activatePlayerId')::uuid;
      BEGIN
        PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_occupant_player_id);
        SELECT p.injury_status, rp.is_on_ir
          INTO v_occupant_status, v_occupant_on_ir
          FROM roster_players rp
          JOIN players p ON p.id = rp.player_id
         WHERE rp.id = v_occupant_roster_id
         FOR SHARE OF p;
        IF NOT v_occupant_on_ir OR private.is_ir_designation(v_occupant_status) THEN
          RAISE EXCEPTION 'Healthy occupant is no longer activatable.' USING ERRCODE = 'P0001';
        END IF;
        PERFORM private.toggle_ir_for_activation(v_occupant_roster_id, false, v_user_id, NULL);
        v_moves := v_moves || jsonb_build_object('kind', 'activate', 'activatePlayerId', v_occupant_player_id);
      EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE IN ('55P03', '40001', '40P01', '57014') THEN v_transient := SQLSTATE; END IF;
        v_skipped := v_skipped || jsonb_build_object('playerId', v_occupant_player_id, 'reason', SQLERRM, 'sqlstate', SQLSTATE);
      END;
    END IF;
  END LOOP;

  IF v_transient IS NOT NULL AND v_league_auto_ir THEN
    RAISE EXCEPTION 'Auto IR move failed transiently (%)', v_transient USING ERRCODE = v_transient;
  END IF;

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

CREATE OR REPLACE FUNCTION public.get_auto_ir_notices(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_member_id uuid;
  v_enabled boolean;
  v_league_auto_ir boolean;
  v_plan jsonb;
BEGIN
  SELECT member.id INTO v_member_id
    FROM league_members member
   WHERE member.league_id = p_league_id
     AND member.id IN (SELECT private.my_member_ids())
   LIMIT 1;
  IF v_member_id IS NULL THEN
    RETURN jsonb_build_object('enabled', false, 'notices', '[]'::jsonb);
  END IF;

  SELECT enabled INTO v_enabled
    FROM lineup_optimizer_settings
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = v_member_id;
  v_league_auto_ir := private.league_auto_ir_all_members(p_league_id);
  IF NOT COALESCE(v_enabled, false) AND NOT v_league_auto_ir THEN
    RETURN jsonb_build_object('enabled', false, 'notices', '[]'::jsonb);
  END IF;

  v_plan := private.plan_auto_ir(p_league_id, p_league_season_id, v_member_id);
  RETURN jsonb_build_object('enabled', true, 'notices', COALESCE(v_plan->'notices', '[]'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION private.ir_reliable_return(text, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.plan_auto_ir(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.league_auto_ir_all_members(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.league_auto_ir_all_members(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.auto_manage_ir_service(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_manage_ir_service(uuid, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.get_auto_ir_notices(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_auto_ir_notices(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION private.activate_league_roster_policy(p_league_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated int;
BEGIN
  UPDATE private.league_roster_policies
     SET floor_activated_at = COALESCE(floor_activated_at, now()),
         ir_activated_at = COALESCE(ir_activated_at, now())
   WHERE league_id = p_league_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;
