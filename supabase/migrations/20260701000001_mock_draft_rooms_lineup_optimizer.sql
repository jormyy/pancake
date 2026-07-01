ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS room_name text,
  ADD COLUMN IF NOT EXISTS created_by_member_id uuid REFERENCES public.league_members(id) ON DELETE SET NULL;

ALTER TABLE public.drafts
  DROP CONSTRAINT IF EXISTS drafts_room_name_not_blank;

ALTER TABLE public.drafts
  ADD CONSTRAINT drafts_room_name_not_blank
  CHECK (room_name IS NULL OR length(btrim(room_name)) BETWEEN 1 AND 80);

CREATE INDEX IF NOT EXISTS idx_drafts_mock_rooms_by_league
  ON public.drafts (league_id, is_mock, status, scheduled_at DESC, created_at DESC)
  WHERE is_mock = true;

CREATE TABLE IF NOT EXISTS public.draft_room_members (
  draft_id uuid NOT NULL REFERENCES public.drafts(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.league_members(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_draft_room_members_member
  ON public.draft_room_members (member_id, joined_at DESC);

ALTER TABLE public.draft_room_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "draft_room_members_select" ON public.draft_room_members;
CREATE POLICY "draft_room_members_select" ON public.draft_room_members
  FOR SELECT TO authenticated
  USING (
    draft_id IN (
      SELECT d.id
        FROM public.drafts AS d
       WHERE d.league_id IN (SELECT private.my_league_ids())
    )
  );

CREATE TABLE IF NOT EXISTS public.lineup_optimizer_settings (
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  league_season_id uuid NOT NULL REFERENCES public.league_seasons(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.league_members(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  enabled_at timestamptz,
  last_optimized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, league_season_id, member_id)
);

DROP TRIGGER IF EXISTS trg_lineup_optimizer_settings_updated_at ON public.lineup_optimizer_settings;
CREATE TRIGGER trg_lineup_optimizer_settings_updated_at
  BEFORE UPDATE ON public.lineup_optimizer_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.lineup_optimizer_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lineup_optimizer_settings_select" ON public.lineup_optimizer_settings;
CREATE POLICY "lineup_optimizer_settings_select" ON public.lineup_optimizer_settings
  FOR SELECT TO authenticated
  USING (
    member_id IN (SELECT private.my_member_ids())
    OR private.is_commissioner(league_id)
  );

DROP POLICY IF EXISTS "lineup_optimizer_settings_insert" ON public.lineup_optimizer_settings;
CREATE POLICY "lineup_optimizer_settings_insert" ON public.lineup_optimizer_settings
  FOR INSERT TO authenticated
  WITH CHECK (
    league_id IN (SELECT private.my_league_ids())
    AND member_id IN (SELECT private.my_member_ids())
  );

DROP POLICY IF EXISTS "lineup_optimizer_settings_update" ON public.lineup_optimizer_settings;
CREATE POLICY "lineup_optimizer_settings_update" ON public.lineup_optimizer_settings
  FOR UPDATE TO authenticated
  USING (member_id IN (SELECT private.my_member_ids()))
  WITH CHECK (
    league_id IN (SELECT private.my_league_ids())
    AND member_id IN (SELECT private.my_member_ids())
  );

CREATE OR REPLACE FUNCTION public.create_mock_draft_room_atomic(
  p_league_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_room_name text DEFAULT NULL,
  p_draft_type text DEFAULT 'auction',
  p_scheduled_at timestamptz DEFAULT NULL,
  p_nomination_order_mode text DEFAULT 'user_nominated',
  p_rounds int DEFAULT 3,
  p_pick_timer_seconds int DEFAULT 30,
  p_budget_per_team int DEFAULT NULL,
  p_timer_expiry_behavior text DEFAULT 'auto_pick'
)
RETURNS public.drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member public.league_members%ROWTYPE;
  v_league public.leagues%ROWTYPE;
  v_season public.league_seasons%ROWTYPE;
  v_draft public.drafts%ROWTYPE;
  v_draft_type text := COALESCE(p_draft_type, 'auction');
  v_room_name text;
  v_budget int;
  v_timer_expiry_behavior text := COALESCE(p_timer_expiry_behavior, 'auto_pick');
BEGIN
  SELECT *
    INTO v_member
    FROM public.league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to create a room for this league member'
      USING ERRCODE = '42501';
  END IF;

  IF v_draft_type NOT IN ('auction', 'snake') THEN
    RAISE EXCEPTION 'Invalid mock draft room type: %', v_draft_type
      USING ERRCODE = 'P0001';
  END IF;

  IF p_pick_timer_seconds IS NULL OR p_pick_timer_seconds < 5 OR p_pick_timer_seconds > 3600 THEN
    RAISE EXCEPTION 'Draft timer seconds must be between 5 and 3600.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_nomination_order_mode NOT IN ('user_nominated', 'by_projection', 'alphabetical') THEN
    RAISE EXCEPTION 'Invalid nomination order mode: %', p_nomination_order_mode
      USING ERRCODE = 'P0001';
  END IF;

  IF v_timer_expiry_behavior NOT IN ('auto_pick', 'skip_pick', 'pause_draft', 'commissioner_pick') THEN
    RAISE EXCEPTION 'Invalid rookie draft timeout behavior: %', v_timer_expiry_behavior
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_league
    FROM public.leagues
   WHERE id = p_league_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT *
    INTO v_season
    FROM public.league_seasons
   WHERE league_id = p_league_id
     AND is_current = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season for this league' USING ERRCODE = 'P0002';
  END IF;

  IF v_draft_type = 'auction' THEN
    v_budget := COALESCE(p_budget_per_team, v_league.auction_budget);
    IF v_budget IS NULL OR v_budget <= 0 THEN
      RAISE EXCEPTION 'Auction budget must be a positive integer before creating a room.'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_rounds IS NULL OR p_rounds < 1 OR p_rounds > 10 THEN
    RAISE EXCEPTION 'Rookie draft rounds must be between 1 and 10.'
      USING ERRCODE = 'P0001';
  END IF;

  v_room_name := NULLIF(btrim(COALESCE(p_room_name, '')), '');
  IF v_room_name IS NULL THEN
    v_room_name := CASE WHEN v_draft_type = 'snake' THEN 'Mock Rookie Draft' ELSE 'Mock Auction' END;
  END IF;

  INSERT INTO public.drafts (
    league_id,
    league_season_id,
    draft_type,
    status,
    budget_per_team,
    scheduled_at,
    room_name,
    created_by_member_id,
    current_nomination_order,
    nomination_order_mode,
    is_mock,
    pick_timer_seconds,
    rounds,
    timer_expiry_behavior
  )
  VALUES (
    p_league_id,
    v_season.id,
    v_draft_type::public.draft_type,
    'pending',
    CASE WHEN v_draft_type = 'auction' THEN v_budget ELSE NULL END,
    COALESCE(p_scheduled_at, now()),
    v_room_name,
    p_member_id,
    1,
    p_nomination_order_mode,
    true,
    p_pick_timer_seconds,
    CASE WHEN v_draft_type = 'snake' THEN p_rounds ELSE NULL END,
    CASE WHEN v_draft_type = 'snake' THEN v_timer_expiry_behavior ELSE 'auction_no_bid' END
  )
  RETURNING * INTO v_draft;

  INSERT INTO public.draft_room_members (draft_id, member_id)
  VALUES (v_draft.id, p_member_id);

  RETURN v_draft;
END;
$$;

CREATE OR REPLACE FUNCTION public.join_mock_draft_room_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft public.drafts%ROWTYPE;
BEGIN
  SELECT *
    INTO v_draft
    FROM public.drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND OR NOT v_draft.is_mock THEN
    RAISE EXCEPTION 'Mock draft room not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.status <> 'pending'::public.draft_status THEN
    RAISE EXCEPTION 'Only scheduled mock draft rooms can be joined'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.league_members AS lm
     WHERE lm.id = p_member_id
       AND lm.league_id = v_draft.league_id
       AND lm.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to join this mock draft room'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.draft_room_members (draft_id, member_id)
  VALUES (p_draft_id, p_member_id)
  ON CONFLICT (draft_id, member_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.leave_mock_draft_room_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft public.drafts%ROWTYPE;
BEGIN
  SELECT *
    INTO v_draft
    FROM public.drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND OR NOT v_draft.is_mock THEN
    RAISE EXCEPTION 'Mock draft room not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.status <> 'pending'::public.draft_status THEN
    RAISE EXCEPTION 'Only scheduled mock draft rooms can be left'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_draft.created_by_member_id = p_member_id THEN
    RAISE EXCEPTION 'Room creators cannot leave their own scheduled room'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.league_members AS lm
     WHERE lm.id = p_member_id
       AND lm.league_id = v_draft.league_id
       AND lm.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to leave this mock draft room'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.draft_room_members
   WHERE draft_id = p_draft_id
     AND member_id = p_member_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_mock_draft_room_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_user_id uuid
)
RETURNS public.drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft public.drafts%ROWTYPE;
  v_league public.leagues%ROWTYPE;
  v_participant_count int;
  v_budget int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT *
    INTO v_draft
    FROM public.drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND OR NOT v_draft.is_mock THEN
    RAISE EXCEPTION 'Mock draft room not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.status <> 'pending'::public.draft_status THEN
    RAISE EXCEPTION 'Only scheduled mock draft rooms can be started'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_draft.created_by_member_id IS DISTINCT FROM p_member_id THEN
    RAISE EXCEPTION 'Only the room creator can start this mock draft room'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.league_members AS lm
     WHERE lm.id = p_member_id
       AND lm.league_id = v_draft.league_id
       AND lm.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to start this mock draft room'
      USING ERRCODE = '42501';
  END IF;

  IF v_draft.scheduled_at IS NOT NULL AND v_draft.scheduled_at > now() THEN
    RAISE EXCEPTION 'This mock draft room is scheduled for a later time'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)
    INTO v_participant_count
    FROM public.draft_room_members
   WHERE draft_id = p_draft_id;

  IF v_participant_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 joined managers to start a mock draft room'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_league
    FROM public.leagues
   WHERE id = v_draft.league_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found' USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM public.draft_orders WHERE draft_id = p_draft_id;
  DELETE FROM public.draft_budgets WHERE draft_id = p_draft_id;
  DELETE FROM public.snake_draft_picks WHERE draft_id = p_draft_id;

  INSERT INTO public.draft_orders (draft_id, member_id, position)
  SELECT p_draft_id, drm.member_id, row_number() OVER (ORDER BY drm.joined_at ASC, drm.member_id ASC)::int
    FROM public.draft_room_members AS drm
   WHERE drm.draft_id = p_draft_id
   ORDER BY drm.joined_at ASC, drm.member_id ASC;

  IF v_draft.draft_type = 'auction'::public.draft_type THEN
    v_budget := COALESCE(v_draft.budget_per_team, v_league.auction_budget);
    IF v_budget IS NULL OR v_budget <= 0 THEN
      RAISE EXCEPTION 'Auction budget must be a positive integer before starting a room.'
        USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.draft_budgets (draft_id, member_id, initial_budget, remaining)
    SELECT p_draft_id, drm.member_id, v_budget, v_budget
      FROM public.draft_room_members AS drm
     WHERE drm.draft_id = p_draft_id
     ORDER BY drm.joined_at ASC, drm.member_id ASC;
  ELSE
    WITH pick_slots AS (
      SELECT
        rounds.round,
        ordered.member_id,
        CASE
          WHEN rounds.round % 2 = 0 THEN v_participant_count - ordered.position + 1
          ELSE ordered.position
        END AS pick_in_round
      FROM generate_series(1, COALESCE(v_draft.rounds, 3)) AS rounds(round)
      CROSS JOIN public.draft_orders AS ordered
     WHERE ordered.draft_id = p_draft_id
    )
    INSERT INTO public.snake_draft_picks (
      draft_id,
      overall_pick,
      round,
      pick_in_round,
      member_id,
      draft_pick_id
    )
    SELECT
      p_draft_id,
      ((round - 1) * v_participant_count) + pick_in_round,
      round,
      pick_in_round,
      member_id,
      NULL
    FROM pick_slots
    ORDER BY round, pick_in_round;

    PERFORM private.arm_next_snake_pick_timer(
      p_draft_id,
      now() + make_interval(secs => COALESCE(v_draft.pick_timer_seconds, 30))
    );
  END IF;

  UPDATE public.drafts
     SET status = 'in_progress',
         started_at = now(),
         completed_at = NULL,
         current_nomination_order = 1,
         paused_at = NULL,
         timer_paused_remaining_seconds = NULL,
         pause_reason = NULL
   WHERE id = p_draft_id
  RETURNING * INTO v_draft;

  RETURN v_draft;
END;
$$;

REVOKE ALL ON FUNCTION public.create_mock_draft_room_atomic(uuid, uuid, uuid, text, text, timestamptz, text, int, int, int, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.join_mock_draft_room_atomic(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leave_mock_draft_room_atomic(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.start_mock_draft_room_atomic(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_mock_draft_room_atomic(uuid, uuid, uuid, text, text, timestamptz, text, int, int, int, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.join_mock_draft_room_atomic(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.leave_mock_draft_room_atomic(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.start_mock_draft_room_atomic(uuid, uuid, uuid) TO service_role;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('nba-lineup-optimizer') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'nba-lineup-optimizer'
    );
    PERFORM cron.schedule(
      'nba-lineup-optimizer',
      '*/10 * * * *',
      $$SELECT public.invoke_edge_function('lineup-optimizer')$$
    );
  END IF;
END
$cron$;
