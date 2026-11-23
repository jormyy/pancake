CREATE OR REPLACE FUNCTION private.lock_roster_scope(
  p_league_id uuid,
  p_member_ids uuid[],
  p_player_ids uuid[],
  p_draft_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_member_id uuid;
  v_player_id uuid;
BEGIN
  IF p_league_id IS NULL AND (
    EXISTS (SELECT 1 FROM unnest(p_member_ids) AS member_id WHERE member_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM unnest(p_player_ids) AS player_id WHERE player_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Roster locks need a league.' USING ERRCODE = '22004';
  END IF;
  IF p_draft_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);
  END IF;
  FOR v_member_id IN
    SELECT DISTINCT member_id FROM unnest(p_member_ids) AS member_id
     WHERE member_id IS NOT NULL ORDER BY member_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_member_id::text));
  END LOOP;
  FOR v_player_id IN
    SELECT DISTINCT player_id FROM unnest(p_player_ids) AS player_id
     WHERE player_id IS NOT NULL ORDER BY player_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_player_id::text));
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.apply_scheduled_lineup(
  p_game_date date, p_league_id uuid, p_league_season_id uuid, p_member_id uuid, p_assignments jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_same boolean;
BEGIN
  PERFORM public.assert_current_league_season_for_lineup(p_league_id, p_league_season_id);
  PERFORM private.lock_roster_scope(p_league_id, ARRAY[p_member_id], '{}');
  PERFORM pg_advisory_xact_lock(hashtext(p_member_id::text), hashtext(p_game_date::text));
  PERFORM 1 FROM public.leagues WHERE id = p_league_id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.players WHERE id IN (
    SELECT (a->>'player_id')::uuid FROM jsonb_array_elements(p_assignments) a
  ) ORDER BY id FOR SHARE;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_assignments) a
    JOIN public.players p ON p.id = (a->>'player_id')::uuid
    WHERE (lower(p.injury_status) = 'out' OR lower(p.injury_status) LIKE 'ir%')
      AND COALESCE((a->>'expected_active')::boolean, true)
      AND NOT private.lineup_game_started(p.id, p_game_date)
  ) THEN
    RAISE EXCEPTION 'Injury status changed; retry with fresh players.' USING ERRCODE = '40001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_assignments) a
    JOIN public.players p ON p.id = (a->>'player_id')::uuid
    WHERE NOT private.lineup_game_started(p.id, p_game_date)
      AND COALESCE((a->>'expected_active')::boolean, true)
      AND NOT EXISTS (
        SELECT 1 FROM public.nba_games g
        WHERE g.game_date = p_game_date
          AND private.lineup_game_available(g.status, g.game_status_text)
          AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)
      )
  ) THEN
    RAISE EXCEPTION 'Game schedule changed; retry with fresh games.' USING ERRCODE = '40001';
  END IF;

  PERFORM private.assert_lineup_player_pins(p_league_id, p_league_season_id, p_member_id, p_game_date, p_assignments);

  SELECT NOT EXISTS (
    (SELECT player_id, slot_type::text FROM public.weekly_lineups
      WHERE member_id = p_member_id AND league_id = p_league_id
        AND league_season_id = p_league_season_id AND game_date = p_game_date
     EXCEPT SELECT (a->>'player_id')::uuid, a->>'slot_type' FROM jsonb_array_elements(p_assignments) a)
    UNION ALL
    (SELECT (a->>'player_id')::uuid, a->>'slot_type' FROM jsonb_array_elements(p_assignments) a
     EXCEPT SELECT player_id, slot_type::text FROM public.weekly_lineups
      WHERE member_id = p_member_id AND league_id = p_league_id
        AND league_season_id = p_league_season_id AND game_date = p_game_date)
  ) INTO v_same;

  IF NOT v_same THEN
    PERFORM public.auto_set_lineup_service_atomic(p_member_id, p_league_id, p_league_season_id,
      p_game_date, p_assignments);
  END IF;
  RETURN NOT v_same;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_legal_roster(p_league_id uuid, p_league_season_id uuid, p_member_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_kind text; v_message text;
BEGIN
  PERFORM private.lock_roster_scope(p_league_id, ARRAY[p_member_id], '{}');
  SELECT problem.kind,string_agg(problem.message,' ' ORDER BY problem.player_name,problem.roster_player_id)
    INTO v_kind,v_message FROM private.roster_problems(p_league_id,p_league_season_id,p_member_id) problem
    GROUP BY problem.kind ORDER BY CASE problem.kind WHEN 'ir' THEN 1 WHEN 'taxi' THEN 2 ELSE 3 END LIMIT 1;
  IF v_kind IS NOT NULL THEN
    RAISE EXCEPTION '%' ,v_message USING ERRCODE=CASE v_kind WHEN 'ir' THEN 'PA005' WHEN 'taxi' THEN 'PA009' ELSE 'PA003' END;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_roster_within_active_limit(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM private.lock_roster_scope(p_league_id, ARRAY[p_member_id], '{}');

  PERFORM 1
    FROM leagues
   WHERE id = p_league_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (SELECT 1 FROM private.roster_problems(p_league_id,p_league_season_id,p_member_id)
    WHERE kind='active_limit') THEN
    RAISE EXCEPTION 'Roster is over the active player limit. Drop or move an eligible player to IR/taxi before editing your lineup.'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.guard_waiver_plan_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_player uuid;
BEGIN
  IF NEW.status<>'pending' THEN RETURN NEW; END IF;
  PERFORM private.lock_roster_scope(NEW.league_id, ARRAY[NEW.member_id], ARRAY[NEW.player_id, NEW.drop_player_id]);
  FOR v_player IN SELECT DISTINCT id FROM unnest(ARRAY[NEW.player_id,NEW.drop_player_id]) id
    WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM private.assert_roster_action_allowed(CASE WHEN v_player=NEW.drop_player_id THEN 'claim_drop' ELSE 'claim_add' END::private.roster_action,
      NEW.league_id, NEW.league_season_id, NEW.member_id, v_player);
  END LOOP;
  RETURN NEW;
END;
$$;

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
  v_rookie_draft_id uuid;
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

  SELECT draft.id INTO v_rookie_draft_id
    FROM drafts AS draft
    JOIN league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
    JOIN leagues AS league ON league.id = draft.league_id AND league.status = 'drafting'
   WHERE draft.league_id = v_target.league_id
     AND draft.draft_type = 'snake' AND NOT draft.is_mock AND draft.status IN ('completed','cancelled')
   ORDER BY draft.created_at DESC LIMIT 1;
  PERFORM private.lock_roster_scope(v_target.league_id, ARRAY[v_target.member_id],
    ARRAY[v_target.player_id, v_free.player_id], v_rookie_draft_id);
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM 1 FROM drafts WHERE id = v_rookie_draft_id FOR UPDATE;
  END IF;
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

CREATE OR REPLACE FUNCTION private.make_snake_pick_atomic_internal(
  p_draft_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_allow_expired_timer boolean DEFAULT false,
  p_to_taxi boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_league_id uuid;
  v_next_pick snake_draft_picks%ROWTYPE;
  v_on_roster_id uuid;
  v_already_picked_id uuid;
  v_now timestamptz;
  v_remaining int;
  v_completed boolean := false;
  v_activated boolean := false;
  v_completion jsonb;
  v_rows int;
  v_next_timer_expires_at timestamptz;
BEGIN
  SELECT league_id INTO v_league_id FROM drafts WHERE id = p_draft_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM private.lock_roster_scope(v_league_id, '{}', ARRAY[p_player_id], p_draft_id);

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Draft is not in progress' USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_next_pick
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NULL
     AND skipped_at IS NULL
   ORDER BY overall_pick
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No picks remaining - draft may be complete'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_next_pick.member_id <> p_member_id THEN
    RAISE EXCEPTION 'It''s not your pick'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_draft.is_mock AND v_next_pick.draft_pick_id IS NULL THEN
    RAISE EXCEPTION 'Draft slot is missing its draft-pick asset'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM players
   WHERE id = p_player_id
     AND years_exp = 0
     AND nba_draft_number IS NOT NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rookie draft picks must select a rookie-eligible player'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_draft.is_mock THEN
    SELECT id
      INTO v_on_roster_id
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND player_id = p_player_id
     FOR UPDATE;

    IF v_on_roster_id IS NOT NULL THEN
      RAISE EXCEPTION 'Player is already on a roster' USING ERRCODE = '23505';
    END IF;
  END IF;

  SELECT id
    INTO v_already_picked_id
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id = p_player_id
   LIMIT 1;

  IF v_already_picked_id IS NOT NULL THEN
    RAISE EXCEPTION 'Player already picked in this draft'
      USING ERRCODE = '23505';
  END IF;

  v_now := clock_timestamp();
  IF NOT p_allow_expired_timer
     AND v_next_pick.timer_expires_at IS NOT NULL
     AND v_next_pick.timer_expires_at <= v_now THEN
    RAISE EXCEPTION 'Pick timer has expired'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE snake_draft_picks
     SET player_id = p_player_id,
         picked_at = v_now,
         to_taxi = COALESCE(p_to_taxi,false),
         skipped_at = NULL,
         skip_reason = NULL,
         timer_expires_at = NULL
   WHERE id = v_next_pick.id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to record snake draft pick atomically'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_draft.is_mock THEN
    IF p_to_taxi THEN
      PERFORM private.authorize_taxi_acquisition(v_draft.league_id,v_draft.league_season_id,p_member_id,p_player_id,'draft',p_draft_id);
    END IF;
    INSERT INTO roster_players (
      league_id,
      league_season_id,
      member_id,
      player_id,
      is_on_taxi,
      acquired_via
    )
    VALUES (
      v_draft.league_id,
      v_draft.league_season_id,
      p_member_id,
      p_player_id,
      COALESCE(p_to_taxi,false),
      'draft'
    );

    INSERT INTO roster_transactions (
      league_id,
      league_season_id,
      member_id,
      player_id,
      transaction_type,
      acquired_to_taxi,
      occurred_at
    )
    VALUES (
      v_draft.league_id,
      v_draft.league_season_id,
      p_member_id,
      p_player_id,
      'draft_won',
      COALESCE(p_to_taxi,false),
      v_now
    );

    UPDATE draft_picks
       SET is_used = true,
           used_at = v_now,
           rookie_draft_id = p_draft_id
     WHERE id = v_next_pick.draft_pick_id
       AND league_id = v_draft.league_id
       AND current_owner_id = p_member_id
       AND round = v_next_pick.round
       AND is_used = false;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Draft-pick asset is no longer owned by the manager on the clock'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT count(*)
    INTO v_remaining
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  IF v_remaining > 0 THEN
    v_next_timer_expires_at := private.arm_next_snake_pick_timer(
      p_draft_id,
      v_now + make_interval(secs => v_draft.pick_timer_seconds)
    );
  END IF;

  IF v_remaining = 0 THEN
    v_completion := private.complete_rookie_draft_if_ready(p_draft_id, v_now);
    v_completed := COALESCE((v_completion->>'completed')::boolean, false);
    v_activated := COALESCE((v_completion->>'activated')::boolean, false);
  END IF;

  RETURN jsonb_build_object(
    'pick', jsonb_build_object(
      'id', v_next_pick.id,
      'overall_pick', v_next_pick.overall_pick,
      'round', v_next_pick.round,
      'pick_in_round', v_next_pick.pick_in_round,
      'member_id', v_next_pick.member_id,
      'draft_pick_id', v_next_pick.draft_pick_id
    ),
    'player_id', p_player_id,
    'to_taxi', COALESCE(p_to_taxi,false),
    'remaining', v_remaining,
    'completed', v_completed,
    'activated', v_activated,
    'league_id', v_draft.league_id,
    'league_season_id', v_draft.league_season_id,
    'is_mock', v_draft.is_mock,
    'next_timer_expires_at', v_next_timer_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.prevent_locked_lineup_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE row_data public.weekly_lineups%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.leagues WHERE id=OLD.league_id) THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.member_id, OLD.league_id, OLD.league_season_id, OLD.player_id, OLD.game_date, OLD.slot_type)
    IS NOT DISTINCT FROM (NEW.member_id, NEW.league_id, NEW.league_season_id, NEW.player_id, NEW.game_date, NEW.slot_type) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN row_data := NEW; ELSE row_data := OLD; END IF;
  PERFORM private.lock_roster_scope(row_data.league_id, ARRAY[row_data.member_id], '{}');
  PERFORM private.assert_roster_action_allowed('lineup_move', row_data.league_id, row_data.league_season_id, row_data.member_id, row_data.player_id);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.prevent_pending_waiver_claim_with_ineligible_ir()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private AS $$
DECLARE
  v_problem_kind text;
  v_problem_message text;
BEGIN
  IF NEW.status = 'pending'::waiver_claim_status THEN
    PERFORM private.lock_roster_scope(NEW.league_id, ARRAY[NEW.member_id], '{}');
    SELECT problem.kind,string_agg(problem.message,' ' ORDER BY problem.player_name,problem.roster_player_id)
      INTO v_problem_kind,v_problem_message
      FROM private.roster_problems(NEW.league_id,NEW.league_season_id,NEW.member_id) problem
      LEFT JOIN roster_players chosen ON chosen.id=problem.roster_player_id AND chosen.player_id=NEW.drop_player_id
     WHERE chosen.id IS NULL
     GROUP BY problem.kind ORDER BY CASE problem.kind WHEN 'ir' THEN 1 WHEN 'taxi' THEN 2 ELSE 3 END LIMIT 1;
    IF v_problem_kind IS NOT NULL THEN
      RAISE EXCEPTION '%',v_problem_message USING ERRCODE=CASE v_problem_kind WHEN 'ir' THEN 'PA005' WHEN 'taxi' THEN 'PA009' ELSE 'PA003' END;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

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
    PERFORM private.lock_roster_scope(p_league_id, v_members, '{}');
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
          PERFORM private.lock_roster_scope(p_league_id, '{}', ARRAY[v_player.player_id]);
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

CREATE OR REPLACE FUNCTION private.toggle_ir_for_activation(p_roster_player_id uuid, p_to_ir boolean, p_user_id uuid, p_activate_roster_player_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_league_id uuid;
  v_player_id uuid;
  v_member_id uuid;
  v_rookie_draft_id uuid;
  v_injury text;
  v_roster_size int;
  v_ir_slots int;
  v_other_ir_count int;
  v_active_count int;
  v_rows int;
BEGIN
  SELECT league_id, player_id, member_id
    INTO v_league_id, v_player_id, v_member_id
    FROM roster_players
   WHERE id = p_roster_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT draft.id INTO v_rookie_draft_id
    FROM drafts AS draft
    JOIN league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
    JOIN leagues AS league ON league.id = draft.league_id AND league.status = 'drafting'
   WHERE draft.league_id = v_league_id
     AND draft.draft_type = 'snake' AND NOT draft.is_mock AND draft.status IN ('completed','cancelled')
   ORDER BY draft.created_at DESC LIMIT 1;
  PERFORM private.lock_roster_scope(v_league_id, ARRAY[v_member_id], ARRAY[v_player_id], v_rookie_draft_id);
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM 1 FROM drafts WHERE id = v_rookie_draft_id FOR UPDATE;
  END IF;

  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this roster'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status)
     AND NOT (v_league.status = 'offseason'::league_status AND p_to_ir = false) THEN
    RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_rp.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster moves are only allowed for the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  IF private.roster_status_game_started(v_rp.player_id) THEN
    RAISE EXCEPTION 'This player''s game has already started. No roster status changes are allowed for that slate.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_rp.is_on_ir = p_to_ir THEN RETURN; END IF;

  v_roster_size := COALESCE(v_league.roster_size, 20);
  v_ir_slots := COALESCE(v_league.ir_slots, 2);

  IF p_to_ir THEN
    SELECT p.injury_status
      INTO v_injury
      FROM players p
     WHERE p.id = v_rp.player_id;

    IF NOT private.is_ir_designation(v_injury) THEN
      RAISE EXCEPTION 'Only players with Out or IR designations can be placed on IR.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT count(*)
      INTO v_other_ir_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_ir = true
       AND id <> p_roster_player_id
       AND (p_activate_roster_player_id IS NULL OR id <> p_activate_roster_player_id);

    IF v_other_ir_count >= v_ir_slots THEN
      RAISE EXCEPTION 'You only have % IR slot%.', v_ir_slots, CASE WHEN v_ir_slots = 1 THEN '' ELSE 's' END
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT count(*)
      INTO v_active_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_ir = false
       AND is_on_taxi = false
       AND id <> p_roster_player_id;

    IF v_active_count >= v_roster_size THEN
      RAISE EXCEPTION 'Your active roster is full (% players).', v_roster_size
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE roster_players
     SET is_on_ir = p_to_ir,
         is_on_taxi = CASE WHEN p_to_ir THEN false ELSE is_on_taxi END
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to toggle IR status'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.member_id,
    v_rp.player_id,
    CASE WHEN p_to_ir THEN 'ir_designate' ELSE 'ir_return' END
  );
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM private.activate_rookie_draft_league_if_ready(v_rookie_draft_id);
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.add_free_agent_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_player_id uuid,
  p_to_ir boolean DEFAULT false,
  p_to_taxi boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.add_free_agent_atomic', jsonb_build_array(p_member_id, p_league_id, p_player_id, p_to_ir, p_to_taxi), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE
  v_league leagues%ROWTYPE;
  v_season_id uuid;
  v_active_count int;
  v_existing_roster_id uuid;
  v_ir_count int;
  v_injury text;
BEGIN
  IF p_to_ir AND p_to_taxi THEN
    RAISE EXCEPTION 'Choose IR or taxi, not both.' USING ERRCODE='P0001';
  END IF;
  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not add player - you may not have permission for this league.'
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

  PERFORM private.lock_roster_scope(p_league_id, ARRAY[p_member_id], ARRAY[p_player_id]);

  PERFORM private.assert_legal_roster(p_league_id,v_season_id,p_member_id);

  SELECT id
    INTO v_existing_roster_id
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = v_season_id
     AND player_id = p_player_id
   FOR UPDATE;

  IF v_existing_roster_id IS NOT NULL THEN
    RAISE EXCEPTION 'This player is already on a roster.'
      USING ERRCODE = '23505';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
    RAISE EXCEPTION 'Free-agent adds require an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Free-agent adds require the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.assert_free_agent_waiver_cleared(p_league_id, v_season_id, p_player_id);

  PERFORM private.assert_weekly_add_available(p_league_id, v_season_id, p_member_id);

  IF p_to_ir THEN
    IF v_league.status = 'offseason'::league_status THEN
      RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
        USING ERRCODE = 'P0001';
    END IF;
    SELECT injury_status INTO v_injury FROM players WHERE id = p_player_id FOR SHARE;
    IF NOT private.is_ir_designation(v_injury) THEN
      RAISE EXCEPTION 'Only players with Out or IR designations can be placed on IR.'
        USING ERRCODE = 'PA006';
    END IF;
    SELECT count(*) INTO v_ir_count FROM roster_players
     WHERE member_id = p_member_id AND league_season_id = v_season_id AND is_on_ir;
    IF v_ir_count >= COALESCE(v_league.ir_slots, 2) THEN
      RAISE EXCEPTION 'Your IR slots are full (% slots).', COALESCE(v_league.ir_slots, 2)
        USING ERRCODE = 'PA007';
    END IF;
  END IF;

  SELECT count(*)
    INTO v_active_count
    FROM roster_players
   WHERE member_id = p_member_id
     AND league_id = p_league_id
     AND league_season_id = v_season_id
     AND is_on_ir = false
     AND is_on_taxi = false;

  IF NOT COALESCE(p_to_ir, false) AND NOT COALESCE(p_to_taxi, false) AND v_active_count >= COALESCE(v_league.roster_size, 20) THEN
    RAISE EXCEPTION 'Your active roster is full (% players).', COALESCE(v_league.roster_size, 20)
      USING ERRCODE = 'PA003';
  END IF;

  IF p_to_taxi THEN
    PERFORM private.authorize_taxi_acquisition(p_league_id,v_season_id,p_member_id,p_player_id,'free_agent',p_player_id);
  END IF;

  INSERT INTO roster_players (
    member_id,
    league_id,
    league_season_id,
    player_id,
    acquired_via,
    is_on_ir,
    is_on_taxi
  )
  VALUES (
    p_member_id,
    p_league_id,
    v_season_id,
    p_player_id,
    'free_agent',
    COALESCE(p_to_ir, false),
    COALESCE(p_to_taxi, false)
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    acquired_to_taxi
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    p_player_id,
    'fa_add',
    COALESCE(p_to_taxi,false)
  );

  PERFORM private.consume_weekly_add(p_league_id, v_season_id, p_member_id);

  PERFORM private.log_league_activity(
    p_league_id,
    v_season_id,
    'free_agent_added',
    'Free agent added',
    CASE WHEN p_to_taxi THEN 'Player added to taxi.' ELSE NULL END,
    p_member_id,
    p_member_id,
    p_player_id,
    NULL,
    NULL,
    '{}'::jsonb
  );
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
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
      (v_move ? 'designatePlayerId' AND private.roster_status_game_started_live((v_move->>'designatePlayerId')::uuid))
      OR (v_move ? 'activatePlayerId' AND private.roster_status_game_started_live((v_move->>'activatePlayerId')::uuid))
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

CREATE OR REPLACE FUNCTION public.auto_set_lineup_atomic_unchecked(p_member_id uuid, p_league_id uuid, p_league_season_id uuid, p_game_date date, p_assignments jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_player_ids uuid[];
  v_owned_count int;
  v_total_count int;
  v_duplicate_player uuid;
  v_invalid_slot roster_slot_type;
  v_invalid_player text;
  v_invalid_player_slot roster_slot_type;
  v_locked_player text;
  v_slot record;
  v_candidate uuid;
  v_preserve boolean;
  v_projections jsonb;
  v_week_number int;
  v_paths jsonb;
  v_path jsonb;
  v_seen text[];
  v_next record;
  v_repair_players uuid[];
  v_repair_slots text[];
  v_index int;
BEGIN
  PERFORM private.lock_roster_scope(p_league_id, ARRAY[p_member_id], '{}');
  PERFORM pg_advisory_xact_lock(
    hashtext(p_member_id::text),
    hashtext(p_game_date::text)
  );

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Lineups can only be set during an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'p_assignments must be a JSONB array.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_assignments) AS a
     WHERE a->>'player_id' IS NULL
        OR a->>'slot_type' IS NULL
  ) THEN
    RAISE EXCEPTION 'Every lineup assignment must include player_id and slot_type.'
      USING ERRCODE = '22023';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT player_id
    INTO v_duplicate_player
    FROM assignments
   GROUP BY player_id
  HAVING count(*) > 1
   LIMIT 1;

  IF v_duplicate_player IS NOT NULL THEN
    RAISE EXCEPTION 'A player can only appear once in a lineup.'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(DISTINCT (a->>'player_id')::uuid ORDER BY (a->>'player_id')::uuid)
    INTO v_player_ids
    FROM jsonb_array_elements(p_assignments) AS a
   WHERE a->>'player_id' IS NOT NULL;

  v_player_ids := COALESCE(v_player_ids, ARRAY[]::uuid[]);

  IF array_length(v_player_ids, 1) IS NOT NULL THEN
    PERFORM 1
       FROM roster_players
      WHERE member_id = p_member_id
        AND league_id = p_league_id
        AND league_season_id = p_league_season_id
        AND player_id = ANY (v_player_ids)
      FOR SHARE;

    SELECT count(*)
      INTO v_owned_count
      FROM unnest(v_player_ids) AS requested(player_id)
     WHERE EXISTS (
       SELECT 1 FROM roster_players rp
        WHERE rp.member_id = p_member_id
          AND rp.league_id = p_league_id
          AND rp.league_season_id = p_league_season_id
          AND rp.player_id = requested.player_id
     ) OR EXISTS (
       SELECT 1
         FROM weekly_lineups wl
         JOIN jsonb_array_elements(p_assignments) AS a
           ON (a->>'player_id')::uuid = wl.player_id
          AND (a->>'slot_type')::roster_slot_type = wl.slot_type
        WHERE wl.member_id = p_member_id
          AND wl.league_id = p_league_id
          AND wl.league_season_id = p_league_season_id
          AND wl.game_date = p_game_date
          AND wl.player_id = requested.player_id
          AND private.lineup_game_started(wl.player_id, wl.game_date)
     );

    v_total_count := array_length(v_player_ids, 1);
    IF v_owned_count <> v_total_count THEN
      RAISE EXCEPTION 'One or more players in the lineup are no longer on your roster.'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT slot_type
    INTO v_invalid_slot
    FROM assignments
   WHERE slot_type = 'IR'::roster_slot_type
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Use the roster injured reserve action instead of assigning an IR lineup slot.'
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT a.slot_type
    INTO v_invalid_slot
    FROM assignments a
   WHERE a.slot_type <> 'BE'::roster_slot_type
     AND NOT EXISTS (
       SELECT 1
         FROM lineup_slot_templates t
        WHERE t.league_id = p_league_id
          AND t.slot_type = a.slot_type
          AND t.slot_type NOT IN ('BE'::roster_slot_type, 'IR'::roster_slot_type)
     )
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup slot % is not configured for this league.', v_invalid_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT a.slot_type
    INTO v_invalid_slot
    FROM assignments a
   WHERE a.slot_type <> 'BE'::roster_slot_type
   GROUP BY a.slot_type
  HAVING count(*) > (
      SELECT t.slot_count
        FROM lineup_slot_templates t
       WHERE t.league_id = p_league_id
         AND t.slot_type = a.slot_type
   )
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup slot % has too many players.', v_invalid_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT p.display_name, a.slot_type
    INTO v_invalid_player, v_invalid_player_slot
    FROM assignments a
    JOIN roster_players rp
      ON rp.member_id = p_member_id
     AND rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.player_id = a.player_id
    JOIN players p ON p.id = rp.player_id
   WHERE a.slot_type <> 'BE'::roster_slot_type
     AND (rp.is_on_ir OR COALESCE(rp.is_on_taxi, false))
   LIMIT 1;

  IF v_invalid_player IS NOT NULL THEN
    RAISE EXCEPTION 'Activate % before assigning a starter slot.', v_invalid_player
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  ),
  player_slots AS (
    SELECT
      p.display_name,
      a.slot_type,
      CASE
        WHEN cardinality(COALESCE(p.eligible_positions, '{}'::text[])) > 0
          THEN p.eligible_positions
        WHEN p.position IS NOT NULL
          THEN ARRAY[p.position::text]::text[]
        ELSE '{}'::text[]
      END AS eligible_positions,
      public.lineup_slot_allowed_positions(a.slot_type) AS allowed_positions
      FROM assignments a
      JOIN players p ON p.id = a.player_id
     WHERE a.slot_type <> 'BE'::roster_slot_type
  )
  SELECT display_name, slot_type
    INTO v_invalid_player, v_invalid_player_slot
    FROM player_slots
   WHERE NOT (eligible_positions && allowed_positions)
   LIMIT 1;

  IF v_invalid_player IS NOT NULL THEN
    RAISE EXCEPTION '% is not eligible for %.', v_invalid_player, v_invalid_player_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT p.display_name
    INTO v_locked_player
    FROM weekly_lineups wl
    JOIN players p ON p.id = wl.player_id
   WHERE wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND private.lineup_game_started(wl.player_id, wl.game_date)
     AND NOT EXISTS (
       SELECT 1
         FROM assignments a
        WHERE a.player_id = wl.player_id
          AND a.slot_type = wl.slot_type
     )
   LIMIT 1;

  IF v_locked_player IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup changes are locked because %''s game has already started.', v_locked_player
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT p.display_name
    INTO v_locked_player
    FROM assignments a
    JOIN players p ON p.id = a.player_id
    LEFT JOIN weekly_lineups wl
      ON wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND wl.player_id = a.player_id
     AND wl.slot_type = a.slot_type
   WHERE a.slot_type <> 'BE'::roster_slot_type
     AND wl.id IS NULL
     AND private.lineup_game_started(a.player_id, p_game_date)
   LIMIT 1;

  IF v_locked_player IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup changes are locked after %''s game has started.', v_locked_player
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(a), '[]'::jsonb)
    INTO p_assignments
    FROM jsonb_array_elements(p_assignments) a
   WHERE a->>'slot_type' <> 'BE';

  IF EXISTS (
    SELECT 1 FROM lineup_slot_templates t
     WHERE t.league_id = p_league_id AND t.slot_type NOT IN ('BE', 'IR')
       AND t.slot_count > (SELECT count(*) FROM jsonb_array_elements(p_assignments) a
         WHERE a->>'slot_type' = t.slot_type::text)
  ) THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('player_id', projection.player_id,
      'projected', projection.projection_fantasy_points)), '[]'::jsonb)
      INTO v_projections
      FROM public.get_league_projection_rows(
        p_league_id, (SELECT season_year FROM league_seasons WHERE id = p_league_season_id),
        p_game_date, 'today', (SELECT array_agg(player_id) FROM roster_players
          WHERE member_id = p_member_id AND league_id = p_league_id
            AND league_season_id = p_league_season_id AND NOT is_on_ir AND NOT is_on_taxi),
        1000, 0
      ) projection;
    SELECT COALESCE((SELECT week_number FROM season_weeks
      WHERE season_year = (SELECT season_year FROM league_seasons WHERE id = p_league_season_id)
        AND p_game_date BETWEEN week_start AND week_end), 1) INTO v_week_number;

    FOREACH v_preserve IN ARRAY ARRAY[true, false] LOOP
      FOR v_slot IN
        SELECT t.slot_type, sequence.number
          FROM lineup_slot_templates t
          CROSS JOIN LATERAL generate_series(1, t.slot_count) sequence(number)
         WHERE t.league_id = p_league_id AND t.slot_type NOT IN ('BE', 'IR')
         ORDER BY array_position(ARRAY['PG','SG','SF','PF','C','G','F','UTIL'], t.slot_type::text), sequence.number
      LOOP
        IF (SELECT count(*) FROM jsonb_array_elements(p_assignments) a
          WHERE a->>'slot_type' = v_slot.slot_type::text) >= v_slot.number THEN
          CONTINUE;
        END IF;
        WITH stored AS MATERIALIZED (
          SELECT id, player_id FROM weekly_lineups
           WHERE member_id = p_member_id AND league_id = p_league_id
             AND league_season_id = p_league_season_id AND game_date = p_game_date
             AND slot_type = v_slot.slot_type
        )
        SELECT rp.player_id INTO v_candidate
          FROM roster_players rp JOIN players p ON p.id = rp.player_id
          LEFT JOIN stored wl ON wl.player_id = rp.player_id
          LEFT JOIN jsonb_to_recordset(v_projections) projection(player_id uuid, projected numeric)
            ON projection.player_id = rp.player_id
         WHERE rp.member_id = p_member_id AND rp.league_id = p_league_id
           AND rp.league_season_id = p_league_season_id AND NOT rp.is_on_ir AND NOT rp.is_on_taxi
           AND (NOT v_preserve OR wl.id IS NOT NULL)
           AND NOT private.lineup_game_started(rp.player_id, p_game_date)
           AND COALESCE(NULLIF(p.eligible_positions, '{}'::text[]), ARRAY[p.position::text])
             && public.lineup_slot_allowed_positions(v_slot.slot_type)
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_assignments) a
             WHERE (a->>'player_id')::uuid = rp.player_id)
         ORDER BY (wl.id IS NOT NULL) DESC,
           EXISTS (SELECT 1 FROM nba_games g WHERE g.game_date = p_game_date
             AND private.lineup_game_available(g.status, g.game_status_text)
             AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)) DESC,
           COALESCE(projection.projected, 0) DESC, rp.player_id
         LIMIT 1;
        IF v_candidate IS NULL AND NOT v_preserve THEN
          v_seen := ARRAY[v_slot.slot_type::text];
          v_paths := jsonb_build_array(jsonb_build_object('slots', v_seen, 'players', '[]'::jsonb));
          WHILE jsonb_array_length(v_paths) > 0 LOOP
            v_path := v_paths->0;
            v_paths := v_paths - 0;
            SELECT rp.player_id INTO v_candidate
              FROM roster_players rp JOIN players p ON p.id = rp.player_id
              LEFT JOIN jsonb_to_recordset(v_projections) projection(player_id uuid, projected numeric)
                ON projection.player_id = rp.player_id
             WHERE rp.member_id = p_member_id AND rp.league_id = p_league_id
               AND rp.league_season_id = p_league_season_id AND NOT rp.is_on_ir AND NOT rp.is_on_taxi
               AND NOT private.lineup_game_started(rp.player_id, p_game_date)
               AND COALESCE(NULLIF(p.eligible_positions, '{}'::text[]), ARRAY[p.position::text])
                 && public.lineup_slot_allowed_positions((v_path->'slots'->>-1)::roster_slot_type)
               AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_assignments) a
                 WHERE (a->>'player_id')::uuid = rp.player_id)
             ORDER BY EXISTS (SELECT 1 FROM nba_games g WHERE g.game_date = p_game_date
               AND private.lineup_game_available(g.status, g.game_status_text)
               AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)) DESC,
               COALESCE(projection.projected, 0) DESC, rp.player_id
             LIMIT 1;
            IF v_candidate IS NOT NULL THEN
              SELECT ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(v_path->'players')) || v_candidate,
                ARRAY(SELECT value FROM jsonb_array_elements_text(v_path->'slots'))
                INTO v_repair_players, v_repair_slots;
              FOR v_index IN 1..cardinality(v_repair_players) LOOP
                SELECT COALESCE(jsonb_agg(a), '[]'::jsonb) INTO p_assignments
                  FROM jsonb_array_elements(p_assignments) a
                 WHERE (a->>'player_id')::uuid <> v_repair_players[v_index];
                p_assignments := p_assignments || jsonb_build_array(jsonb_build_object(
                  'player_id', v_repair_players[v_index], 'slot_type', v_repair_slots[v_index],
                  'week_number', v_week_number, 'is_auto_set', true));
              END LOOP;
              v_candidate := NULL;
              EXIT;
            END IF;
            FOR v_next IN
              SELECT (a->>'player_id')::uuid AS player_id, a->>'slot_type' AS slot_type
                FROM jsonb_array_elements(p_assignments) a
                JOIN roster_players rp ON rp.player_id = (a->>'player_id')::uuid
                  AND rp.member_id = p_member_id AND rp.league_id = p_league_id
                  AND rp.league_season_id = p_league_season_id AND NOT rp.is_on_ir AND NOT rp.is_on_taxi
                JOIN players p ON p.id = rp.player_id
               WHERE NOT (a->>'slot_type' = ANY(v_seen))
                 AND NOT private.lineup_game_started(p.id, p_game_date)
                 AND COALESCE(NULLIF(p.eligible_positions, '{}'::text[]), ARRAY[p.position::text])
                   && public.lineup_slot_allowed_positions((v_path->'slots'->>-1)::roster_slot_type)
               ORDER BY a->>'slot_type', a->>'player_id'
            LOOP
              IF v_next.slot_type = ANY(v_seen) THEN CONTINUE; END IF;
              v_seen := array_append(v_seen, v_next.slot_type);
              v_paths := v_paths || jsonb_build_array(jsonb_build_object(
                'slots', (v_path->'slots') || to_jsonb(v_next.slot_type),
                'players', (v_path->'players') || to_jsonb(v_next.player_id)));
            END LOOP;
          END LOOP;
        END IF;
        IF v_candidate IS NOT NULL THEN
          p_assignments := p_assignments || jsonb_build_array(jsonb_build_object(
            'player_id', v_candidate, 'slot_type', v_slot.slot_type,
            'week_number', v_week_number, 'is_auto_set', true));
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  PERFORM private.assert_lineup_player_pins(p_league_id, p_league_season_id, p_member_id, p_game_date, p_assignments);

  DELETE FROM weekly_lineups
   WHERE member_id = p_member_id
     AND league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND game_date = p_game_date
     AND NOT private.lineup_game_started(player_id, game_date);

  INSERT INTO weekly_lineups (
    member_id,
    league_id,
    league_season_id,
    player_id,
    week_number,
    game_date,
    slot_type,
    is_auto_set,
    set_at
  )
  SELECT
    p_member_id,
    p_league_id,
    p_league_season_id,
    (a->>'player_id')::uuid,
    COALESCE((a->>'week_number')::int, 1),
    p_game_date,
    (a->>'slot_type')::roster_slot_type,
    COALESCE((a->>'is_auto_set')::boolean, true),
    now()
    FROM jsonb_array_elements(p_assignments) AS a
   WHERE a->>'player_id' IS NOT NULL
     AND a->>'slot_type' IS NOT NULL
     AND (a->>'slot_type')::roster_slot_type <> 'BE'::roster_slot_type
     AND NOT EXISTS (
       SELECT 1 FROM weekly_lineups wl
        WHERE wl.member_id = p_member_id
          AND wl.league_id = p_league_id
          AND wl.league_season_id = p_league_season_id
          AND wl.game_date = p_game_date
          AND wl.player_id = (a->>'player_id')::uuid
     );
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_waiver_claim_atomic(
  p_claim_id uuid,
  p_member_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.cancel_waiver_claim_atomic', jsonb_build_array(p_claim_id, p_member_id, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE
  v_status waiver_claim_status;
  v_rows int;
  v_process_date date;
  v_league_id uuid;
BEGIN
  SELECT league_id INTO v_league_id FROM waiver_claims WHERE id = p_claim_id AND member_id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM private.lock_roster_scope(v_league_id, ARRAY[p_member_id], '{}');

  SELECT claim.status, claim.process_date
    INTO v_status, v_process_date
    FROM waiver_claims AS claim
    JOIN league_members AS member
      ON member.id = claim.member_id
   WHERE claim.id = p_claim_id
     AND claim.member_id = p_member_id
     AND member.user_id = p_user_id
   FOR UPDATE OF claim;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_status <> 'pending'::waiver_claim_status THEN
    RAISE EXCEPTION 'Claim is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF (v_process_date + time '00:00') AT TIME ZONE coalesce((SELECT league.timezone FROM leagues league JOIN waiver_claims claim ON claim.league_id=league.id WHERE claim.id=p_claim_id), 'America/Los_Angeles') <= now() THEN
    RAISE EXCEPTION 'The claim cutoff has passed. Wait for the scheduled result.' USING ERRCODE='P0001';
  END IF;

  UPDATE waiver_claims
     SET status = 'cancelled'::waiver_claim_status,
         processed_at = now()
   WHERE id = p_claim_id
     AND status = 'pending'::waiver_claim_status;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Claim is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_auction_nomination_atomic(
  p_nomination_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nom nominations%ROWTYPE;
  v_draft drafts%ROWTYPE;
  v_budget draft_budgets%ROWTYPE;
  v_roster_size int;
  v_active_roster_count int;
  v_can_sell boolean;
  v_league_id uuid;
  v_bidder_id uuid;
  v_player_id uuid;
BEGIN
  SELECT draft.league_id, nomination.current_bidder_id, nomination.player_id
    INTO v_league_id, v_bidder_id, v_player_id
    FROM nominations AS nomination
    JOIN drafts AS draft ON draft.id = nomination.draft_id
   WHERE nomination.id = p_nomination_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM private.lock_roster_scope(v_league_id, ARRAY[v_bidder_id], ARRAY[v_player_id]);

  SELECT *
    INTO v_nom
    FROM nominations
   WHERE id = p_nomination_id
     AND status = 'open'
     AND countdown_expires_at < clock_timestamp()
   FOR UPDATE;

  IF NOT FOUND
     OR v_nom.current_bidder_id IS DISTINCT FROM v_bidder_id
     OR v_nom.player_id <> v_player_id THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = v_nom.draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;

  IF v_draft.status <> 'in_progress'::draft_status THEN
    RETURN false;
  END IF;

  SELECT COALESCE(roster_size, 20)
    INTO v_roster_size
    FROM leagues
   WHERE id = v_draft.league_id
   FOR UPDATE;

  IF NOT v_draft.is_mock AND EXISTS (
    SELECT 1
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND player_id = v_nom.player_id
  ) THEN
    UPDATE nominations
       SET status = 'no_bid',
           closed_at = clock_timestamp()
     WHERE id = v_nom.id;
  ELSIF v_nom.current_bidder_id IS NOT NULL THEN
    SELECT *
      INTO v_budget
      FROM draft_budgets
     WHERE draft_id = v_nom.draft_id
       AND member_id = v_nom.current_bidder_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Winning bidder budget not found';
    END IF;

    IF v_budget.remaining < v_nom.current_bid_amount THEN
      RAISE EXCEPTION 'Winning bidder no longer has enough remaining budget';
    END IF;

    v_can_sell := true;
    IF NOT v_draft.is_mock THEN
      PERFORM 1
        FROM roster_players
       WHERE league_id = v_draft.league_id
         AND league_season_id = v_draft.league_season_id
         AND member_id = v_nom.current_bidder_id
         AND COALESCE(is_on_ir, false) = false
         AND COALESCE(is_on_taxi, false) = false
       FOR UPDATE;

      SELECT count(*)
        INTO v_active_roster_count
        FROM roster_players
       WHERE league_id = v_draft.league_id
         AND league_season_id = v_draft.league_season_id
         AND member_id = v_nom.current_bidder_id
         AND COALESCE(is_on_ir, false) = false
         AND COALESCE(is_on_taxi, false) = false;

      IF v_nom.current_bid_to_taxi THEN
        v_can_sell := private.can_acquire_draft_taxi(v_draft.league_id,v_draft.league_season_id,v_nom.current_bidder_id,v_nom.player_id);
      ELSIF v_active_roster_count >= v_roster_size THEN
        v_can_sell := false;
      ELSE
        v_can_sell := true;
      END IF;
    END IF;

    IF NOT v_can_sell THEN
      UPDATE nominations
         SET status = 'no_bid',
             closed_at = clock_timestamp()
       WHERE id = v_nom.id;
    ELSE
      UPDATE draft_budgets
         SET remaining = remaining - v_nom.current_bid_amount
       WHERE id = v_budget.id;

      IF NOT v_draft.is_mock THEN
        IF v_nom.current_bid_to_taxi THEN
          PERFORM private.authorize_taxi_acquisition(v_draft.league_id,v_draft.league_season_id,v_nom.current_bidder_id,v_nom.player_id,'draft',v_draft.id);
        END IF;
        INSERT INTO roster_players (
          league_id,
          league_season_id,
          member_id,
          player_id,
          acquired_via,
          is_on_taxi,
          acquisition_cost
        )
        VALUES (
          v_draft.league_id,
          v_draft.league_season_id,
          v_nom.current_bidder_id,
          v_nom.player_id,
          'draft',
          v_nom.current_bid_to_taxi,
          v_nom.current_bid_amount
        );

        INSERT INTO roster_transactions (
          league_id,
          league_season_id,
          member_id,
          player_id,
          transaction_type,
          acquired_to_taxi,
          related_nomination_id
        )
        VALUES (
          v_draft.league_id,
          v_draft.league_season_id,
          v_nom.current_bidder_id,
          v_nom.player_id,
          'draft_won',
          v_nom.current_bid_to_taxi,
          v_nom.id
        );
      END IF;

      UPDATE nominations
         SET status = 'sold',
             winning_member_id = v_nom.current_bidder_id,
             final_price = v_nom.current_bid_amount,
             closed_at = clock_timestamp()
       WHERE id = v_nom.id;
    END IF;
  ELSE
    UPDATE nominations
       SET status = 'no_bid',
           closed_at = clock_timestamp()
     WHERE id = v_nom.id;
  END IF;

  UPDATE drafts
     SET current_nomination_order = current_nomination_order + 1
   WHERE id = v_nom.draft_id;

  IF NOT EXISTS (
    SELECT 1
      FROM league_members lm
      JOIN draft_budgets db
        ON db.draft_id = v_nom.draft_id
       AND db.member_id = lm.id
     WHERE lm.league_id = v_draft.league_id
       AND db.remaining >= 1
       AND (
         v_draft.is_mock
         OR (
           SELECT count(*)
             FROM roster_players rp
            WHERE rp.league_id = v_draft.league_id
              AND rp.league_season_id = v_draft.league_season_id
              AND rp.member_id = lm.id
              AND COALESCE(rp.is_on_ir, false) = false
              AND COALESCE(rp.is_on_taxi, false) = false
         ) < v_roster_size
         OR private.can_acquire_draft_taxi(v_draft.league_id,v_draft.league_season_id,lm.id,NULL,v_draft.id)
       )
  ) THEN
    UPDATE drafts
       SET status = 'completed',
           completed_at = clock_timestamp()
     WHERE id = v_nom.draft_id;

    IF NOT v_draft.is_mock THEN
      UPDATE leagues
         SET status = 'active'
       WHERE id = v_draft.league_id;
    END IF;
  END IF;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_auction_nomination_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_user_id uuid,
  p_countdown_seconds int DEFAULT NULL
)
RETURNS nominations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result public.nominations;
BEGIN
  __request_context := private.request_begin('public.create_auction_nomination_atomic', jsonb_build_array(p_draft_id, p_member_id, p_player_id, p_user_id, p_countdown_seconds), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN jsonb_populate_record(NULL::public.nominations, __request_context->'result'); END IF;
  <<request_write>>
DECLARE
  v_draft drafts%ROWTYPE;
  v_nomination nominations%ROWTYPE;
  v_order_count int;
  v_expected_member_id uuid;
  v_nomination_order int;
  v_countdown_seconds int;
  v_league_id uuid;
BEGIN
  SELECT league_id INTO v_league_id FROM drafts WHERE id = p_draft_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;

  PERFORM private.lock_roster_scope(v_league_id, ARRAY[p_member_id], ARRAY[p_player_id]);

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;

  v_countdown_seconds := COALESCE(p_countdown_seconds, v_draft.pick_timer_seconds, 30);
  IF v_countdown_seconds < 5 OR v_countdown_seconds > 3600 THEN
    RAISE EXCEPTION 'Countdown seconds must be between 5 and 3600';
  END IF;

  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM league_members
     WHERE id = p_member_id
       AND league_id = v_draft.league_id
       AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to act for this member'
      USING ERRCODE = '42501';
  END IF;

  IF v_draft.status <> 'in_progress'::draft_status THEN
    RAISE EXCEPTION 'Draft is not in progress';
  END IF;

  SELECT count(*)
    INTO v_order_count
    FROM draft_orders
   WHERE draft_id = p_draft_id;

  IF v_order_count <= 0 THEN
    RAISE EXCEPTION 'No draft order found';
  END IF;

  SELECT member_id
    INTO v_expected_member_id
    FROM draft_orders
   WHERE draft_id = p_draft_id
     AND position = (((v_draft.current_nomination_order - 1) % v_order_count) + 1);

  IF v_expected_member_id IS DISTINCT FROM p_member_id THEN
    RAISE EXCEPTION 'It is not your turn to nominate';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM nominations
     WHERE draft_id = p_draft_id
       AND status = 'open'::nomination_status
  ) THEN
    RAISE EXCEPTION 'A nomination is already open - wait for it to close';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM nominations
     WHERE draft_id = p_draft_id
       AND player_id = p_player_id
  ) THEN
    RAISE EXCEPTION 'Player already nominated in this draft';
  END IF;

  IF NOT v_draft.is_mock AND EXISTS (
    SELECT 1
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND player_id = p_player_id
  ) THEN
    RAISE EXCEPTION 'Player is already rostered';
  END IF;

  SELECT count(*) + 1
    INTO v_nomination_order
    FROM nominations
   WHERE draft_id = p_draft_id;

  INSERT INTO nominations (
    draft_id,
    nominating_member_id,
    player_id,
    nomination_order,
    status,
    current_bid_amount,
    current_bidder_id,
    countdown_expires_at
  )
  VALUES (
    p_draft_id,
    p_member_id,
    p_player_id,
    v_nomination_order,
    'open',
    0,
    NULL,
    now() + make_interval(secs => v_countdown_seconds)
  )
  RETURNING * INTO v_nomination;

  __request_result := v_nomination; EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_waiver_claim_atomic(
  p_league_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_drop_player_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_bid_amount int DEFAULT 0,
  p_claim_order int DEFAULT NULL,
  p_to_ir boolean DEFAULT false,
  p_to_taxi boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result uuid;
BEGIN
  __request_context := private.request_begin('public.create_waiver_claim_atomic', jsonb_build_array(p_league_id, p_member_id, p_player_id, p_drop_player_id, p_user_id, p_bid_amount, p_claim_order, p_to_ir, p_to_taxi), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::uuid; END IF;
  <<request_write>>
DECLARE
  v_league leagues%ROWTYPE;
  v_season_id uuid;
  v_priority int;
  v_waiver_log waiver_wire_log%ROWTYPE;
  v_claim_id uuid;
  v_drop_failure text;
  v_bid_amount int := COALESCE(p_bid_amount, 0);
  v_claim_order int;
  v_balance int;
  v_run_date date;
  v_run_at timestamptz;
  v_problem_kind text;
  v_problem_message text;
BEGIN
  IF p_to_ir AND p_to_taxi THEN
    RAISE EXCEPTION 'Choose IR or taxi, not both.' USING ERRCODE='P0001';
  END IF;
  IF v_bid_amount < 0 THEN
    RAISE EXCEPTION 'FAAB bid must be a non-negative integer.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND (p_user_id IS NULL OR user_id = p_user_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied'
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

  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_season_id::text));

  SELECT priority
    INTO v_priority
    FROM waiver_priorities
   WHERE member_id = p_member_id
     AND league_season_id = v_season_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No waiver priority found for your team.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.lock_roster_scope(p_league_id, ARRAY[p_member_id], ARRAY[p_player_id, p_drop_player_id]);

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
    RAISE EXCEPTION 'Waiver claims require an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons
   WHERE id = v_season_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT problem.kind,string_agg(problem.message,' ' ORDER BY problem.player_name,problem.roster_player_id)
    INTO v_problem_kind,v_problem_message
    FROM private.roster_problems(p_league_id,v_season_id,p_member_id) problem
    LEFT JOIN roster_players chosen ON chosen.id=problem.roster_player_id AND chosen.player_id=p_drop_player_id
   WHERE chosen.id IS NULL
   GROUP BY problem.kind ORDER BY CASE problem.kind WHEN 'ir' THEN 1 WHEN 'taxi' THEN 2 ELSE 3 END LIMIT 1;
  IF v_problem_kind IS NOT NULL THEN
    RAISE EXCEPTION '%',v_problem_message USING ERRCODE=CASE v_problem_kind WHEN 'ir' THEN 'PA005' WHEN 'taxi' THEN 'PA009' ELSE 'PA003' END;
  END IF;

  PERFORM private.assert_weekly_add_available(p_league_id, v_season_id, p_member_id);

  IF v_league.waiver_mode = 'rolling' THEN
    v_bid_amount := 0;
  ELSE
    v_balance := private.available_faab_balance(p_league_id, v_season_id, p_member_id);
    IF v_bid_amount > v_balance THEN
      RAISE EXCEPTION 'FAAB bid exceeds your available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT *
    INTO v_waiver_log
    FROM waiver_wire_log
   WHERE league_id = p_league_id
     AND league_season_id = v_season_id
     AND player_id = p_player_id
     AND cleared_at IS NULL
   ORDER BY clears_at DESC
   LIMIT 1
   FOR UPDATE;

  IF EXISTS (SELECT 1 FROM roster_players WHERE league_id=p_league_id AND league_season_id=v_season_id AND player_id=p_player_id) THEN
    RAISE EXCEPTION 'This player is already on a roster.' USING ERRCODE = 'P0001';
  END IF;

  IF p_drop_player_id IS NOT NULL THEN
    SELECT validation.failure_reason
      INTO v_drop_failure
      FROM private.validate_waiver_claim_drop_player(
        p_league_id,
        v_season_id,
        p_member_id,
        p_drop_player_id
      ) AS validation;

    IF v_drop_failure IS NOT NULL THEN
      RAISE EXCEPTION '%', v_drop_failure
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  PERFORM private.assert_trade_roster_holds(
    p_league_id,
    v_season_id,
    p_member_id,
    jsonb_build_object(
      'addPlayerId', p_player_id,
      'dropPlayerIds', CASE WHEN p_drop_player_id IS NULL THEN '[]'::jsonb ELSE to_jsonb(ARRAY[p_drop_player_id]) END,
      'toIr', COALESCE(p_to_ir, false),
      'toTaxi', COALESCE(p_to_taxi, false)
    ),
    'add',
    NULL,
    false,
    p_member_id,
    NULL
  );

  IF EXISTS (
    SELECT 1
      FROM waiver_claims
     WHERE member_id = p_member_id
       AND league_season_id = v_season_id
       AND player_id = p_player_id
       AND status = 'pending'
     FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'You already have a pending claim for this player.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(p_claim_order, max(claim_order) + 1, 1)
    INTO v_claim_order
    FROM waiver_claims
   WHERE member_id = p_member_id
     AND league_season_id = v_season_id
     AND status = 'pending';

  v_run_date := (greatest(v_waiver_log.clears_at, now()) AT TIME ZONE coalesce(v_league.timezone, 'America/Los_Angeles'))::date;
  v_run_at := v_run_date::timestamp AT TIME ZONE coalesce(v_league.timezone, 'America/Los_Angeles');
  IF v_run_at <= now() OR v_run_at < v_waiver_log.clears_at THEN
    v_run_date := v_run_date + 1;
  END IF;

  INSERT INTO waiver_claims (
    league_id,
    league_season_id,
    member_id,
    player_id,
    drop_player_id,
    priority_at_submission,
    process_date,
    bid_amount,
    claim_order,
    to_ir,
    to_taxi
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    p_player_id,
    p_drop_player_id,
    v_priority,
    v_run_date,
    v_bid_amount,
    v_claim_order,
    COALESCE(p_to_ir, false),
    COALESCE(p_to_taxi, false)
  )
  RETURNING id INTO v_claim_id;

  __request_result := v_claim_id; EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.drop_player_atomic(p_roster_player_id uuid, p_expected_league_season_id uuid, p_rookie_draft_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.drop_player_atomic', jsonb_build_array(p_roster_player_id, p_expected_league_season_id, p_rookie_draft_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_league_id uuid;
  v_player_id uuid;
  v_member_id uuid;
  v_rows int;
  v_rookie_draft_id uuid;
BEGIN
  SELECT league_id, player_id, member_id
    INTO v_league_id, v_player_id, v_member_id
    FROM roster_players
   WHERE id = p_roster_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT draft.id INTO v_rookie_draft_id
    FROM drafts AS draft
    JOIN league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
    JOIN leagues AS league ON league.id = draft.league_id AND league.status = 'drafting'
   WHERE draft.league_id = v_league_id
     AND draft.draft_type = 'snake' AND NOT draft.is_mock AND draft.status IN ('completed','cancelled')
   ORDER BY draft.created_at DESC LIMIT 1;
  PERFORM private.lock_roster_scope(v_league_id, ARRAY[v_member_id], ARRAY[v_player_id], v_rookie_draft_id);
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM 1 FROM drafts WHERE id = v_rookie_draft_id FOR UPDATE;
  END IF;

  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  IF p_expected_league_season_id IS NOT NULL
     AND v_rp.league_season_id <> p_expected_league_season_id THEN
    RAISE EXCEPTION 'The roster season has changed. Refresh before dropping a player.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
    RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_rp.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster moves are only allowed for the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  IF p_rookie_draft_id IS NOT NULL THEN
    IF p_expected_league_season_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM drafts
       WHERE id = p_rookie_draft_id
         AND league_id = v_rp.league_id
         AND league_season_id = v_rp.league_season_id
         AND draft_type = 'snake' AND NOT is_mock
         AND status IN ('in_progress', 'paused', 'completed', 'cancelled')
    ) THEN
      RAISE EXCEPTION 'The draft has changed. Refresh before trimming the roster.' USING ERRCODE = 'P0001';
    END IF;
    IF v_rp.is_on_ir OR v_rp.is_on_taxi OR (
      SELECT count(*) FROM roster_players
       WHERE league_id = v_rp.league_id AND league_season_id = v_rp.league_season_id
         AND member_id = v_rp.member_id AND NOT is_on_ir AND NOT is_on_taxi
    ) <= v_league.roster_size THEN
      RAISE EXCEPTION 'The active roster no longer needs this drop. Refresh the roster.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  DELETE FROM roster_players
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO waiver_wire_log (
    league_id,
    league_season_id,
    player_id,
    dropped_by_member_id
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.player_id,
    v_rp.member_id
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.member_id,
    v_rp.player_id,
    'fa_drop'
  );
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM private.activate_rookie_draft_league_if_ready(v_rookie_draft_id);
  END IF;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$function$;

CREATE OR REPLACE FUNCTION public.edit_waiver_claim_atomic(
  p_claim_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_drop_player_id uuid DEFAULT NULL,
  p_bid_amount int DEFAULT 0,
  p_claim_order int DEFAULT NULL,
  p_to_ir boolean DEFAULT NULL,
  p_to_taxi boolean DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.edit_waiver_claim_atomic', jsonb_build_array(p_claim_id, p_member_id, p_user_id, p_drop_player_id, p_bid_amount, p_claim_order, p_to_ir, p_to_taxi), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE
  v_claim waiver_claims%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_bid_amount int := COALESCE(p_bid_amount, 0);
  v_balance int;
  v_drop_failure text;
  v_problem_kind text;
  v_problem_message text;
BEGIN
  IF v_bid_amount < 0 THEN
    RAISE EXCEPTION 'FAAB bid must be a non-negative integer.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_claim
    FROM waiver_claims
   WHERE id = p_claim_id
     AND member_id = p_member_id
     AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending waiver claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_claim.league_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_claim.league_season_id::text));

  PERFORM private.lock_roster_scope(v_claim.league_id, ARRAY[p_member_id],
    ARRAY[v_claim.player_id, v_claim.drop_player_id, p_drop_player_id]);

  SELECT *
    INTO v_claim
    FROM waiver_claims
   WHERE id = p_claim_id
     AND member_id = p_member_id
     AND status = 'pending'
   FOR UPDATE;


  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending waiver claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_claim.league_id
     AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_claim.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
    RAISE EXCEPTION 'Waiver claims require an active, playoff, or offseason league.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons
   WHERE id = v_claim.league_season_id
     AND is_current = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT problem.kind,string_agg(problem.message,' ' ORDER BY problem.player_name,problem.roster_player_id)
    INTO v_problem_kind,v_problem_message
    FROM private.roster_problems(v_claim.league_id,v_claim.league_season_id,p_member_id) problem
    LEFT JOIN roster_players chosen ON chosen.id=problem.roster_player_id AND chosen.player_id=p_drop_player_id
   WHERE chosen.id IS NULL
   GROUP BY problem.kind ORDER BY CASE problem.kind WHEN 'ir' THEN 1 WHEN 'taxi' THEN 2 ELSE 3 END LIMIT 1;
  IF v_problem_kind IS NOT NULL THEN
    RAISE EXCEPTION '%',v_problem_message USING ERRCODE=CASE v_problem_kind WHEN 'ir' THEN 'PA005' WHEN 'taxi' THEN 'PA009' ELSE 'PA003' END;
  END IF;

  PERFORM private.assert_weekly_add_available(v_claim.league_id, v_claim.league_season_id, p_member_id);

  IF (v_claim.process_date + time '00:00') AT TIME ZONE coalesce(v_league.timezone, 'America/Los_Angeles') <= now() THEN
    RAISE EXCEPTION 'The claim cutoff has passed. Wait for the scheduled result.' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM roster_players WHERE league_id=v_claim.league_id AND league_season_id=v_claim.league_season_id AND player_id=v_claim.player_id) THEN
    RAISE EXCEPTION 'This player is already on a roster.' USING ERRCODE='P0001';
  END IF;

  IF p_drop_player_id IS NOT NULL AND p_drop_player_id = v_claim.player_id THEN
    RAISE EXCEPTION 'You cannot drop the player you are claiming.'
      USING ERRCODE = '22023';
  END IF;

  IF v_league.waiver_mode = 'rolling' THEN
    v_bid_amount := 0;
  ELSE
    v_balance := private.available_faab_balance(v_claim.league_id, v_claim.league_season_id, p_member_id);
    IF v_bid_amount > v_balance THEN
      RAISE EXCEPTION 'FAAB bid exceeds your available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_drop_player_id IS NOT NULL THEN
    SELECT validation.failure_reason
      INTO v_drop_failure
      FROM private.validate_waiver_claim_drop_player(
        v_claim.league_id,
        v_claim.league_season_id,
        p_member_id,
        p_drop_player_id
      ) AS validation;

    IF v_drop_failure IS NOT NULL THEN
      RAISE EXCEPTION '%', v_drop_failure
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF COALESCE(p_to_ir,v_claim.to_ir) AND COALESCE(p_to_taxi,v_claim.to_taxi) THEN
    RAISE EXCEPTION 'Choose IR or taxi, not both.' USING ERRCODE='P0001';
  END IF;

  PERFORM private.assert_trade_roster_holds(
    v_claim.league_id,
    v_claim.league_season_id,
    p_member_id,
    jsonb_build_object(
      'addPlayerId', v_claim.player_id,
      'dropPlayerIds', CASE WHEN p_drop_player_id IS NULL THEN '[]'::jsonb ELSE to_jsonb(ARRAY[p_drop_player_id]) END,
      'toIr', COALESCE(p_to_ir, v_claim.to_ir),
      'toTaxi', COALESCE(p_to_taxi, v_claim.to_taxi)
    ),
    'add',
    NULL,
    false,
    p_member_id,
    NULL
  );

  UPDATE waiver_claims
     SET to_ir = COALESCE(p_to_ir, to_ir),
         to_taxi = COALESCE(p_to_taxi, to_taxi),
         drop_player_id = p_drop_player_id,
         bid_amount = v_bid_amount,
         claim_order = COALESCE(p_claim_order, claim_order),
         submitted_at = now()
   WHERE id = p_claim_id;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.place_auction_bid_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_nomination_id uuid,
  p_amount int,
  p_user_id uuid,
  p_to_taxi boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.place_auction_bid_atomic', jsonb_build_array(p_draft_id, p_member_id, p_nomination_id, p_amount, p_user_id, p_to_taxi), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE
  v_nom nominations%ROWTYPE;
  v_draft drafts%ROWTYPE;
  v_budget draft_budgets%ROWTYPE;
  v_roster_size int;
  v_active_roster_count int;
  v_next_bid int;
  v_now timestamptz;
  v_can_outbid_exists boolean := true;
  v_league_id uuid;
  v_player_id uuid;
BEGIN
  IF p_amount IS NULL OR p_amount < 1 THEN
    RAISE EXCEPTION 'Bid amount must be a positive integer';
  END IF;

  SELECT draft.league_id, nomination.player_id
    INTO v_league_id, v_player_id
    FROM nominations AS nomination
    JOIN drafts AS draft ON draft.id = nomination.draft_id
   WHERE nomination.id = p_nomination_id
     AND nomination.draft_id = p_draft_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nomination not found';
  END IF;

  PERFORM private.lock_roster_scope(v_league_id, ARRAY[p_member_id], ARRAY[v_player_id]);

  SELECT *
    INTO v_nom
    FROM nominations
   WHERE id = p_nomination_id
     AND draft_id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nomination not found';
  END IF;

  IF v_nom.player_id <> v_player_id THEN
    RAISE EXCEPTION 'Nomination changed; retry the bid.' USING ERRCODE = '40001';
  END IF;

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;

  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM league_members
     WHERE id = p_member_id
       AND league_id = v_draft.league_id
       AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to act for this member'
      USING ERRCODE = '42501';
  END IF;

  IF v_draft.status <> 'in_progress'::draft_status THEN
    RAISE EXCEPTION 'Draft is not in progress';
  END IF;

  IF v_nom.status <> 'open'::nomination_status THEN
    RAISE EXCEPTION 'Bidding is closed for this nomination';
  END IF;

  IF NOT v_draft.is_mock AND EXISTS (
    SELECT 1
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND player_id = v_nom.player_id
  ) THEN
    RAISE EXCEPTION 'Player is already rostered';
  END IF;

  IF p_amount <= v_nom.current_bid_amount THEN
    RAISE EXCEPTION 'Bid must exceed current bid of $%', v_nom.current_bid_amount;
  END IF;

  IF v_nom.current_bidder_id = p_member_id THEN
    RAISE EXCEPTION 'You are already the highest bidder';
  END IF;

  SELECT *
    INTO v_budget
    FROM draft_budgets
   WHERE draft_id = p_draft_id
     AND member_id = p_member_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft budget not found for bidder';
  END IF;

  IF v_budget.remaining < p_amount THEN
    RAISE EXCEPTION 'Insufficient budget (you have $% remaining)', v_budget.remaining;
  END IF;

  IF NOT v_draft.is_mock THEN
    SELECT COALESCE(roster_size, 20)
      INTO v_roster_size
      FROM leagues
     WHERE id = v_draft.league_id
     FOR UPDATE;

    PERFORM 1
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND member_id = p_member_id
       AND COALESCE(is_on_ir, false) = false
       AND COALESCE(is_on_taxi, false) = false
     FOR UPDATE;

    SELECT count(*)
      INTO v_active_roster_count
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND member_id = p_member_id
       AND COALESCE(is_on_ir, false) = false
       AND COALESCE(is_on_taxi, false) = false;

    IF p_to_taxi THEN
      PERFORM private.assert_taxi_acquisition_allowed(v_draft.league_id,v_draft.league_season_id,p_member_id,v_nom.player_id);
    ELSIF v_active_roster_count >= v_roster_size THEN
      RAISE EXCEPTION 'Your active roster is full (%)', v_roster_size;
    END IF;
  END IF;

  v_now := clock_timestamp();
  IF v_nom.countdown_expires_at IS NULL OR v_nom.countdown_expires_at <= v_now THEN
    RAISE EXCEPTION 'Bidding has expired';
  END IF;

  UPDATE nominations
     SET current_bid_amount = p_amount,
         current_bidder_id = p_member_id,
         current_bid_to_taxi = COALESCE(p_to_taxi,false),
         countdown_expires_at = v_now + make_interval(secs => v_draft.pick_timer_seconds)
   WHERE id = p_nomination_id;

  INSERT INTO bids (nomination_id, member_id, amount, to_taxi)
  VALUES (p_nomination_id, p_member_id, p_amount, COALESCE(p_to_taxi,false));

  IF NOT v_draft.is_mock THEN
    v_next_bid := p_amount + 1;
    SELECT EXISTS (
      SELECT 1
        FROM draft_budgets AS budget
        JOIN league_members AS member
          ON member.id = budget.member_id
         AND member.league_id = v_draft.league_id
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS active_count
            FROM roster_players AS rostered
           WHERE rostered.league_id = v_draft.league_id
             AND rostered.league_season_id = v_draft.league_season_id
             AND rostered.member_id = member.id
             AND COALESCE(rostered.is_on_ir, false) = false
             AND COALESCE(rostered.is_on_taxi, false) = false
        ) AS roster
       WHERE budget.draft_id = p_draft_id
         AND budget.member_id <> p_member_id
         AND (roster.active_count < v_roster_size OR private.can_acquire_draft_taxi(v_draft.league_id,v_draft.league_season_id,member.id,v_nom.player_id))
         AND budget.remaining >= v_next_bid
    )
      INTO v_can_outbid_exists;

    IF NOT v_can_outbid_exists THEN
      UPDATE nominations
         SET countdown_expires_at = clock_timestamp() - interval '1 millisecond'
       WHERE id = p_nomination_id
         AND status = 'open'::nomination_status;

      PERFORM public.close_auction_nomination_atomic(p_nomination_id);
    END IF;
  END IF;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.reorder_waiver_claim_atomic(
  p_claim_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_direction text
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result int;
BEGIN
  __request_context := private.request_begin('public.reorder_waiver_claim_atomic', jsonb_build_array(p_claim_id, p_member_id, p_user_id, p_direction), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::int; END IF;
  <<request_write>>
DECLARE
  v_claim waiver_claims%ROWTYPE;
  v_other waiver_claims%ROWTYPE;
  v_waiver_mode text;
BEGIN
  IF p_direction NOT IN ('up', 'down') THEN
    RAISE EXCEPTION 'Direction must be up or down.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_claim
    FROM waiver_claims
   WHERE id = p_claim_id
     AND member_id = p_member_id
     AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending waiver claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_claim.league_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_claim.league_season_id::text));
  PERFORM private.lock_roster_scope(v_claim.league_id, ARRAY[p_member_id], '{}');

  SELECT *
    INTO v_claim
    FROM waiver_claims
   WHERE id = p_claim_id
     AND member_id = p_member_id
     AND status = 'pending'
   FOR UPDATE;


  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending waiver claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF (v_claim.process_date + time '00:00') AT TIME ZONE coalesce((SELECT timezone FROM leagues WHERE id=v_claim.league_id), 'America/Los_Angeles') <= now() THEN
    RAISE EXCEPTION 'The claim cutoff has passed. Wait for the scheduled result.' USING ERRCODE='P0001';
  END IF;

  SELECT waiver_mode INTO v_waiver_mode FROM leagues WHERE id = v_claim.league_id;

  WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY claim_order, submitted_at, id)::int AS position
      FROM waiver_claims
     WHERE member_id = p_member_id
       AND league_season_id = v_claim.league_season_id
       AND status = 'pending'
       AND process_date = v_claim.process_date
       AND (v_waiver_mode = 'rolling' OR bid_amount = v_claim.bid_amount)
  )
  UPDATE waiver_claims AS claim SET claim_order = ordered.position
    FROM ordered WHERE claim.id = ordered.id AND claim.claim_order <> ordered.position;

  SELECT * INTO v_claim FROM waiver_claims WHERE id = p_claim_id;

  IF p_direction = 'up' THEN
    SELECT *
      INTO v_other
      FROM waiver_claims
     WHERE member_id = p_member_id
       AND league_season_id = v_claim.league_season_id
       AND status = 'pending'
       AND process_date = v_claim.process_date
       AND (v_waiver_mode = 'rolling' OR bid_amount = v_claim.bid_amount)
       AND claim_order < v_claim.claim_order
     ORDER BY claim_order DESC, submitted_at DESC
     LIMIT 1
     FOR UPDATE;
  ELSE
    SELECT *
      INTO v_other
      FROM waiver_claims
     WHERE member_id = p_member_id
       AND league_season_id = v_claim.league_season_id
       AND status = 'pending'
       AND process_date = v_claim.process_date
       AND (v_waiver_mode = 'rolling' OR bid_amount = v_claim.bid_amount)
       AND claim_order > v_claim.claim_order
     ORDER BY claim_order ASC, submitted_at ASC
     LIMIT 1
     FOR UPDATE;
  END IF;

  IF FOUND THEN
    UPDATE waiver_claims
       SET claim_order = v_other.claim_order
     WHERE id = v_claim.id;

    UPDATE waiver_claims
       SET claim_order = v_claim.claim_order
     WHERE id = v_other.id;

    __request_result := v_other.claim_order; EXIT request_write;
  END IF;

  __request_result := v_claim.claim_order; EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_lineup_player_pin(p_league_id uuid, p_player_id uuid, p_date date, p_pin text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_member_id uuid;
  v_season_id uuid;
  v_today date;
  v_roster public.roster_players%ROWTYPE;
BEGIN
  SELECT m.id, s.id, (now() AT TIME ZONE COALESCE(l.timezone, 'America/Los_Angeles'))::date
    INTO v_member_id, v_season_id, v_today
    FROM public.league_members m
    JOIN public.leagues l ON l.id = m.league_id AND l.deleted_at IS NULL
    JOIN public.league_seasons s ON s.league_id = l.id AND s.is_current
    WHERE m.league_id = p_league_id AND m.user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.' USING ERRCODE = '42501';
  END IF;
  IF p_date IS NULL OR (p_pin IS NOT NULL AND p_pin NOT IN ('start', 'bench')) THEN
    RAISE EXCEPTION 'Choose Start, Auto, or Bench for a lineup date.' USING ERRCODE = '22023';
  END IF;
  IF p_date < v_today THEN
    RAISE EXCEPTION 'Past lineups cannot be changed.' USING ERRCODE = 'P0001';
  END IF;
  PERFORM private.lock_roster_scope(p_league_id, ARRAY[v_member_id], '{}');
  PERFORM pg_advisory_xact_lock(hashtext(v_member_id::text), hashtext(p_date::text));
  PERFORM public.assert_current_league_season_for_lineup(p_league_id, v_season_id);
  SELECT * INTO v_roster FROM public.roster_players
    WHERE league_id = p_league_id AND league_season_id = v_season_id
      AND member_id = v_member_id AND player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This player is no longer on your roster.' USING ERRCODE = 'P0002';
  END IF;
  IF v_roster.is_on_ir OR v_roster.is_on_taxi THEN
    RAISE EXCEPTION 'Activate this player before setting a lineup pin.' USING ERRCODE = 'P0001';
  END IF;
  IF private.lineup_game_started(p_player_id, p_date) THEN
    RAISE EXCEPTION 'Lineup changes are locked after this player''s game has started.' USING ERRCODE = 'P0001';
  END IF;
  IF p_pin IS NULL THEN
    DELETE FROM public.lineup_player_pins WHERE league_id = p_league_id AND league_season_id = v_season_id
      AND member_id = v_member_id AND player_id = p_player_id AND game_date = p_date;
  ELSE
    INSERT INTO public.lineup_player_pins(league_id, league_season_id, member_id, player_id, game_date, pin)
      VALUES (p_league_id, v_season_id, v_member_id, p_player_id, p_date, p_pin)
      ON CONFLICT (league_id, league_season_id, member_id, player_id, game_date)
      DO UPDATE SET pin = EXCLUDED.pin WHERE lineup_player_pins.pin IS DISTINCT FROM EXCLUDED.pin;
  END IF;
  RETURN jsonb_build_object('playerId', p_player_id, 'date', p_date, 'lineupPin', p_pin);
END;
$$;

CREATE OR REPLACE FUNCTION public.toggle_taxi_atomic(p_roster_player_id uuid, p_to_taxi boolean, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.toggle_taxi_atomic', jsonb_build_array(p_roster_player_id, p_to_taxi, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_league_id uuid;
  v_player_id uuid;
  v_member_id uuid;
  v_rookie_draft_id uuid;
  v_roster_size int;
  v_active_count int;
  v_rows int;
BEGIN
  SELECT league_id, player_id, member_id
    INTO v_league_id, v_player_id, v_member_id
    FROM roster_players
   WHERE id = p_roster_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT draft.id INTO v_rookie_draft_id
    FROM drafts AS draft
    JOIN league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
    JOIN leagues AS league ON league.id = draft.league_id AND league.status = 'drafting'
   WHERE draft.league_id = v_league_id
     AND draft.draft_type = 'snake' AND NOT draft.is_mock AND draft.status IN ('completed','cancelled')
   ORDER BY draft.created_at DESC LIMIT 1;
  PERFORM private.lock_roster_scope(v_league_id, ARRAY[v_member_id], ARRAY[v_player_id], v_rookie_draft_id);
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM 1 FROM drafts WHERE id = v_rookie_draft_id FOR UPDATE;
  END IF;

  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this roster'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status)
    AND NOT (v_league.status='offseason' AND p_to_taxi=false) THEN
    RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_rp.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster moves are only allowed for the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.assert_roster_action_allowed(CASE WHEN p_to_taxi THEN 'to_taxi' ELSE 'from_taxi' END::private.roster_action,
    v_rp.league_id,v_rp.league_season_id,v_rp.member_id,v_rp.player_id);

  IF private.roster_status_game_started(v_rp.player_id) THEN
    RAISE EXCEPTION 'This player''s game has already started. No roster status changes are allowed for that slate.'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT p_to_taxi AND NOT v_rp.is_on_taxi THEN
    EXIT request_write;
  END IF;

  v_roster_size := COALESCE(v_league.roster_size, 20);

  IF p_to_taxi THEN
    RAISE EXCEPTION 'Players enter taxi through a draft, trade, free-agent add or waiver claim.'
      USING ERRCODE = 'P0001';
  ELSE
    SELECT count(*)
      INTO v_active_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_ir = false
       AND is_on_taxi = false
       AND id <> p_roster_player_id;

    IF v_active_count >= v_roster_size THEN
      RAISE EXCEPTION 'Your active roster is full (% players).', v_roster_size
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE roster_players
     SET is_on_taxi = p_to_taxi
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to toggle taxi status'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.member_id,
    v_rp.player_id,
    CASE WHEN p_to_taxi THEN 'taxi_designate' ELSE 'taxi_return' END
  );
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM private.activate_rookie_draft_league_if_ready(v_rookie_draft_id);
  END IF;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION private.lock_roster_scope(uuid, uuid[], uuid[], uuid) FROM PUBLIC, anon, authenticated, service_role;
