CREATE OR REPLACE FUNCTION private.player_slate_games(p_player_id uuid, p_game_date date)
RETURNS SETOF public.nba_games
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH day_games AS MATERIALIZED (
    SELECT * FROM nba_games WHERE game_date = p_game_date
  ), participation AS (
    SELECT game.id
    FROM day_games game
    WHERE EXISTS (
      SELECT 1 FROM player_game_stats stats
      WHERE stats.player_id = p_player_id AND stats.game_id = game.id
    ) OR EXISTS (
      SELECT 1 FROM private.player_game_memberships membership
      WHERE membership.player_id = p_player_id AND membership.game_id = game.id
    )
  )
  SELECT game.* FROM day_games game
  WHERE game.id IN (SELECT id FROM participation)
  UNION ALL
  SELECT game.* FROM day_games game
  JOIN players player ON player.id = p_player_id
  WHERE (game.home_team = player.nba_team OR game.away_team = player.nba_team)
    AND NOT EXISTS (SELECT 1 FROM participation)
$$;

CREATE OR REPLACE FUNCTION private.player_game_started(p_player_id uuid, p_game_date date, p_clock timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM private.player_slate_games(p_player_id, p_game_date) game
    WHERE game.status IN ('InProgress', 'Final')
       OR game.game_time <= p_clock
       OR game.started_at <= p_clock
  )
$$;

CREATE OR REPLACE FUNCTION private.lineup_game_started(p_player_id uuid, p_game_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM private.lineup_history_receipts r
    WHERE r.player_id = p_player_id AND r.game_date = p_game_date)
    OR private.player_game_started(p_player_id, p_game_date, now())
$$;

DROP FUNCTION private.roster_status_game_started(uuid);

CREATE OR REPLACE FUNCTION private.roster_status_game_started(p_player_id uuid, p_clock timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH slate AS (
    SELECT (p_clock AT TIME ZONE 'America/New_York')::date AS today
  )
  SELECT private.player_game_started(p_player_id, slate.today, p_clock) OR EXISTS (
    SELECT 1 FROM private.player_slate_games(p_player_id, slate.today - 1) game
    WHERE game.status = 'InProgress'
       OR game.game_time BETWEEN p_clock - interval '12 hours' AND p_clock
       OR game.started_at BETWEEN p_clock - interval '12 hours' AND p_clock
  )
  FROM slate
$$;

REVOKE ALL ON FUNCTION private.roster_status_game_started(uuid, timestamptz) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.roster_floor_player_legal(
  p_league_id uuid,
  p_league_season_id uuid,
  p_player_id uuid
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.players player
      JOIN public.league_seasons season
        ON season.id = p_league_season_id
       AND season.league_id = p_league_id
      JOIN public.leagues league
        ON league.id = p_league_id
     WHERE player.id = p_player_id
       AND player.nba_team IS NOT NULL
       AND player.injury_status IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.roster_players roster
          WHERE roster.league_id = p_league_id
            AND roster.league_season_id = p_league_season_id
            AND roster.player_id = player.id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.waiver_claims claim
          WHERE claim.league_id = p_league_id
            AND claim.league_season_id = p_league_season_id
            AND claim.player_id = player.id
            AND claim.status = 'pending'
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.waiver_wire_log wire
          WHERE wire.league_id = p_league_id
            AND wire.league_season_id = p_league_season_id
            AND wire.player_id = player.id
            AND wire.cleared_at IS NULL
            AND wire.clears_at > clock_timestamp()
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.trades trade
           JOIN public.trade_items item ON item.trade_id = trade.id
          WHERE trade.league_id = p_league_id
            AND trade.league_season_id = p_league_season_id
            AND trade.status IN ('pending', 'accepted')
            AND item.player_id = player.id
       )
       AND NOT (
         league.status = 'offseason'
         AND player.years_exp = 0
         AND player.nba_draft_number IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM public.drafts draft
            WHERE draft.league_id = p_league_id
              AND draft.league_season_id = p_league_season_id
              AND draft.draft_type = 'snake'
              AND NOT draft.is_mock
              AND draft.status = 'completed'
         )
       )
       AND NOT private.roster_status_game_started(player.id, clock_timestamp())
  )
$$;

CREATE OR REPLACE FUNCTION private.roster_floor_pool(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS TABLE(player_id uuid, avg_fantasy_points numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT player.id, average.avg_fantasy_points
    FROM public.players player
    JOIN public.league_seasons season
      ON season.id = p_league_season_id
     AND season.league_id = p_league_id
    JOIN public.leagues league
      ON league.id = p_league_id
    JOIN public.player_season_averages average
      ON average.league_id = p_league_id
     AND average.league_season_id = p_league_season_id
     AND average.season_year = season.season_year
     AND average.player_id = player.id
   WHERE average.avg_fantasy_points IS NOT NULL
     AND player.nba_team IS NOT NULL
     AND player.injury_status IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.roster_players roster
        WHERE roster.league_id = p_league_id
          AND roster.league_season_id = p_league_season_id
          AND roster.player_id = player.id
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.waiver_wire_log wire
        WHERE wire.league_id = p_league_id
          AND wire.league_season_id = p_league_season_id
          AND wire.player_id = player.id
          AND wire.cleared_at IS NULL
          AND wire.clears_at > now()
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.waiver_claims claim
        WHERE claim.league_id = p_league_id
          AND claim.league_season_id = p_league_season_id
          AND claim.player_id = player.id
          AND claim.status = 'pending'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.trades trade
         JOIN public.trade_items item ON item.trade_id = trade.id
        WHERE trade.league_id = p_league_id
          AND trade.league_season_id = p_league_season_id
          AND trade.status IN ('pending', 'accepted')
          AND item.player_id = player.id
     )
     AND NOT (
       league.status = 'offseason'
       AND player.years_exp = 0
       AND player.nba_draft_number IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.drafts draft
          WHERE draft.league_id = p_league_id
            AND draft.league_season_id = p_league_season_id
            AND draft.draft_type = 'snake'
            AND NOT draft.is_mock
            AND draft.status = 'completed'
       )
     )
     AND NOT private.roster_status_game_started(player.id, clock_timestamp())
   ORDER BY average.avg_fantasy_points DESC, player.id ASC
$$;

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
  PERFORM private.lock_roster_scope(p_league_id, ARRAY[p_member_id], '{}');

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

  PERFORM private.lock_roster_scope(p_league_id, '{}', ARRAY(
    SELECT player_id
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND member_id = p_member_id
  ));

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
    IF v_league_auto_ir AND (
      (v_move ? 'designatePlayerId' AND private.roster_status_game_started((v_move->>'designatePlayerId')::uuid, clock_timestamp()))
      OR (v_move ? 'activatePlayerId' AND private.roster_status_game_started((v_move->>'activatePlayerId')::uuid, clock_timestamp()))
    ) THEN
      v_skipped := v_skipped || jsonb_build_object(
        'playerId', COALESCE(v_move->>'designatePlayerId', v_move->>'activatePlayerId'),
        'reason', 'game_started',
        'sqlstate', 'P0001'
      );
      CONTINUE;
    END IF;
    IF v_kind = 'designate' THEN
      v_candidate_roster_id := (v_move->>'designateRosterPlayerId')::uuid;
      v_candidate_player_id := (v_move->>'designatePlayerId')::uuid;
      BEGIN
        PERFORM private.assert_roster_action_allowed('to_ir', p_league_id, p_league_season_id, p_member_id, v_candidate_player_id);
        PERFORM private.toggle_ir_for_activation(v_candidate_roster_id, true, v_user_id, NULL);
        PERFORM private.assert_accepted_trade_capacity(p_league_id, p_league_season_id, p_member_id);
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
          PERFORM private.assert_roster_action_allowed('to_ir', p_league_id, p_league_season_id, p_member_id, v_candidate_player_id);
          PERFORM private.assert_roster_action_allowed('from_ir', p_league_id, p_league_season_id, p_member_id, v_occupant_player_id);
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
          PERFORM private.assert_accepted_trade_capacity(p_league_id, p_league_season_id, p_member_id);
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
          PERFORM private.assert_roster_action_allowed('to_ir', p_league_id, p_league_season_id, p_member_id, v_candidate_player_id);
          PERFORM private.assert_roster_action_allowed('from_ir', p_league_id, p_league_season_id, p_member_id, v_occupant_player_id);
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
          PERFORM private.assert_accepted_trade_capacity(p_league_id, p_league_season_id, p_member_id);
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
        PERFORM private.assert_roster_action_allowed('from_ir', p_league_id, p_league_season_id, p_member_id, v_occupant_player_id);
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
        PERFORM private.assert_accepted_trade_capacity(p_league_id, p_league_season_id, p_member_id);
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

DROP FUNCTION private.roster_status_game_started_live(uuid);

CREATE OR REPLACE FUNCTION private.prevent_started_game_roster_status_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF private.roster_status_game_started(NEW.player_id) THEN
    RAISE EXCEPTION 'This player''s game has already started. No roster status changes are allowed for that slate.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.prevent_started_game_roster_status_change() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER b_game_lock_roster_status BEFORE UPDATE OF is_on_ir, is_on_taxi ON public.roster_players
FOR EACH ROW WHEN (OLD.member_id = NEW.member_id AND (OLD.is_on_ir, OLD.is_on_taxi) IS DISTINCT FROM (NEW.is_on_ir, NEW.is_on_taxi))
EXECUTE FUNCTION private.prevent_started_game_roster_status_change();

CREATE OR REPLACE FUNCTION public.locked_until_slate_end(p_roster roster_players)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.roster_status_game_started(p_roster.player_id)
$$;

REVOKE ALL ON FUNCTION public.locked_until_slate_end(public.roster_players) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.locked_until_slate_end(public.roster_players) TO authenticated, service_role;
