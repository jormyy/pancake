CREATE TABLE private.request_receipts (
  request_id uuid PRIMARY KEY,
  actor uuid NOT NULL,
  function text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  input_hash text NOT NULL
);
CREATE INDEX request_receipts_created_at_idx ON private.request_receipts(created_at);
ALTER TABLE private.request_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.request_receipts FROM PUBLIC, anon, authenticated, service_role;


CREATE OR REPLACE FUNCTION private.claim_request(p_request_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  saved private.request_receipts%ROWTYPE;
BEGIN
  IF p_request_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'A request ID and actor are required.' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 731));
  SELECT * INTO saved FROM private.request_receipts WHERE request_id = p_request_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF saved.actor IS DISTINCT FROM p_actor
    OR saved.function IS DISTINCT FROM current_setting('pancake.request_function', true)
    OR saved.input_hash IS DISTINCT FROM current_setting('pancake.request_input_hash', true) THEN
    RAISE EXCEPTION 'Request ID already belongs to another action.' USING ERRCODE = '22023';
  END IF;
  RETURN saved.result;
END;
$$;


CREATE OR REPLACE FUNCTION private.request_begin(p_function text, p_arguments jsonb, p_request_id uuid DEFAULT NULL, p_scope text DEFAULT NULL, p_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  headers jsonb := COALESCE(NULLIF(current_setting('request.headers', true), ''), '{}')::jsonb;
  request_id uuid := COALESCE(p_request_id, NULLIF(headers->>'x-request-id', '')::uuid);
  actor uuid := auth.uid();
  saved jsonb;
  input_hash text := md5(p_arguments::text);
BEGIN
  IF request_id IS NULL AND headers ? 'authorization' AND auth.role() = 'authenticated' THEN
    RAISE EXCEPTION 'A client request ID is required.' USING ERRCODE = '22023';
  END IF;
  IF current_setting('pancake.request_active', true) = 'true' OR request_id IS NULL THEN RETURN NULL; END IF;
  IF actor IS NULL AND (auth.role() = 'service_role' OR session_user IN ('postgres', 'supabase_admin')) THEN
    actor := COALESCE(NULLIF(headers->>'x-request-actor', '')::uuid, p_actor);
  END IF;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'A verified request actor is required.' USING ERRCODE = '42501';
  END IF;
  IF p_scope IS NOT NULL THEN
    request_id := md5(request_id::text || ':' || p_function || ':' || p_scope)::uuid;
  END IF;
  PERFORM set_config('pancake.request_function', p_function, true);
  PERFORM set_config('pancake.request_input_hash', input_hash, true);
  saved := private.claim_request(request_id, actor);
  IF saved IS NOT NULL THEN
    RETURN jsonb_build_object('replay', true, 'result', saved);
  END IF;
  PERFORM set_config('pancake.request_active', 'true', true);
  RETURN jsonb_build_object('replay', false, 'id', request_id, 'actor', actor, 'function', p_function, 'input_hash', input_hash);
END;
$$;


CREATE OR REPLACE FUNCTION private.request_finish(p_context jsonb, p_result jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_context IS NULL THEN RETURN; END IF;
  INSERT INTO private.request_receipts(request_id, actor, function, input_hash, result)
  VALUES ((p_context->>'id')::uuid, (p_context->>'actor')::uuid, p_context->>'function', p_context->>'input_hash', COALESCE(p_result, 'null'::jsonb));
  PERFORM set_config('pancake.request_active', '', true);
END;
$$;


REVOKE ALL ON FUNCTION private.claim_request(uuid, uuid), private.request_begin(text, jsonb, uuid, text, uuid), private.request_finish(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_player_slot_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_player_id uuid,
  p_game_date date,
  p_slot_type roster_slot_type,
  p_week_number int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.set_player_slot_atomic', jsonb_build_array(p_member_id, p_league_id, p_league_season_id, p_player_id, p_game_date, p_slot_type, p_week_number), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
BEGIN
  PERFORM public.set_player_slot_moves_atomic(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_week_number,
    jsonb_build_array(jsonb_build_object(
      'player_id', p_player_id,
      'slot_type', p_slot_type
    ))
  );
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_player_slot_moves_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_week_number int,
  p_moves jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.set_player_slot_moves_atomic', jsonb_build_array(p_member_id, p_league_id, p_league_season_id, p_game_date, p_week_number, p_moves), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
BEGIN
  PERFORM 1 FROM public.league_members
  WHERE id = p_member_id AND league_id = p_league_id AND user_id = auth.uid()
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.' USING ERRCODE = '42501';
  END IF;

  IF p_moves IS NULL OR jsonb_typeof(p_moves) <> 'array' THEN
    RAISE EXCEPTION 'p_moves must be a JSONB array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_moves) > 64 THEN
    RAISE EXCEPTION 'Too many lineup moves.'
      USING ERRCODE = '22023';
  END IF;

  IF p_game_date < (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Past lineups cannot be changed.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.assert_current_league_season_for_lineup(p_league_id, p_league_season_id);
  PERFORM private.assert_roster_within_active_limit(p_league_id, p_league_season_id, p_member_id);
  PERFORM public.set_player_slot_moves_atomic_unchecked(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_week_number,
    p_moves
  );
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_set_lineup_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_assignments jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.auto_set_lineup_atomic', jsonb_build_array(p_member_id, p_league_id, p_league_season_id, p_game_date, p_assignments), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
BEGIN
  PERFORM 1 FROM public.league_members
  WHERE id = p_member_id AND league_id = p_league_id AND user_id = auth.uid()
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.' USING ERRCODE = '42501';
  END IF;

  IF p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'p_assignments must be a JSONB array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_assignments) > 64 THEN
    RAISE EXCEPTION 'Too many lineup assignments.'
      USING ERRCODE = '22023';
  END IF;

  IF p_game_date < (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Past lineups cannot be changed.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.assert_current_league_season_for_lineup(p_league_id, p_league_season_id);
  PERFORM private.assert_roster_within_active_limit(p_league_id, p_league_season_id, p_member_id);
  PERFORM public.auto_set_lineup_atomic_unchecked(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_assignments
  );
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_set_lineup_service_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_assignments jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.auto_set_lineup_service_atomic', jsonb_build_array(p_member_id, p_league_id, p_league_season_id, p_game_date), NULL, p_member_id::text || ':' || p_game_date::text);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE
  v_user_id uuid;
BEGIN
  SELECT user_id
    INTO v_user_id
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League member not found.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_user_id::text, true);
  PERFORM public.auto_set_lineup_atomic(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_assignments
  );
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_lineup_slots_atomic(
  p_league_id uuid,
  p_slots     jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.update_lineup_slots_atomic', jsonb_build_array(p_league_id, p_slots), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
BEGIN
  IF p_slots IS NULL OR jsonb_typeof(p_slots) <> 'array' THEN
    RAISE EXCEPTION 'p_slots must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_slots) > 16 THEN
    RAISE EXCEPTION 'Too many lineup slot entries.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.update_lineup_slots_atomic_unchecked(p_league_id, p_slots);
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
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
  v_lock_player_id uuid;
  v_drop_failure text;
  v_bid_amount int := COALESCE(p_bid_amount, 0);
  v_claim_order int;
  v_balance int;
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

  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));

  FOR v_lock_player_id IN
    SELECT DISTINCT pid
      FROM unnest(ARRAY[p_player_id, p_drop_player_id]::uuid[]) AS t(pid)
     WHERE pid IS NOT NULL
     ORDER BY pid ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_lock_player_id::text));
  END LOOP;

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

  PERFORM private.assert_legal_roster(p_league_id,v_season_id,p_member_id);

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
    (private.next_waiver_run(v_waiver_log.clears_at, now()) AT TIME ZONE 'America/New_York')::date,
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
  v_lock_player_id uuid;
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

  -- Use the roster writers' lock order before any claim or league row lock.
  PERFORM pg_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(p_member_id::text));
  FOR v_lock_player_id IN
    SELECT DISTINCT player_id
      FROM unnest(ARRAY[v_claim.player_id, v_claim.drop_player_id, p_drop_player_id]) AS players(player_id)
     WHERE player_id IS NOT NULL
     ORDER BY player_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_lock_player_id::text));
  END LOOP;

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

  -- Like create_waiver_claim_atomic, edits require eligible league/season state
  -- and add capacity. An uncleared waiver entry stays editable until processing,
  -- even after clears_at; a processed entry no longer accepts edits.
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

  PERFORM private.assert_legal_roster(v_claim.league_id,v_claim.league_season_id,p_member_id);

  PERFORM private.assert_weekly_add_available(v_claim.league_id, v_claim.league_season_id, p_member_id);

  IF (v_claim.process_date + time '03:00') AT TIME ZONE 'America/New_York' <= now() THEN
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
BEGIN
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

  IF (v_process_date + time '03:00') AT TIME ZONE 'America/New_York' <= now() THEN
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

  IF (v_claim.process_date + time '03:00') AT TIME ZONE 'America/New_York' <= now() THEN
    RAISE EXCEPTION 'The claim cutoff has passed. Wait for the scheduled result.' USING ERRCODE='P0001';
  END IF;

  SELECT waiver_mode INTO v_waiver_mode FROM leagues WHERE id = v_claim.league_id;

  -- Older submissions can share an order. Preserve the processor's tie order,
  -- then assign distinct positions so a requested swap always moves one claim.
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

CREATE OR REPLACE FUNCTION public.propose_trade_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_recipient_member_id uuid,
  p_offer_player_ids uuid[],
  p_request_player_ids uuid[],
  p_offer_pick_ids uuid[],
  p_request_pick_ids uuid[],
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_offer_faab_amount int DEFAULT 0,
  p_request_faab_amount int DEFAULT 0
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
  __request_context := private.request_begin('public.propose_trade_atomic', jsonb_build_array(p_league_id, p_league_season_id, p_proposer_member_id, p_recipient_member_id, p_offer_player_ids, p_request_player_ids, p_offer_pick_ids, p_request_pick_ids, p_notes, p_expires_at, p_offer_faab_amount, p_request_faab_amount), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::uuid; END IF;
  <<request_write>>
BEGIN
  __request_result := private.create_trade_offer(
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    p_recipient_member_id,
    p_offer_player_ids,
    p_request_player_ids,
    p_offer_pick_ids,
    p_request_pick_ids,
    p_notes,
    p_expires_at,
    p_offer_faab_amount,
    p_request_faab_amount,
    NULL,
    NULL,
    NULL,
    1
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.propose_multi_team_trade_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_participant_member_ids uuid[],
  p_items jsonb,
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
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
  __request_context := private.request_begin('public.propose_multi_team_trade_atomic', jsonb_build_array(p_league_id, p_league_season_id, p_proposer_member_id, p_participant_member_ids, p_items, p_notes, p_expires_at), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::uuid; END IF;
  <<request_write>>
BEGIN
  __request_result := private.create_multi_team_trade_offer(
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    p_participant_member_ids,
    p_items,
    p_notes,
    p_expires_at
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_trade_offer_atomic(
  p_user_id uuid, p_request_id uuid, p_member_id uuid, p_action text, p_payload jsonb
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  __request_context jsonb;
  __request_result uuid;
BEGIN
  __request_context := private.request_begin('public.submit_trade_offer_atomic', jsonb_build_array(p_user_id, p_request_id, p_member_id, p_action, p_payload - 'estimateId'), p_request_id, NULL, p_user_id);
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::uuid; END IF;
  <<request_write>>
DECLARE
  v_member_league uuid;
  v_multi boolean;
  v_league uuid;
  v_season uuid;
  v_recipient uuid;
  v_source uuid;
  v_notes text;
  v_expiration timestamptz;
  v_offer_players uuid[];
  v_request_players uuid[];
  v_offer_picks uuid[];
  v_request_picks uuid[];
  v_offer_faab int;
  v_request_faab int;
  v_participants uuid[];
  v_items jsonb;
  v_envelope jsonb;
  v_receipt private.trade_offer_requests%ROWTYPE;
  v_inserted int;
  v_result uuid;
BEGIN
  IF p_request_id IS NULL OR p_action IS NULL
    OR p_action NOT IN ('propose','propose-multi','edit','edit-multi','counter','counter-multi')
    OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'A request key, supported offer action, and offer payload are required.' USING ERRCODE='22023';
  END IF;
  SELECT league_id INTO v_member_league FROM league_members
    WHERE id=p_member_id AND user_id=p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.' USING ERRCODE='42501';
  END IF;

  v_multi := p_action LIKE '%-multi';
  v_notes := NULLIF(btrim(p_payload->>'notes'),'');
  v_expiration := (p_payload->>'expiresAt')::timestamptz;
  v_envelope := jsonb_build_object('version',1,'action',p_action,'memberId',p_member_id,
    'notes',v_notes,'expiresAt',v_expiration);
  IF p_payload ? 'rosterPlan' THEN v_envelope := v_envelope||jsonb_build_object('rosterPlan',p_payload->'rosterPlan'); END IF;
  IF p_action IN ('propose','propose-multi') THEN
    v_league := (p_payload->>'leagueId')::uuid;
    v_season := (p_payload->>'leagueSeasonId')::uuid;
    IF v_league IS DISTINCT FROM v_member_league OR v_season IS NULL THEN
      RAISE EXCEPTION 'The offer must use this member''s league and a season.' USING ERRCODE='22023';
    END IF;
    v_envelope := v_envelope||jsonb_build_object('leagueId',v_league,'leagueSeasonId',v_season);
    IF NOT v_multi THEN
      v_recipient := (p_payload->>'recipientMemberId')::uuid;
      v_envelope := v_envelope||jsonb_build_object('recipientMemberId',v_recipient);
    END IF;
  ELSE
    v_source := (p_payload->>'tradeId')::uuid;
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'The source trade is required.' USING ERRCODE='22023';
    END IF;
    v_envelope := v_envelope||jsonb_build_object('tradeId',v_source);
    IF NOT v_multi AND p_payload ? 'recipientMemberId' THEN
      v_recipient := (p_payload->>'recipientMemberId')::uuid;
      v_envelope := v_envelope||jsonb_build_object('recipientMemberId',v_recipient);
    END IF;
  END IF;
  IF v_multi THEN
    v_participants := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'participantMemberIds','[]'::jsonb)))::uuid[];
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'fromMemberId',(item->>'fromMemberId')::uuid,'toMemberId',(item->>'toMemberId')::uuid,
      'playerId',(item->>'playerId')::uuid,'pickId',(item->>'pickId')::uuid,
      'faabAmount',COALESCE((item->>'faabAmount')::int,0)) ORDER BY ordinal),'[]'::jsonb)
      INTO v_items FROM jsonb_array_elements(COALESCE(p_payload->'items','[]'::jsonb)) WITH ORDINALITY AS items(item,ordinal);
    v_envelope := v_envelope||jsonb_build_object('participantMemberIds',v_participants,'items',v_items);
  ELSE
    v_offer_players := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'offerPlayerIds','[]'::jsonb)))::uuid[];
    v_request_players := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'requestPlayerIds','[]'::jsonb)))::uuid[];
    v_offer_picks := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'offerPickIds','[]'::jsonb)))::uuid[];
    v_request_picks := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'requestPickIds','[]'::jsonb)))::uuid[];
    v_offer_faab := COALESCE((p_payload->>'offerFaabAmount')::int,0);
    v_request_faab := COALESCE((p_payload->>'requestFaabAmount')::int,0);
    v_envelope := v_envelope||jsonb_build_object('offerPlayerIds',v_offer_players,'requestPlayerIds',v_request_players,
      'offerPickIds',v_offer_picks,'requestPickIds',v_request_picks,
      'offerFaabAmount',v_offer_faab,'requestFaabAmount',v_request_faab);
  END IF;

  INSERT INTO private.trade_offer_requests(user_id,request_id,member_id,request_payload)
    VALUES(p_user_id,p_request_id,p_member_id,v_envelope) ON CONFLICT(user_id,request_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  -- The separate statement sees a concurrent claim after its transaction commits.
  SELECT * INTO STRICT v_receipt FROM private.trade_offer_requests
    WHERE user_id=p_user_id AND request_id=p_request_id FOR UPDATE;
  IF v_receipt.member_id IS DISTINCT FROM p_member_id OR v_receipt.request_payload IS DISTINCT FROM v_envelope THEN
    RAISE EXCEPTION 'This request key already belongs to different trade terms.' USING ERRCODE='22023';
  END IF;
  IF v_receipt.completed THEN __request_result := v_receipt.result_trade_id; EXIT request_write; END IF;
  IF v_inserted=0 THEN
    RAISE EXCEPTION 'This trade request has no completed receipt.' USING ERRCODE='55000';
  END IF;

  IF p_action='propose' THEN
    v_result := public.propose_trade_atomic(v_league,v_season,p_member_id,v_recipient,
      v_offer_players,v_request_players,v_offer_picks,v_request_picks,v_notes,v_expiration,v_offer_faab,v_request_faab);
  ELSIF p_action='propose-multi' THEN
    v_result := public.propose_multi_team_trade_atomic(v_league,v_season,p_member_id,v_participants,v_items,v_notes,v_expiration);
  ELSIF v_multi THEN
    v_result := private.replace_multi_team_trade_offer(v_source,p_member_id,p_user_id,split_part(p_action,'-',1),
      v_participants,v_items,v_notes,v_expiration);
  ELSE
    IF p_payload ? 'recipientMemberId' AND v_recipient IS DISTINCT FROM (
      SELECT CASE WHEN p_action='counter' THEN proposer_member_id ELSE recipient_member_id END
        FROM public.trades WHERE id=v_source AND league_id=v_member_league
    ) THEN
      RAISE EXCEPTION 'The replacement must keep the original counterparty.' USING ERRCODE='22023';
    END IF;
    v_result := private.replace_trade_offer(v_source,p_member_id,p_user_id,p_action,
      v_offer_players,v_request_players,v_offer_picks,v_request_picks,v_notes,v_expiration,v_offer_faab,v_request_faab);
  END IF;
  IF p_payload ? 'rosterPlan' AND v_result IS NOT NULL THEN
    PERFORM public.set_trade_roster_plan_atomic(v_result,p_member_id,p_user_id,
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'taxiPlayerIds'))::uuid[],
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'irPlayerIds'))::uuid[],
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'dropPlayerIds'))::uuid[],
      COALESCE(p_payload->'rosterPlan'->'rosterMoves','[]'::jsonb));
  END IF;
  IF v_result IS NOT NULL THEN
    PERFORM private.validate_trade_rosters(v_result, p_member_id);
    PERFORM private.attach_trade_estimate(v_result,p_member_id,(p_payload->>'estimateId')::uuid);
  END IF;
  UPDATE private.trade_offer_requests SET completed=true,result_trade_id=v_result
    WHERE user_id=p_user_id AND request_id=p_request_id;
  __request_result := v_result; EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_trade_atomic(
  p_trade_id uuid,
  p_accepting_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.accept_trade_atomic', jsonb_build_array(p_trade_id, p_accepting_member_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
BEGIN
  __request_result := private.accept_trade_participant_atomic(
    p_trade_id,
    p_accepting_member_id
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_trade_with_plan_atomic(
  p_trade_id uuid,p_member_id uuid,p_user_id uuid,
  p_taxi_player_ids uuid[],p_ir_player_ids uuid[],p_drop_player_ids uuid[],p_roster_moves jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.accept_trade_with_plan_atomic', jsonb_build_array(p_trade_id, p_member_id, p_user_id, p_taxi_player_ids, p_ir_player_ids, p_drop_player_ids, p_roster_moves), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
BEGIN
  PERFORM public.set_trade_roster_plan_atomic(p_trade_id,p_member_id,p_user_id,p_taxi_player_ids,p_ir_player_ids,p_drop_player_ids,p_roster_moves);
  __request_result := public.accept_trade_atomic(p_trade_id,p_member_id); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_trade_atomic(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.reject_trade_atomic', jsonb_build_array(p_trade_id, p_member_id, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_trade trades%ROWTYPE;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::public.trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(v_trade.is_multi_team, false) THEN
    IF v_trade.proposer_member_id = p_member_id OR NOT EXISTS (
      SELECT 1
        FROM trade_participants AS participant
       WHERE participant.trade_id = p_trade_id
         AND participant.member_id = p_member_id
         AND participant.accepted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Only a non-proposer trade participant can reject this trade.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_trade.recipient_member_id <> p_member_id THEN
    RAISE EXCEPTION 'Only the trade recipient can reject this trade.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.league_members AS member
   WHERE member.id = p_member_id
     AND member.user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.trades
     SET status = 'rejected'::public.trade_status
   WHERE id = p_trade_id
     AND status = 'pending'::public.trade_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  __request_result := jsonb_build_object(
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.withdraw_trade_atomic(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.withdraw_trade_atomic', jsonb_build_array(p_trade_id, p_member_id, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_trade trades%ROWTYPE;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::public.trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.proposer_member_id <> p_member_id THEN
    RAISE EXCEPTION 'Only the trade proposer can withdraw this trade.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.league_members AS member
   WHERE member.id = p_member_id
     AND member.user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.trades
     SET status = 'withdrawn'::public.trade_status
   WHERE id = p_trade_id
     AND status = 'pending'::public.trade_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  __request_result := jsonb_build_object(
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.veto_trade_atomic(
  p_trade_id uuid,
  p_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.veto_trade_atomic', jsonb_build_array(p_trade_id, p_member_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_trade trades%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_is_commissioner boolean;
  v_is_trade_party boolean;
  v_member_veto_count int;
  v_eligible_count int;
  v_threshold int;
  v_vetoed boolean;
  v_rows int;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'accepted'::trade_status THEN
    RAISE EXCEPTION 'This trade is not in its veto window.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.veto_window_expires_at IS NULL OR v_trade.veto_window_expires_at <= now() THEN
    RAISE EXCEPTION 'The veto window has expired.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_league.trade_veto_mode, 'member_vote') = 'disabled' THEN
    RAISE EXCEPTION 'Trade vetoes are disabled for this league.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_trade.league_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League member not found.'
      USING ERRCODE = 'P0002';
  END IF;

  v_is_commissioner := v_member.role IN ('commissioner'::league_member_role, 'co_commissioner'::league_member_role);
  v_is_trade_party := v_member.id IN (v_trade.proposer_member_id, v_trade.recipient_member_id)
    OR EXISTS (
      SELECT 1
        FROM trade_participants AS participant
       WHERE participant.trade_id = p_trade_id
         AND participant.member_id = v_member.id
    );

  IF v_is_trade_party THEN
    RAISE EXCEPTION 'Trade parties cannot veto their own trade.'
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(v_league.trade_veto_mode, 'member_vote') = 'commissioner' AND NOT v_is_commissioner THEN
    RAISE EXCEPTION 'Only commissioners can veto trades in this league.'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    INSERT INTO trade_vetos (
      trade_id,
      member_id,
      veto_type
    )
    VALUES (
      p_trade_id,
      p_member_id,
      CASE WHEN v_is_commissioner THEN 'commissioner'::veto_type ELSE 'member'::veto_type END
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'You have already vetoed this trade.'
      USING ERRCODE = '23505';
  END;

  SELECT count(*)
    INTO v_member_veto_count
    FROM trade_vetos
   WHERE trade_id = p_trade_id
     AND veto_type = 'member'::veto_type;

  SELECT count(*)
    INTO v_eligible_count
    FROM league_members AS member
   WHERE member.league_id = v_trade.league_id
     AND member.id <> v_trade.proposer_member_id
     AND member.id <> v_trade.recipient_member_id
     AND NOT EXISTS (
       SELECT 1
         FROM trade_participants AS participant
        WHERE participant.trade_id = p_trade_id
          AND participant.member_id = member.id
     );

  v_threshold := GREATEST(1, CEIL(
    COALESCE(v_eligible_count, 0)::numeric *
    COALESCE(v_league.trade_veto_threshold_percent, 50)::numeric / 100
  )::int);

  IF COALESCE(v_league.trade_veto_mode, 'member_vote') = 'commissioner' THEN
    v_vetoed := v_is_commissioner;
  ELSE
    v_vetoed := v_is_commissioner OR COALESCE(v_member_veto_count, 0) >= v_threshold;
  END IF;

  IF v_vetoed THEN
    UPDATE trades
       SET status = 'vetoed'::trade_status,
           vetoed_at = now()
     WHERE id = p_trade_id
       AND status = 'accepted'::trade_status;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Failed to veto trade atomically.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  __request_result := jsonb_build_object(
    'vetoed', v_vetoed,
    'vetoCount', COALESCE(v_member_veto_count, 0),
    'threshold', v_threshold,
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id,
    'participantMemberIds', COALESCE(
      (
        SELECT jsonb_agg(participant.member_id ORDER BY participant.sort_order, participant.member_id)
          FROM trade_participants AS participant
         WHERE participant.trade_id = p_trade_id
      ),
      jsonb_build_array(v_trade.proposer_member_id, v_trade.recipient_member_id)
    )
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_trade_roster_plan_atomic(
  p_trade_id uuid, p_member_id uuid, p_user_id uuid,
  p_taxi_player_ids uuid[], p_ir_player_ids uuid[], p_drop_player_ids uuid[], p_roster_moves jsonb DEFAULT '[]'::jsonb
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.set_trade_roster_plan_atomic', jsonb_build_array(p_trade_id, p_member_id, p_user_id, p_taxi_player_ids, p_ir_player_ids, p_drop_player_ids, p_roster_moves), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE v_trade trades%ROWTYPE; v_member uuid; v_player uuid; v_all uuid[];
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trade not found.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM trade_participants participant JOIN league_members member ON member.id = participant.member_id
    WHERE participant.trade_id = p_trade_id AND member.id = p_member_id AND member.user_id = p_user_id) THEN
    RAISE EXCEPTION 'Only the receiving manager can choose placements and drops.' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_roster_moves) IS DISTINCT FROM 'array' OR jsonb_array_length(p_roster_moves)>100 THEN
    RAISE EXCEPTION 'Roster moves must be an array of at most 100 players.' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_roster_moves) move WHERE jsonb_typeof(move) IS DISTINCT FROM 'object'
    OR move->>'destination' IS NULL OR move->>'destination' NOT IN ('active','ir')
    OR move->>'playerId' IS NULL OR move->>'playerId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'Each roster move requires a player and an active or IR destination. Owned players cannot move back to taxi.' USING ERRCODE='22023';
  END IF;
  v_all := p_taxi_player_ids || p_ir_player_ids || p_drop_player_ids || ARRAY(SELECT (move->>'playerId')::uuid FROM jsonb_array_elements(p_roster_moves) move);
  IF p_taxi_player_ids IS NULL OR p_ir_player_ids IS NULL OR p_drop_player_ids IS NULL
    OR cardinality(v_all) > 100 OR EXISTS (SELECT 1 FROM unnest(v_all) id GROUP BY id HAVING id IS NULL OR count(*) > 1) THEN
    RAISE EXCEPTION 'Placements and drops must be unique players.' USING ERRCODE = '22023';
  END IF;
  FOR v_member IN SELECT member_id FROM trade_participants WHERE trade_id = p_trade_id ORDER BY member_id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_member::text));
  END LOOP;
  FOR v_player IN SELECT DISTINCT id FROM (
    SELECT unnest(v_all) id UNION SELECT player_id FROM trade_items WHERE trade_id = p_trade_id
  ) ids WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_player::text));
  END LOOP;
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id AND status='pending' FOR UPDATE;
  IF NOT FOUND OR v_trade.status <> 'pending' OR v_trade.expires_at <= now() THEN
    RAISE EXCEPTION 'Choose placements and drops while the trade is pending.';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_taxi_player_ids || p_ir_player_ids) choice(player_id) WHERE NOT EXISTS
    (SELECT 1 FROM trade_items WHERE trade_id = p_trade_id AND to_member_id = p_member_id AND player_id = choice.player_id)) THEN
    RAISE EXCEPTION 'Placements must belong to incoming players.';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_drop_player_ids) choice(player_id) WHERE NOT EXISTS
    (SELECT 1 FROM roster_players WHERE league_season_id = v_trade.league_season_id AND member_id = p_member_id AND player_id = choice.player_id)
    OR EXISTS (SELECT 1 FROM trade_items WHERE trade_id = p_trade_id AND player_id = choice.player_id)) THEN
    RAISE EXCEPTION 'Drop choices must be your rostered players outside this offer.';
  END IF;
  IF EXISTS (SELECT 1 FROM roster_players WHERE league_season_id=v_trade.league_season_id AND player_id=ANY(p_ir_player_ids) AND is_on_taxi) THEN
    RAISE EXCEPTION 'Traded taxi players must remain on taxi with their original tenure.' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_roster_moves) move
    WHERE NOT EXISTS (SELECT 1 FROM roster_players roster WHERE roster.league_season_id=v_trade.league_season_id
      AND roster.member_id=p_member_id AND roster.player_id=(move->>'playerId')::uuid)
      OR EXISTS (SELECT 1 FROM trade_items WHERE trade_id=p_trade_id AND player_id=(move->>'playerId')::uuid)) THEN
    RAISE EXCEPTION 'Moves must be retained players from your own roster.' USING ERRCODE='22023';
  END IF;
  UPDATE trade_items item SET to_taxi = item.player_id = ANY(p_taxi_player_ids) OR EXISTS
    (SELECT 1 FROM roster_players WHERE league_season_id = v_trade.league_season_id AND player_id = item.player_id AND is_on_taxi),
    to_ir = item.player_id = ANY(p_ir_player_ids)
  WHERE item.trade_id = p_trade_id AND item.to_member_id = p_member_id AND item.player_id IS NOT NULL;
  UPDATE trade_participants SET drop_player_ids = p_drop_player_ids, roster_moves=p_roster_moves WHERE trade_id = p_trade_id AND member_id = p_member_id;
  IF EXISTS (SELECT 1 FROM trade_participants WHERE trade_id=p_trade_id AND member_id=p_member_id AND accepted_at IS NOT NULL) THEN
    PERFORM private.validate_trade_rosters(p_trade_id, p_member_id);
  END IF;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_trade_taxi_destinations_atomic(p_trade_id uuid,p_member_id uuid,p_player_ids uuid[],p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.set_trade_taxi_destinations_atomic', jsonb_build_array(p_trade_id, p_member_id, p_player_ids, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE v_trade trades%ROWTYPE; v_player_id uuid; v_member_id uuid; v_slots int; v_count int;
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id=p_trade_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trade not found' USING ERRCODE='P0002'; END IF;
  IF NOT EXISTS(SELECT 1 FROM league_members WHERE id=p_member_id AND league_id=v_trade.league_id AND user_id=p_user_id) THEN
    RAISE EXCEPTION 'Not authorized to choose this roster destination.' USING ERRCODE='42501';
  END IF;
  -- Match acceptance and roster mutations: members, players, then the trade.
  FOR v_member_id IN SELECT member_id FROM trade_participants WHERE trade_id=p_trade_id ORDER BY member_id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text),hashtext(v_member_id::text));
  END LOOP;
  FOR v_player_id IN SELECT DISTINCT player_id FROM trade_items WHERE trade_id=p_trade_id AND player_id IS NOT NULL ORDER BY player_id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text),hashtext(v_player_id::text));
  END LOOP;
  SELECT * INTO v_trade FROM trades WHERE id=p_trade_id AND status='pending' FOR UPDATE;
  IF NOT FOUND THEN SELECT * INTO v_trade FROM trades WHERE id=p_trade_id; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trade not found' USING ERRCODE='P0002'; END IF;
  IF v_trade.status<>'pending' OR (v_trade.expires_at IS NOT NULL AND v_trade.expires_at<=now()) THEN
    RAISE EXCEPTION 'Choose roster destinations while the trade offer is pending.' USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM trade_items WHERE trade_id=p_trade_id AND to_member_id=p_member_id) THEN
    RAISE EXCEPTION 'This member receives no assets in this trade.' USING ERRCODE='42501';
  END IF;
  IF p_player_ids IS NULL OR cardinality(p_player_ids)>100 OR EXISTS(SELECT 1 FROM unnest(p_player_ids) p GROUP BY p HAVING p IS NULL OR count(*)>1) THEN
    RAISE EXCEPTION 'Taxi selections must be a unique list of incoming players.' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(p_player_ids) p WHERE NOT EXISTS(SELECT 1 FROM trade_items WHERE trade_id=p_trade_id AND to_member_id=p_member_id AND player_id=p)) THEN
    RAISE EXCEPTION 'Taxi selections must belong to the receiving team.' USING ERRCODE='42501';
  END IF;
  FOR v_player_id IN SELECT p FROM unnest(p_player_ids) p ORDER BY p LOOP
    PERFORM private.assert_taxi_acquisition_allowed(v_trade.league_id,v_trade.league_season_id,p_member_id,v_player_id);
  END LOOP;
  SELECT taxi_slots INTO v_slots FROM leagues WHERE id=v_trade.league_id FOR UPDATE;
  SELECT count(*) INTO v_count FROM roster_players WHERE league_id=v_trade.league_id AND league_season_id=v_trade.league_season_id AND member_id=p_member_id AND is_on_taxi;
  IF v_count+cardinality(p_player_ids)>COALESCE(v_slots,0) THEN
    RAISE EXCEPTION 'The selected players exceed your available taxi slots.' USING ERRCODE='P0001';
  END IF;
  UPDATE trade_items SET to_taxi=player_id=ANY(p_player_ids) WHERE trade_id=p_trade_id AND to_member_id=p_member_id AND player_id IS NOT NULL;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_trade_block_item_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
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
  __request_context := private.request_begin('public.add_trade_block_item_atomic', jsonb_build_array(p_member_id, p_league_id, p_player_id, p_pick_id, p_note, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::uuid; END IF;
  <<request_write>>
DECLARE
  v_season_id uuid;
  v_item_id uuid;
BEGIN
  IF ((p_player_id IS NOT NULL)::int + (p_pick_id IS NOT NULL)::int) <> 1 THEN
    RAISE EXCEPTION 'Trade block item must be exactly one player or pick.'
      USING ERRCODE = '22023';
  END IF;

  IF p_note IS NOT NULL AND length(p_note) > 280 THEN
    RAISE EXCEPTION 'Trade block notes must be 280 characters or fewer.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND (p_user_id IS NULL OR user_id = p_user_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
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

  IF p_player_id IS NOT NULL THEN
    PERFORM 1
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = v_season_id
       AND member_id = p_member_id
       AND player_id = p_player_id
       AND ((is_on_ir = false AND is_on_taxi = false)
         OR EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades))
     FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Only players you own can be listed. This league must permit inactive-player trades for IR or taxi listings.'
        USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO trade_block_items (
      league_id,
      member_id,
      player_id,
      note,
      updated_at
    )
    VALUES (
      p_league_id,
      p_member_id,
      p_player_id,
      NULLIF(BTRIM(COALESCE(p_note, '')), ''),
      now()
    )
    ON CONFLICT (league_id, member_id, player_id) WHERE player_id IS NOT NULL DO UPDATE
       SET note = EXCLUDED.note,
           updated_at = now()
    RETURNING id INTO v_item_id;
  ELSE
    PERFORM 1
      FROM draft_picks
     WHERE id = p_pick_id
       AND league_id = p_league_id
       AND current_owner_id = p_member_id
       AND is_used = false
     FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Only picks you own can be listed on the trade block.'
        USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO trade_block_items (
      league_id,
      member_id,
      pick_id,
      note,
      updated_at
    )
    VALUES (
      p_league_id,
      p_member_id,
      p_pick_id,
      NULLIF(BTRIM(COALESCE(p_note, '')), ''),
      now()
    )
    ON CONFLICT (league_id, member_id, pick_id) WHERE pick_id IS NOT NULL DO UPDATE
       SET note = EXCLUDED.note,
           updated_at = now()
    RETURNING id INTO v_item_id;
  END IF;

  PERFORM private.log_league_activity(
    p_league_id,
    v_season_id,
    'trade_block_updated',
    'Trade block updated',
    NULL,
    p_member_id,
    NULL,
    p_player_id,
    NULL,
    NULL,
    jsonb_build_object('trade_block_item_id', v_item_id, 'pick_id', p_pick_id)
  );

  __request_result := v_item_id; EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_trade_block_item_atomic(
  p_item_id uuid,
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
  __request_context := private.request_begin('public.remove_trade_block_item_atomic', jsonb_build_array(p_item_id, p_member_id, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE
  v_item trade_block_items%ROWTYPE;
  v_season_id uuid;
BEGIN
  SELECT *
    INTO v_item
    FROM trade_block_items
   WHERE id = p_item_id
   FOR UPDATE;

  IF NOT FOUND THEN
    EXIT request_write;
  END IF;

  IF v_item.member_id <> p_member_id THEN
    RAISE EXCEPTION 'Only the listing manager can remove this trade block item.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_item.league_id
     AND (p_user_id IS NULL OR user_id = p_user_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  SELECT id
    INTO v_season_id
    FROM league_seasons
   WHERE league_id = v_item.league_id
     AND is_current = true
   LIMIT 1;

  DELETE FROM trade_block_items
   WHERE id = p_item_id;

  PERFORM private.log_league_activity(
    v_item.league_id,
    v_season_id,
    'trade_block_updated',
    'Trade block updated',
    'An item was removed from the trade block.',
    p_member_id,
    NULL,
    v_item.player_id,
    NULL,
    NULL,
    jsonb_build_object('pick_id', v_item.pick_id)
  );
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.make_snake_pick_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_to_taxi boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.make_snake_pick_atomic', jsonb_build_array(p_draft_id, p_member_id, p_player_id, p_to_taxi), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
BEGIN
  __request_result := private.make_snake_pick_atomic_internal(
    p_draft_id,
    p_member_id,
    p_player_id,
    false,
    p_to_taxi
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.commissioner_snake_pick_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_actor_user_id uuid DEFAULT NULL,
  p_to_taxi boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.commissioner_snake_pick_atomic', jsonb_build_array(p_draft_id, p_member_id, p_player_id, p_actor_user_id, p_to_taxi), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_draft drafts%ROWTYPE;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.draft_type <> 'snake'::draft_type THEN
    RAISE EXCEPTION 'Commissioner pick is only available for snake drafts'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_draft.status <> 'paused'::draft_status
     OR v_draft.timer_expiry_behavior <> 'commissioner_pick'
     OR v_draft.pause_reason IS DISTINCT FROM 'timer_expired_commissioner_pick' THEN
    RAISE EXCEPTION 'Draft is not waiting for a commissioner pick'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE drafts
     SET status = 'in_progress',
         paused_at = NULL,
         timer_paused_remaining_seconds = NULL,
         pause_reason = NULL
   WHERE id = p_draft_id;

  v_result := public.make_snake_pick_atomic(p_draft_id, p_member_id, p_player_id, p_to_taxi);

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'commissioner_pick',
    jsonb_build_object(
      'memberId', p_member_id,
      'playerId', p_player_id,
      'pick', v_result->'pick'
    )
  );

  __request_result := v_result; EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
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
BEGIN
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

  PERFORM pg_advisory_xact_lock(
    hashtext(v_draft.league_id::text),
    hashtext(p_member_id::text)
  );

  PERFORM pg_advisory_xact_lock(
    hashtext(v_draft.league_id::text),
    hashtext(p_player_id::text)
  );

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
BEGIN
  IF p_amount IS NULL OR p_amount < 1 THEN
    RAISE EXCEPTION 'Bid amount must be a positive integer';
  END IF;

  SELECT *
    INTO v_nom
    FROM nominations
   WHERE id = p_nomination_id
     AND draft_id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nomination not found';
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

  PERFORM pg_advisory_xact_lock(
    hashtext(v_draft.league_id::text),
    hashtext(p_member_id::text)
  );

  PERFORM pg_advisory_xact_lock(
    hashtext(v_draft.league_id::text),
    hashtext(v_nom.player_id::text)
  );

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

  -- A manager may spend the whole remaining budget and fill open slots later
  -- through waivers or free agency, so the only bar to outbidding is the next
  -- dollar and room for this player in the active roster or taxi squad.
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

CREATE OR REPLACE FUNCTION public.withdraw_auction_nomination_atomic(
  p_nomination_id uuid,
  p_member_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result boolean;
BEGIN
  __request_context := private.request_begin('public.withdraw_auction_nomination_atomic', jsonb_build_array(p_nomination_id, p_member_id, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::boolean; END IF;
  <<request_write>>
DECLARE
  v_nom   nominations%ROWTYPE;
  v_draft drafts%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM league_members
     WHERE id = p_member_id
       AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to act for this member'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_nom
    FROM nominations
   WHERE id = p_nomination_id
     AND status = 'open'
   FOR UPDATE;
  IF NOT FOUND THEN
    __request_result := false; EXIT request_write;
  END IF;

  SELECT * INTO v_draft FROM drafts WHERE id = v_nom.draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;
  IF v_draft.status <> 'in_progress' THEN
    __request_result := false; EXIT request_write;
  END IF;

  IF v_nom.nominating_member_id <> p_member_id THEN
    RAISE EXCEPTION 'Only the nominator can withdraw this nomination'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_nom.current_bidder_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot withdraw a nomination after a bid has been placed'
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM nominations WHERE id = v_nom.id;

  __request_result := true; EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.toggle_ir_atomic(p_roster_player_id uuid, p_to_ir boolean, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.toggle_ir_atomic', jsonb_build_array(p_roster_player_id, p_to_ir, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
BEGIN
  PERFORM private.toggle_ir_for_activation(p_roster_player_id,p_to_ir,p_user_id,NULL);
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
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
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(v_rookie_draft_id::text), 0);
    PERFORM 1 FROM drafts WHERE id = v_rookie_draft_id FOR UPDATE;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_member_id::text)
  );

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_player_id::text)
  );

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
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.activate_roster_player_with_lineup_atomic', jsonb_build_array(p_activate_roster_player_id, p_activate_source, p_free_roster_player_id, p_free_action, p_member_id, p_league_id, p_league_season_id, p_game_date, p_week_number, p_slot_type), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
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
        PERFORM private.toggle_ir_for_activation(p_free_roster_player_id, true, v_user_id,
          CASE WHEN p_activate_source='ir' THEN p_activate_roster_player_id END);
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
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

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
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.activate_roster_player_with_overflow_atomic', jsonb_build_array(p_activate_roster_player_id, p_activate_source, p_free_roster_player_id, p_free_action), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
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
      PERFORM private.toggle_ir_for_activation(p_free_roster_player_id, true, v_user_id,
          CASE WHEN p_activate_source='ir' THEN p_activate_roster_player_id END);
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
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

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

  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_player_id::text));

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

CREATE OR REPLACE FUNCTION public.drop_and_add_free_agent_atomic(
  p_roster_player_id uuid,
  p_member_id uuid,
  p_league_id uuid,
  p_player_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.drop_and_add_free_agent_atomic', jsonb_build_array(p_roster_player_id, p_member_id, p_league_id, p_player_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
BEGIN
  PERFORM public.drop_player_atomic(p_roster_player_id);
  PERFORM public.add_free_agent_atomic(p_member_id, p_league_id, p_player_id);
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_league_settings_atomic(
  p_league_id uuid,
  p_settings jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.update_league_settings_atomic', jsonb_build_array(p_league_id, p_settings), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE
  v_league public.leagues%ROWTYPE;
  v_user_id uuid := (SELECT auth.uid());
  v_touches_structural boolean;
  v_key text;
  v_skip int[];
  v_current public.league_seasons%ROWTYPE;
  v_scoring_settings jsonb;
  v_roster_size int;
  v_ir_slots int;
  v_taxi_slots int;
  v_auction_budget int;
  v_playoff_start_week int;
  v_playoff_total_weeks int;
  v_playoff_round_weeks int[];
  v_trade_deadline date;
  v_trade_deadline_set boolean := false;
  v_trade_deadline_text text;
  v_season_year int;
  v_weekly_add_limit int;
  v_weekly_add_unlimited boolean;
  v_waiver_mode text;
  v_faab_starting_budget int;
  v_trade_veto_mode text;
  v_trade_veto_window_hours int;
  v_trade_veto_threshold_percent int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION 'p_settings must be a JSON object.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_league
    FROM public.leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT private.is_commissioner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league commissioner can change settings.'
      USING ERRCODE = '42501';
  END IF;

  FOREACH v_key IN ARRAY ARRAY['team_limit','playoff_entrants','taxi_max_seasons'] LOOP
    IF p_settings ? v_key AND (jsonb_typeof(p_settings->v_key)<>'number' OR (p_settings->>v_key)!~'^[0-9]+$') THEN
      RAISE EXCEPTION '% must be a positive whole number.',v_key USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF p_settings ? 'team_limit' AND ((p_settings->>'team_limit')::int < 2 OR
      (p_settings->>'team_limit')::int < (SELECT count(*) FROM public.league_members WHERE league_id=p_league_id)) THEN
    RAISE EXCEPTION 'Team limit must be at least 2 and include every current team.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'playoff_entrants' AND (p_settings->>'playoff_entrants')::int < 2 THEN
    RAISE EXCEPTION 'Playoffs require at least 2 entrants.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'taxi_max_seasons' AND (p_settings->>'taxi_max_seasons')::int NOT BETWEEN 1 AND 2 THEN
    RAISE EXCEPTION 'Taxi tenure must be 1 or 2 seasons.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'allow_inactive_trades' AND jsonb_typeof(p_settings->'allow_inactive_trades')<>'boolean' THEN
    RAISE EXCEPTION 'Allow IR and taxi trades must be true or false.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'playoff_round_lengths' AND (jsonb_typeof(p_settings->'playoff_round_lengths')<>'array'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_settings->'playoff_round_lengths') value
        WHERE jsonb_typeof(value)<>'number' OR value::text!~'^[0-9]+$')) THEN
    RAISE EXCEPTION 'Enter positive whole weeks for each playoff round.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'scoring_settings' AND jsonb_typeof(p_settings -> 'scoring_settings') = 'object' THEN
    v_scoring_settings := p_settings -> 'scoring_settings';
  END IF;

  IF p_settings ? 'roster_size' AND jsonb_typeof(p_settings -> 'roster_size') = 'number' THEN
    v_roster_size := (p_settings ->> 'roster_size')::int;
    IF v_roster_size <= 0 THEN
      RAISE EXCEPTION 'roster_size must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'ir_slots' AND jsonb_typeof(p_settings -> 'ir_slots') = 'number' THEN
    v_ir_slots := (p_settings ->> 'ir_slots')::int;
    IF v_ir_slots < 0 THEN
      RAISE EXCEPTION 'ir_slots must be a non-negative integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'taxi_slots' AND jsonb_typeof(p_settings -> 'taxi_slots') = 'number' THEN
    v_taxi_slots := (p_settings ->> 'taxi_slots')::int;
    IF v_taxi_slots < 0 THEN
      RAISE EXCEPTION 'taxi_slots must be a non-negative integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'auction_budget' AND jsonb_typeof(p_settings -> 'auction_budget') = 'number' THEN
    v_auction_budget := (p_settings ->> 'auction_budget')::int;
    IF v_auction_budget <= 0 THEN
      RAISE EXCEPTION 'auction_budget must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'playoff_start_week' THEN
    IF jsonb_typeof(p_settings -> 'playoff_start_week') <> 'number'
       OR (p_settings ->> 'playoff_start_week') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'Playoff start week must be a positive whole number.' USING ERRCODE = '22023';
    END IF;
    v_playoff_start_week := (p_settings ->> 'playoff_start_week')::int;
    IF v_playoff_start_week <= 0 THEN
      RAISE EXCEPTION 'playoff_start_week must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'playoff_total_weeks' THEN
    IF jsonb_typeof(p_settings -> 'playoff_total_weeks') <> 'number'
       OR (p_settings ->> 'playoff_total_weeks') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'Total playoff weeks must be a positive whole number.' USING ERRCODE = '22023';
    END IF;
    v_playoff_total_weeks := (p_settings ->> 'playoff_total_weeks')::int;
    IF v_playoff_total_weeks < 1 THEN
      RAISE EXCEPTION 'Total playoff weeks must be a positive whole number.' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_settings ? 'playoff_round_weeks' THEN
    IF jsonb_typeof(p_settings -> 'playoff_round_weeks') <> 'array' THEN
      RAISE EXCEPTION 'Enter positive whole weeks for each playoff round.' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_settings -> 'playoff_round_weeks') AS value
      WHERE jsonb_typeof(value) <> 'number' OR value::text !~ '^[0-9]+$') THEN
      RAISE EXCEPTION 'Enter positive whole weeks for each playoff round.' USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(value::text::int ORDER BY ordinality) INTO v_playoff_round_weeks
      FROM jsonb_array_elements(p_settings -> 'playoff_round_weeks') WITH ORDINALITY AS entry(value, ordinality);
    IF v_playoff_round_weeks IS NULL THEN
      RAISE EXCEPTION 'Enter positive whole weeks for each playoff round.' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- The deadline is a month and day ("MM-DD") that repeats every season; a
  -- full date keeps only its month and day. It is stored as the date inside
  -- the league's current season. JSON null removes it.
  IF p_settings ? 'trade_deadline' THEN
    v_trade_deadline_set := true;
    IF jsonb_typeof(p_settings -> 'trade_deadline') = 'string' THEN
      v_trade_deadline_text := trim(p_settings ->> 'trade_deadline');
      BEGIN
        IF v_trade_deadline_text ~ '^[0-9]{1,2}-[0-9]{1,2}$' THEN
          v_trade_deadline := make_date(
            2000,
            split_part(v_trade_deadline_text, '-', 1)::int,
            split_part(v_trade_deadline_text, '-', 2)::int
          );
        ELSE
          v_trade_deadline := v_trade_deadline_text::date;
        END IF;
      EXCEPTION WHEN data_exception THEN
        RAISE EXCEPTION 'trade_deadline must be a month and day such as 02-11.'
          USING ERRCODE = '22023';
      END;

      SELECT season.season_year
        INTO v_season_year
        FROM public.league_seasons AS season
       WHERE season.league_id = p_league_id
         AND season.is_current;
      v_trade_deadline := private.trade_deadline_for_season(
        v_trade_deadline,
        COALESCE(v_season_year, private.setup_season_year_et())
      );
    ELSIF jsonb_typeof(p_settings -> 'trade_deadline') <> 'null' THEN
      RAISE EXCEPTION 'trade_deadline must be a month and day such as 02-11, or null.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'weekly_add_unlimited' THEN
    IF jsonb_typeof(p_settings -> 'weekly_add_unlimited') <> 'boolean' THEN
      RAISE EXCEPTION 'weekly_add_unlimited must be a boolean.'
        USING ERRCODE = '22023';
    END IF;
    v_weekly_add_unlimited := (p_settings ->> 'weekly_add_unlimited')::boolean;
  END IF;

  IF p_settings ? 'weekly_add_limit' AND jsonb_typeof(p_settings -> 'weekly_add_limit') = 'number' THEN
    v_weekly_add_limit := (p_settings ->> 'weekly_add_limit')::int;
    IF v_weekly_add_limit < 1 THEN
      RAISE EXCEPTION 'weekly_add_limit must be at least 1, or use unlimited mode.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'waiver_mode' AND jsonb_typeof(p_settings -> 'waiver_mode') = 'string' THEN
    v_waiver_mode := p_settings ->> 'waiver_mode';
    IF v_waiver_mode NOT IN ('rolling', 'faab') THEN
      RAISE EXCEPTION 'waiver_mode must be rolling or faab.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'faab_starting_budget' AND jsonb_typeof(p_settings -> 'faab_starting_budget') = 'number' THEN
    v_faab_starting_budget := (p_settings ->> 'faab_starting_budget')::int;
    IF v_faab_starting_budget < 0 THEN
      RAISE EXCEPTION 'faab_starting_budget must be a non-negative integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'trade_veto_mode' AND jsonb_typeof(p_settings -> 'trade_veto_mode') = 'string' THEN
    v_trade_veto_mode := p_settings ->> 'trade_veto_mode';
    IF v_trade_veto_mode NOT IN ('disabled', 'commissioner', 'member_vote') THEN
      RAISE EXCEPTION 'trade_veto_mode must be disabled, commissioner, or member_vote.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'trade_veto_window_hours' AND jsonb_typeof(p_settings -> 'trade_veto_window_hours') = 'number' THEN
    v_trade_veto_window_hours := (p_settings ->> 'trade_veto_window_hours')::int;
    IF v_trade_veto_window_hours < 0 OR v_trade_veto_window_hours > 168 THEN
      RAISE EXCEPTION 'trade_veto_window_hours must be between 0 and 168.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'trade_veto_threshold_percent' AND jsonb_typeof(p_settings -> 'trade_veto_threshold_percent') = 'number' THEN
    v_trade_veto_threshold_percent := (p_settings ->> 'trade_veto_threshold_percent')::int;
    IF v_trade_veto_threshold_percent < 1 OR v_trade_veto_threshold_percent > 100 THEN
      RAISE EXCEPTION 'trade_veto_threshold_percent must be between 1 and 100.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  v_touches_structural :=
       v_scoring_settings IS NOT NULL
    OR v_roster_size IS NOT NULL
    OR v_ir_slots IS NOT NULL
    OR v_taxi_slots IS NOT NULL
    OR v_auction_budget IS NOT NULL
    OR p_settings ? 'team_limit';

  IF v_touches_structural
     AND v_league.status IS DISTINCT FROM 'setup'::public.league_status
  THEN
    RAISE EXCEPTION
      'Structural league settings (scoring_settings, roster_size, ir_slots, taxi_slots, auction_budget) can only be changed before the draft starts.'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.leagues
     SET team_limit = CASE WHEN p_settings ? 'team_limit' THEN (p_settings->>'team_limit')::int ELSE team_limit END,
         taxi_rule = 'rookies_or_64_games',
         taxi_max_seasons = CASE WHEN p_settings ? 'taxi_max_seasons' THEN (p_settings->>'taxi_max_seasons')::int ELSE taxi_max_seasons END,
         allow_inactive_trades = CASE WHEN p_settings ? 'allow_inactive_trades' THEN (p_settings->>'allow_inactive_trades')::boolean ELSE allow_inactive_trades END,
         playoff_entrants = CASE WHEN p_settings ? 'playoff_entrants' THEN (p_settings->>'playoff_entrants')::int ELSE playoff_entrants END,
         playoff_round_lengths = CASE WHEN p_settings ? 'playoff_round_lengths' THEN ARRAY(SELECT jsonb_array_elements_text(p_settings->'playoff_round_lengths'))::int[] ELSE playoff_round_lengths END,
         scoring_settings = CASE WHEN v_scoring_settings IS NULL THEN scoring_settings ELSE scoring_settings || v_scoring_settings END,
         roster_size = COALESCE(v_roster_size, roster_size),
         ir_slots = COALESCE(v_ir_slots, ir_slots),
         taxi_slots = COALESCE(v_taxi_slots, taxi_slots),
         auction_budget = COALESCE(v_auction_budget, auction_budget),
         playoff_start_week = COALESCE(v_playoff_start_week, playoff_start_week),
         playoff_total_weeks = COALESCE(v_playoff_total_weeks, playoff_total_weeks),
         playoff_round_weeks = COALESCE(v_playoff_round_weeks, playoff_round_weeks),
         trade_deadline = CASE WHEN v_trade_deadline_set THEN v_trade_deadline ELSE trade_deadline END,
         weekly_add_limit = CASE
           WHEN v_weekly_add_unlimited IS TRUE THEN NULL
           WHEN v_weekly_add_limit IS NOT NULL THEN v_weekly_add_limit
           ELSE weekly_add_limit
         END,
         waiver_mode = COALESCE(v_waiver_mode, waiver_mode),
         faab_starting_budget = COALESCE(v_faab_starting_budget, faab_starting_budget),
         trade_veto_mode = COALESCE(v_trade_veto_mode, trade_veto_mode),
         trade_veto_window_hours = COALESCE(v_trade_veto_window_hours, trade_veto_window_hours),
         trade_veto_threshold_percent = COALESCE(v_trade_veto_threshold_percent, trade_veto_threshold_percent)
   WHERE id = p_league_id;

  IF p_settings ? 'skipped_weeks' THEN
    IF jsonb_typeof(p_settings->'skipped_weeks')<>'array' OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_settings->'skipped_weeks') value
        WHERE jsonb_typeof(value)<>'number' OR value::text!~'^[0-9]+$') THEN
      RAISE EXCEPTION 'Skipped weeks must be positive whole week numbers.' USING ERRCODE='22023';
    END IF;
    SELECT ARRAY(SELECT DISTINCT value::int FROM jsonb_array_elements_text(p_settings->'skipped_weeks') value ORDER BY value::int) INTO v_skip;
    SELECT * INTO v_current FROM public.league_seasons WHERE league_id=p_league_id AND is_current FOR UPDATE;
    PERFORM pg_advisory_xact_lock(hashtext('regular-season-matchups'),hashtext(v_current.id::text));
    PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'),hashtext(v_current.id::text));
    IF NOT v_current.skipped_weeks <@ v_skip THEN
      RAISE EXCEPTION 'Skipped weeks cannot be restored. Contact the commissioner before skipping a week.';
    END IF;
    IF v_skip IS DISTINCT FROM v_current.skipped_weeks THEN
      IF EXISTS (SELECT 1 FROM unnest(v_skip) week WHERE week<1 OR week>=COALESCE(v_playoff_start_week,v_league.playoff_start_week)
        OR NOT EXISTS (SELECT 1 FROM public.season_weeks WHERE season_year=v_current.season_year AND week_number=week)) THEN
        RAISE EXCEPTION 'Only calendar weeks before playoffs can be skipped.' USING ERRCODE='22023';
      END IF;
      IF EXISTS (SELECT 1 FROM public.matchups WHERE league_season_id=v_current.id AND matchup_type<>'regular_season') THEN
        RAISE EXCEPTION 'Weeks cannot be voided after playoff seeds are frozen.';
      END IF;
      UPDATE public.league_seasons SET skipped_weeks=v_skip WHERE id=v_current.id;
      UPDATE public.matchups SET is_voided=true WHERE league_season_id=v_current.id AND week_number=ANY(v_skip);
      IF EXISTS (SELECT 1 FROM public.matchups WHERE league_season_id=v_current.id AND NOT is_voided)
        AND NOT EXISTS (
          SELECT 1 FROM public.matchups m
          LEFT JOIN public.season_weeks w ON w.season_year=v_current.season_year AND w.week_number=m.week_number
          WHERE m.league_season_id=v_current.id AND (
            w.id IS NULL OR w.week_start<=(now() AT TIME ZONE 'America/New_York')::date
            OR m.is_finalized OR m.winner_member_id IS NOT NULL
            OR COALESCE(m.home_points,0)<>0 OR COALESCE(m.away_points,0)<>0)) THEN
        DELETE FROM public.matchups WHERE league_season_id=v_current.id AND matchup_type='regular_season' AND NOT is_voided;
        INSERT INTO public.matchups(league_id,league_season_id,week_number,matchup_type,home_member_id,away_member_id)
          SELECT p_league_id,v_current.id,r.week_number,'regular_season',r.home_member_id,r.away_member_id
          FROM jsonb_to_recordset(private.regular_season_matchup_payload(
            p_league_id,v_current.id,COALESCE(v_playoff_start_week,v_league.playoff_start_week)-1))
          AS r(week_number int,home_member_id uuid,away_member_id uuid);
      END IF;
      PERFORM private.rebuild_regular_standings(p_league_id,v_current.id);
    END IF;
  END IF;

  IF v_faab_starting_budget IS NOT NULL THEN
    UPDATE public.faab_balances AS balance
       SET balance = v_faab_starting_budget,
           updated_at = now()
      FROM public.league_seasons AS season
     WHERE balance.league_id = p_league_id
       AND balance.league_season_id = season.id
       AND season.is_current = true
       AND balance.balance = v_league.faab_starting_budget;
  END IF;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_league_configuration_atomic(
  p_league_id uuid,
  p_settings jsonb,
  p_slots jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.update_league_configuration_atomic', jsonb_build_array(p_league_id, p_settings, p_slots), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
BEGIN
  IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION 'p_settings must be a JSON object.'
      USING ERRCODE = '22023';
  END IF;

  IF p_settings <> '{}'::jsonb THEN
    PERFORM public.update_league_settings_atomic(p_league_id, p_settings);
  END IF;

  IF p_slots IS NOT NULL THEN
    PERFORM public.update_lineup_slots_atomic(p_league_id, p_slots);
  END IF;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.commissioner_adjust_faab_balance_atomic(
  p_league_id uuid,
  p_member_id uuid,
  p_balance int
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
  __request_context := private.request_begin('public.commissioner_adjust_faab_balance_atomic', jsonb_build_array(p_league_id, p_member_id, p_balance), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::int; END IF;
  <<request_write>>
DECLARE
  v_user_id uuid := auth.uid();
  v_season_id uuid;
  v_balance int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  IF p_balance IS NULL OR p_balance < 0 THEN
    RAISE EXCEPTION 'FAAB balance must be a non-negative integer.'
      USING ERRCODE = '22023';
  END IF;

  IF NOT private.is_commissioner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league commissioner can adjust FAAB balances.'
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

  INSERT INTO faab_balances (
    league_id,
    league_season_id,
    member_id,
    balance
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    p_balance
  )
  ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
     SET balance = EXCLUDED.balance,
         updated_at = now()
  RETURNING balance INTO v_balance;

  PERFORM private.log_league_activity(
    p_league_id,
    v_season_id,
    'commissioner_faab_adjusted',
    'FAAB balance adjusted',
    NULL,
    NULL,
    p_member_id,
    NULL,
    NULL,
    NULL,
    jsonb_build_object('balance', v_balance)
  );

  __request_result := v_balance; EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

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
  __request_context jsonb;
  __request_result int;
BEGIN
  __request_context := private.request_begin('public.commissioner_override_weekly_add_count_atomic', jsonb_build_array(p_league_id, p_member_id, p_add_count), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::int; END IF;
  <<request_write>>
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

  __request_result := v_count; EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.notif_publish_announcement_atomic(p_league_id uuid,p_body text,p_request_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  __request_context jsonb;
  __request_result uuid;
BEGIN
  __request_context := private.request_begin('public.notif_publish_announcement_atomic', jsonb_build_array(p_league_id, p_body, p_request_id), p_request_id, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::uuid; END IF;
  <<request_write>>
DECLARE m uuid; saved public.league_announcements%ROWTYPE; body text:=btrim(p_body);
BEGIN
  IF NOT private.is_commissioner(p_league_id) THEN RAISE EXCEPTION 'Commissioner access required' USING ERRCODE='42501'; END IF;
  IF body IS NULL OR length(body) NOT BETWEEN 1 AND 500 OR p_request_id IS NULL THEN RAISE EXCEPTION 'Announcement must contain 1 to 500 characters' USING ERRCODE='22023'; END IF;
  SELECT id INTO m FROM public.league_members WHERE league_id=p_league_id AND user_id=(SELECT auth.uid());
  INSERT INTO public.league_announcements(id,league_id,author_member_id,body) VALUES(p_request_id,p_league_id,m,body) ON CONFLICT(id) DO NOTHING;
  SELECT * INTO saved FROM public.league_announcements WHERE id=p_request_id;
  IF saved.league_id IS DISTINCT FROM p_league_id OR saved.author_member_id IS DISTINCT FROM m OR saved.body IS DISTINCT FROM body THEN RAISE EXCEPTION 'Announcement request already used' USING ERRCODE='23505'; END IF;
  __request_result := saved.id; EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_league(
  p_name           text,
  p_team_name      text,
  p_auction_budget int DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.create_league', jsonb_build_array(p_name, p_team_name, p_auction_budget), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_user_id      uuid := (SELECT auth.uid());
  v_team_name    text := regexp_replace(p_team_name, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v_slug         text;
  v_invite_code  text;
  v_league_id    uuid;
  v_member_id    uuid;
  v_season_id    uuid;
  v_season_year  int;
  v_email_prefix text;
  v_username     text;
  v_counter      int := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_team_name IS NULL OR v_team_name = '' OR char_length(v_team_name) > 40 THEN
    RAISE EXCEPTION 'Team name must contain 1 to 40 characters.';
  END IF;

  IF p_auction_budget IS NULL OR p_auction_budget <= 0 THEN
    RAISE EXCEPTION 'auction_budget must be a positive integer.'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user_id) THEN
    SELECT lower(regexp_replace(split_part(email, '@', 1), '[^a-z0-9_]', '', 'g'))
      INTO v_email_prefix
      FROM auth.users
     WHERE id = v_user_id;

    v_email_prefix := COALESCE(NULLIF(v_email_prefix, ''), 'user');
    IF length(v_email_prefix) < 3 THEN v_email_prefix := 'user'; END IF;
    v_username := v_email_prefix;

    WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = v_username) LOOP
      v_counter := v_counter + 1;
      v_username := v_email_prefix || v_counter::text;
      IF v_counter > 999 THEN EXIT; END IF;
    END LOOP;

    INSERT INTO public.profiles (id, username, display_name)
    VALUES (v_user_id, v_username, v_email_prefix)
    ON CONFLICT (id) DO NOTHING;
  END IF;

  v_season_year := private.setup_season_year_et();
  v_slug := regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g')
            || '-' || substring(gen_random_uuid()::text, 1, 4);
  v_invite_code := public.generate_invite_code();

  INSERT INTO public.leagues (name, slug, invite_code, commissioner_id, auction_budget, playoff_start_week)
  VALUES (trim(p_name), v_slug, v_invite_code, v_user_id, p_auction_budget, 17)
  RETURNING id INTO v_league_id;

  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league_id, v_user_id, 'commissioner', v_team_name)
  RETURNING id INTO v_member_id;

  INSERT INTO public.league_seasons (league_id, season_year, is_current)
  VALUES (v_league_id, v_season_year, true)
  RETURNING id INTO v_season_id;

  -- Waiver claims process only for members with a waiver spot; joiners line
  -- up behind the commissioner.
  INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
  VALUES (v_league_id, v_season_id, v_member_id, 1);

  INSERT INTO public.draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
  SELECT v_league_id, year_value, round_value, v_member_id, v_member_id
    FROM generate_series(v_season_year + 1, v_season_year + 3) AS year_value
   CROSS JOIN generate_series(1, 3) AS round_value;

  __request_result := jsonb_build_object(
    'id',              v_league_id,
    'name',            trim(p_name),
    'slug',            v_slug,
    'invite_code',     v_invite_code,
    'commissioner_id', v_user_id,
    'auction_budget',  p_auction_budget,
    'status',          'setup'
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.join_league_by_invite_code(p_invite_code text, p_team_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.join_league_by_invite_code', jsonb_build_array(p_invite_code, p_team_name), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_league           public.leagues%ROWTYPE;
  v_user_id          uuid := (SELECT auth.uid());
  v_team_name        text := regexp_replace(p_team_name, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v_invite_code      text := upper(trim(coalesce(p_invite_code, '')));
  v_existing         uuid;
  v_member_id        uuid;
  v_member_count     int;
  v_league_season_id uuid;
  v_season_year      int;
  v_priority         int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_team_name IS NULL OR v_team_name = '' OR char_length(v_team_name) > 40 THEN
    RAISE EXCEPTION 'Team name must contain 1 to 40 characters.';
  END IF;

  IF v_invite_code !~ '^[A-Z0-9]{16}$' THEN
    RAISE EXCEPTION 'League not found. Check your invite code.';
  END IF;

  SELECT *
  INTO   v_league
  FROM   public.leagues
  WHERE  invite_code = v_invite_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found. Check your invite code.';
  END IF;

  IF v_league.status IS DISTINCT FROM 'setup'::public.league_status THEN
    RAISE EXCEPTION 'This league is no longer accepting new members.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id
  INTO   v_existing
  FROM   public.league_members
  WHERE  league_id = v_league.id
    AND  user_id   = v_user_id;

  IF FOUND THEN
    RAISE EXCEPTION 'You are already in this league.';
  END IF;

  PERFORM v_existing;

  SELECT count(*)
  INTO   v_member_count
  FROM   public.league_members
  WHERE  league_id = v_league.id;

  IF v_member_count >= v_league.team_limit THEN
    RAISE EXCEPTION 'This league is full.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id, season_year
  INTO   v_league_season_id, v_season_year
  FROM   public.league_seasons
  WHERE  league_id = v_league.id
    AND  is_current = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League has no active season.';
  END IF;

  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league.id, v_user_id, 'manager', v_team_name)
  RETURNING id INTO v_member_id;

  SELECT COALESCE(max(wp.priority), 0) + 1
  INTO   v_priority
  FROM   public.waiver_priorities AS wp
  WHERE  wp.league_id = v_league.id
    AND  wp.league_season_id = v_league_season_id;

  INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
  VALUES (v_league.id, v_league_season_id, v_member_id, v_priority);

  INSERT INTO public.draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
  SELECT v_league.id, year_value, round_value, v_member_id, v_member_id
  FROM generate_series(v_season_year + 1, v_season_year + 3) AS year_value
  CROSS JOIN generate_series(1, 3) AS round_value
  ON CONFLICT (league_id, season_year, round, original_owner_id) DO NOTHING;

  __request_result := jsonb_build_object(
    'id',     v_league.id,
    'name',   v_league.name,
    'status', v_league.status
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$function$;

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
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(v_rookie_draft_id::text), 0);
    PERFORM 1 FROM drafts WHERE id = v_rookie_draft_id FOR UPDATE;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_member_id::text)
  );

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_player_id::text)
  );

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

CREATE OR REPLACE FUNCTION public.auto_pick_snake_pick_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_reason text DEFAULT 'manual',
  p_to_taxi boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.auto_pick_snake_pick_atomic', jsonb_build_array(p_draft_id, p_member_id, p_reason, p_to_taxi));
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_draft drafts%ROWTYPE;
  v_player_id uuid;
  v_result jsonb;
  v_reason text := COALESCE(NULLIF(trim(p_reason), ''), 'manual');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.draft_type <> 'snake'::draft_type THEN
    RAISE EXCEPTION 'Auto-pick is only available for snake drafts'
      USING ERRCODE = 'P0001';
  END IF;

  -- Resume real drafts when the season-start backstop runs.
  IF v_reason = 'season_boundary_backstop' AND NOT v_draft.is_mock AND v_draft.status = 'paused' THEN
    UPDATE drafts SET status = 'in_progress', paused_at = NULL,
      timer_paused_remaining_seconds = NULL, pause_reason = NULL WHERE id = p_draft_id;
  END IF;

  SELECT player.id
    INTO v_player_id
    FROM players AS player
   WHERE player.years_exp = 0
     AND player.nba_draft_number IS NOT NULL
     AND (NOT COALESCE(p_to_taxi,false) OR v_draft.is_mock OR
       private.can_acquire_draft_taxi(v_draft.league_id,v_draft.league_season_id,p_member_id,player.id))
     AND NOT EXISTS (
       SELECT 1
         FROM snake_draft_picks AS picked
        WHERE picked.draft_id = p_draft_id
          AND picked.player_id = player.id
     )
     AND (
       v_draft.is_mock OR NOT EXISTS (
         SELECT 1
           FROM roster_players AS roster
          WHERE roster.league_id = v_draft.league_id
            AND roster.league_season_id = v_draft.league_season_id
            AND roster.player_id = player.id
       )
     )
   ORDER BY player.nba_draft_number, player.id
   LIMIT 1;

  IF v_player_id IS NULL THEN
    RAISE EXCEPTION 'No available players for auto-pick'
      USING ERRCODE = 'P0001';
  END IF;

  v_result := private.make_snake_pick_atomic_internal(
    p_draft_id,
    p_member_id,
    v_player_id,
    v_reason IN ('timer_expired', 'season_boundary_backstop'),
    p_to_taxi
  );

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    NULL,
    'auto_pick',
    jsonb_build_object(
      'reason', v_reason,
      'source', 'nba_draft_number',
      'memberId', p_member_id,
      'playerId', v_player_id,
      'pick', v_result->'pick'
    )
  );

  __request_result := v_result || jsonb_build_object('player_id', v_player_id); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;
