-- Canonical SQL source for private.run_league_roster_floor.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.run_league_roster_floor(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_league public.leagues%ROWTYPE;
  v_season public.league_seasons%ROWTYPE;
  v_floor int;
  v_target int;
  v_week_number int;
  v_week_end date;
  v_latest_week_number int;
  v_latest_week_end date;
  v_pending_week_number int;
  v_pending_week_end date;
  v_zone text;
  v_league_today date;
  v_ready jsonb;
  v_ir jsonb;
  v_ir_sqlstate text;
  v_watermark text;
  v_week_row private.roster_floor_weeks%ROWTYPE;
  v_member record;
  v_team uuid;
  v_active int;
  v_player record;
  v_awarded int := 0;
  v_pass_awarded int;
  v_short boolean;
  v_teams jsonb;
  v_members uuid[];
  v_order uuid[];
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_invocation text := nullif(nullif(current_setting('request.headers', true), '')::jsonb->>'x-pancake-work-key', '');
BEGIN
  SELECT * INTO v_league FROM public.leagues WHERE id = p_league_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'league');
  END IF;
  IF v_league.status NOT IN ('active'::public.league_status, 'playoffs'::public.league_status) THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'league_status');
  END IF;
  SELECT * INTO v_season
    FROM public.league_seasons
   WHERE id = p_league_season_id
     AND league_id = p_league_id
     AND is_current;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'season');
  END IF;
  SELECT policy.weekly_roster_floor
    INTO v_floor
    FROM private.league_roster_policies policy
   WHERE policy.league_id = p_league_id;
  IF v_floor IS NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'disabled');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM private.league_roster_policies policy
     WHERE policy.league_id = p_league_id
       AND policy.floor_activated_at IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('status', 'deferred', 'reason', 'worker_pending');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM private.league_roster_policies policy
     WHERE policy.league_id = p_league_id
       AND policy.ir_activated_at IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('status', 'deferred', 'reason', 'ir_pending');
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_league_season_id::text)) THEN
    RETURN jsonb_build_object('status', 'deferred', 'reason', 'busy');
  END IF;

  v_zone := COALESCE(v_league.timezone, 'America/Los_Angeles');
  v_league_today := (now() AT TIME ZONE v_zone)::date;

  SELECT week.week_number, week.week_end
    INTO v_latest_week_number, v_latest_week_end
    FROM private.roster_floor_week(p_league_id, p_league_season_id) week;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_week');
  END IF;

  SELECT week_row.week_number, week_row.week_end
    INTO v_pending_week_number, v_pending_week_end
    FROM private.roster_floor_weeks week_row
   WHERE week_row.league_id = p_league_id
     AND week_row.league_season_id = p_league_season_id
     AND week_row.status = 'pending'
     AND week_row.week_end <= v_league_today
     AND EXISTS (
       SELECT 1
         FROM public.matchups matchup
        WHERE matchup.league_id = p_league_id
          AND matchup.league_season_id = p_league_season_id
          AND matchup.week_number = week_row.week_number
     )
   ORDER BY week_row.week_end, week_row.week_number
   LIMIT 1;

  IF FOUND AND v_pending_week_end < v_latest_week_end
     AND (v_latest_week_end + time '00:00') AT TIME ZONE v_zone <= now() THEN
    UPDATE private.roster_floor_weeks week_row
       SET status = 'expired', expired_at = now()
     WHERE week_row.league_id = p_league_id
       AND week_row.league_season_id = p_league_season_id
       AND week_row.status = 'pending'
       AND week_row.week_end < v_latest_week_end;
    v_week_number := v_latest_week_number;
    v_week_end := v_latest_week_end;
  ELSIF FOUND THEN
    v_week_number := v_pending_week_number;
    v_week_end := v_pending_week_end;
  ELSE
    v_week_number := v_latest_week_number;
    v_week_end := v_latest_week_end;
  END IF;

  v_target := LEAST(v_floor, COALESCE(v_league.roster_size, 20));

  INSERT INTO private.roster_floor_weeks(league_id, league_season_id, week_number, week_end, team_order, status)
  SELECT p_league_id, p_league_season_id, v_week_number, v_week_end,
    COALESCE(array_agg(member.id ORDER BY random()), ARRAY[]::uuid[]), 'pending'
    FROM public.league_members member
   WHERE member.league_id = p_league_id
  ON CONFLICT (league_id, league_season_id, week_number) DO NOTHING;

  SELECT * INTO v_week_row
    FROM private.roster_floor_weeks week_row
   WHERE week_row.league_id = p_league_id
     AND week_row.league_season_id = p_league_season_id
     AND week_row.week_number = v_week_number
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_week');
  END IF;
  IF v_week_row.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'completed', 'weekNumber', v_week_number,
      'weekEnd', v_week_end, 'awarded', 0);
  END IF;
  IF v_week_row.status = 'expired' THEN
    RETURN jsonb_build_object('status', 'expired', 'weekNumber', v_week_number,
      'weekEnd', v_week_end, 'awarded', 0);
  END IF;

  WITH locked AS (
    SELECT member.id, member.joined_at
      FROM public.league_members member
     WHERE member.league_id = p_league_id
     ORDER BY member.id
     FOR KEY SHARE
  ),
  ordered AS (
    SELECT stored.member_id, stored.position
      FROM unnest(v_week_row.team_order) WITH ORDINALITY AS stored(member_id, position)
     WHERE stored.member_id IN (SELECT locked.id FROM locked)
    UNION ALL
    SELECT newcomer.id, newcomer.position
      FROM (
        SELECT locked.id,
               COALESCE(array_length(v_week_row.team_order, 1), 0)
                 + row_number() OVER (ORDER BY locked.joined_at, locked.id) AS position
          FROM locked
         WHERE NOT (locked.id = ANY(v_week_row.team_order))
      ) newcomer
  )
  SELECT (SELECT COALESCE(array_agg(ordered.member_id ORDER BY ordered.position), ARRAY[]::uuid[]) FROM ordered),
         (SELECT COALESCE(array_agg(locked.id ORDER BY locked.id), ARRAY[]::uuid[]) FROM locked)
    INTO v_order, v_members;

  IF v_order IS DISTINCT FROM v_week_row.team_order THEN
    UPDATE private.roster_floor_weeks
       SET team_order = v_order
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND week_number = v_week_number;
    v_week_row.team_order := v_order;
  END IF;

  v_ready := private.roster_floor_week_ready(p_league_id, p_league_season_id, v_week_number, v_week_end);
  IF NOT COALESCE((v_ready->>'ready')::boolean, false) THEN
    UPDATE private.roster_floor_weeks
       SET last_deferral_reason = v_ready->>'reason', last_deferred_at = now()
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND week_number = v_week_number;
    RETURN jsonb_build_object('status', 'deferred', 'reason', v_ready->>'reason',
      'weekNumber', v_week_number, 'weekEnd', v_week_end);
  END IF;

  IF NOT private.roster_floor_averages_ready(p_league_id, p_league_season_id) THEN
    UPDATE private.roster_floor_weeks
       SET last_deferral_reason = 'averages_pending', last_deferred_at = now()
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND week_number = v_week_number;
    RETURN jsonb_build_object('status', 'deferred', 'reason', 'averages_pending',
      'weekNumber', v_week_number, 'weekEnd', v_week_end);
  END IF;
  v_watermark := private.roster_floor_averages_watermark(p_league_id, p_league_season_id);

  BEGIN
    IF v_invocation IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM private.work_items item
       WHERE item.invocation_key = v_invocation::uuid
         AND item.status = 'running'
         AND item.lease_until > clock_timestamp()
    ) THEN
      RAISE EXCEPTION 'Work lease is no longer current' USING ERRCODE = 'PT409';
    END IF;
    FOR v_member IN
      SELECT unnest(v_members) AS id
    LOOP
      v_ir := public.auto_manage_ir_service(p_league_id, p_league_season_id, v_member.id);
      SELECT skipped->>'sqlstate'
        INTO v_ir_sqlstate
        FROM jsonb_array_elements(COALESCE(v_ir->'skipped', '[]'::jsonb)) skipped
       WHERE skipped->>'sqlstate' IN ('55P03', '40001', '40P01', '57014')
       LIMIT 1;
      IF v_ir_sqlstate IS NOT NULL THEN
        RAISE EXCEPTION 'Auto IR move failed transiently (%)', v_ir_sqlstate USING ERRCODE = v_ir_sqlstate;
      END IF;
    END LOOP;

    LOOP
      v_pass_awarded := 0;
      v_short := false;
      FOR v_team IN SELECT unnest(v_order) AS member_id LOOP
        SELECT count(*)
          INTO v_active
          FROM public.roster_players roster
         WHERE roster.league_id = p_league_id
           AND roster.league_season_id = p_league_season_id
           AND roster.member_id = v_team
           AND NOT roster.is_on_ir
           AND NOT roster.is_on_taxi;
        IF v_active >= v_target THEN
          CONTINUE;
        END IF;
        v_short := true;
        PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_team::text));
        SELECT count(*)
          INTO v_active
          FROM public.roster_players roster
         WHERE roster.league_id = p_league_id
           AND roster.league_season_id = p_league_season_id
           AND roster.member_id = v_team
           AND NOT roster.is_on_ir
           AND NOT roster.is_on_taxi;
        IF v_active >= v_target THEN
          CONTINUE;
        END IF;
        FOR v_player IN
          SELECT pool.player_id, pool.avg_fantasy_points
            FROM private.roster_floor_pool(p_league_id, p_league_season_id) pool
           WHERE NOT EXISTS (
             SELECT 1
               FROM private.roster_floor_awards award
              WHERE award.league_id = p_league_id
                AND award.league_season_id = p_league_season_id
                AND award.week_number = v_week_number
                AND award.player_id = pool.player_id
           )
           ORDER BY pool.avg_fantasy_points DESC, pool.player_id
        LOOP
          PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_player.player_id::text));
          IF NOT private.roster_floor_player_legal(p_league_id, p_league_season_id, v_player.player_id) THEN
            CONTINUE;
          END IF;
          IF EXISTS (
            SELECT 1
              FROM public.nba_games game
             WHERE game.game_date IN (v_today - 1, v_today)
               AND game.status IN ('Scheduled', 'InProgress')
               AND private.lineup_game_available(game.status, game.game_status_text)
               AND (
                 game.status = 'InProgress'
                 OR game.game_time <= clock_timestamp()
                 OR game.started_at <= clock_timestamp()
               )
          ) THEN
            RAISE EXCEPTION 'Roster floor deferred: a game is in progress' USING ERRCODE = 'PF001';
          END IF;
          BEGIN
            INSERT INTO public.roster_players(
              league_id, league_season_id, member_id, player_id, acquired_via, is_on_ir, is_on_taxi
            )
            VALUES (
              p_league_id, p_league_season_id, v_team, v_player.player_id, 'roster_floor', false, false
            );
            PERFORM private.assert_accepted_trade_capacity(p_league_id, p_league_season_id, v_team);
            INSERT INTO public.roster_transactions(
              league_id, league_season_id, member_id, player_id, transaction_type
            )
            VALUES (
              p_league_id, p_league_season_id, v_team, v_player.player_id, 'fa_add'
            );
            INSERT INTO private.roster_floor_awards(
              league_id, league_season_id, week_number, member_id, player_id
            )
            VALUES (
              p_league_id, p_league_season_id, v_week_number, v_team, v_player.player_id
            );
            IF NOT private.roster_floor_averages_ready(p_league_id, p_league_season_id)
               OR private.roster_floor_averages_watermark(p_league_id, p_league_season_id) IS DISTINCT FROM v_watermark THEN
              RAISE EXCEPTION 'Roster floor averages changed during the pass' USING ERRCODE = 'PF002';
            END IF;
            v_awarded := v_awarded + 1;
            v_pass_awarded := v_pass_awarded + 1;
            EXIT;
          EXCEPTION WHEN SQLSTATE 'PT409' THEN
            IF v_invocation IS NOT NULL AND NOT EXISTS (
              SELECT 1
                FROM private.work_items item
               WHERE item.invocation_key = v_invocation::uuid
                 AND item.status = 'running'
                 AND item.lease_until > clock_timestamp()
            ) THEN
              RAISE;
            END IF;
          END;
        END LOOP;
      END LOOP;
      EXIT WHEN NOT v_short OR v_pass_awarded = 0;
    END LOOP;

    IF NOT private.roster_floor_averages_ready(p_league_id, p_league_season_id)
       OR private.roster_floor_averages_watermark(p_league_id, p_league_season_id) IS DISTINCT FROM v_watermark THEN
      RAISE EXCEPTION 'Roster floor averages changed during the pass' USING ERRCODE = 'PF002';
    END IF;
    IF v_invocation IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM private.work_items item
       WHERE item.invocation_key = v_invocation::uuid
         AND item.status = 'running'
         AND item.lease_until > clock_timestamp()
    ) THEN
      RAISE EXCEPTION 'Work lease is no longer current' USING ERRCODE = 'PT409';
    END IF;
    UPDATE private.roster_floor_weeks
       SET status = 'completed', completed_at = now(), last_deferral_reason = NULL, last_deferred_at = NULL
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND week_number = v_week_number;
  EXCEPTION WHEN SQLSTATE 'PF001' THEN
    UPDATE private.roster_floor_weeks
       SET last_deferral_reason = 'game_in_progress', last_deferred_at = now()
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND week_number = v_week_number;
    RETURN jsonb_build_object('status', 'deferred', 'reason', 'game_in_progress',
      'weekNumber', v_week_number, 'weekEnd', v_week_end);
  WHEN SQLSTATE 'PF002' THEN
    UPDATE private.roster_floor_weeks
       SET last_deferral_reason = 'averages_pending', last_deferred_at = now()
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND week_number = v_week_number;
    RETURN jsonb_build_object('status', 'deferred', 'reason', 'averages_pending',
      'weekNumber', v_week_number, 'weekEnd', v_week_end);
  WHEN SQLSTATE '55P03' OR SQLSTATE '40001' OR SQLSTATE '40P01' OR SQLSTATE '57014' THEN
    UPDATE private.roster_floor_weeks
       SET last_deferral_reason = 'ir_transient', last_deferred_at = now()
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND week_number = v_week_number;
    RETURN jsonb_build_object('status', 'deferred', 'reason', 'ir_transient',
      'weekNumber', v_week_number, 'weekEnd', v_week_end);
  END;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId', member.id, 'active', counts.active) ORDER BY member.id), '[]'::jsonb)
    INTO v_teams
    FROM public.league_members member
    CROSS JOIN LATERAL (
      SELECT count(*) AS active
        FROM public.roster_players roster
       WHERE roster.league_id = p_league_id
         AND roster.league_season_id = p_league_season_id
         AND roster.member_id = member.id
         AND NOT roster.is_on_ir
         AND NOT roster.is_on_taxi
    ) counts
   WHERE member.league_id = p_league_id;

  RETURN jsonb_build_object('status', 'completed', 'weekNumber', v_week_number,
    'weekEnd', v_week_end, 'floor', v_floor, 'target', v_target,
    'awarded', v_awarded, 'teams', v_teams);
END;
$$;
