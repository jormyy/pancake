-- Serialize absence controls and pick reseeding with draft reset.
BEGIN;

CREATE OR REPLACE FUNCTION public.pause_draft_for_absence_atomic(p_draft_id uuid, p_actor_user_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_draft            drafts%ROWTYPE;
  v_remaining_seconds int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;

  -- No-op: already paused for absence (multiple clients converge here)
  IF v_draft.status = 'paused' AND v_draft.pause_reason = 'member_absent' THEN
    RETURN;
  END IF;

  IF v_draft.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Only an in-progress draft can be paused.';
  END IF;

  IF v_draft.draft_type <> 'auction' THEN
    RAISE EXCEPTION 'Presence-pause only applies to auction drafts.';
  END IF;

  -- Freeze countdown and record remaining seconds
  SELECT GREATEST(CEIL(EXTRACT(EPOCH FROM (countdown_expires_at - now())))::int, 0)
    INTO v_remaining_seconds
    FROM nominations
   WHERE draft_id = p_draft_id
     AND status   = 'open'
     AND countdown_expires_at IS NOT NULL
   ORDER BY nominated_at DESC
   LIMIT 1
   FOR UPDATE;

  UPDATE nominations
     SET countdown_expires_at = NULL
   WHERE draft_id = p_draft_id
     AND status   = 'open';

  UPDATE drafts
     SET status                        = 'paused',
         paused_at                     = now(),
         timer_paused_remaining_seconds = v_remaining_seconds,
         pause_reason                  = 'member_absent'
   WHERE id = p_draft_id;

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'pause',
    jsonb_build_object('reason', 'member_absent', 'remainingSeconds', v_remaining_seconds)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.resume_draft_if_absent_atomic(p_draft_id uuid, p_actor_user_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_draft      drafts%ROWTYPE;
  v_new_expiry timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;

  -- Only resume member_absent pauses; leave manual/timer pauses alone
  IF v_draft.status <> 'paused' OR v_draft.pause_reason IS DISTINCT FROM 'member_absent' THEN
    RETURN;
  END IF;

  -- Restore countdown if there were seconds remaining
  IF v_draft.timer_paused_remaining_seconds IS NOT NULL
     AND v_draft.timer_paused_remaining_seconds > 0 THEN
    v_new_expiry := now() + (v_draft.timer_paused_remaining_seconds * interval '1 second');
    UPDATE nominations
       SET countdown_expires_at = v_new_expiry
     WHERE draft_id = p_draft_id
       AND status   = 'open';
  END IF;

  UPDATE drafts
     SET status                        = 'in_progress',
         paused_at                     = NULL,
         timer_paused_remaining_seconds = NULL,
         pause_reason                  = NULL
   WHERE id = p_draft_id;

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'resume',
    jsonb_build_object('reason', 'member_absent_rejoined')
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reseed_rookie_draft_picks_atomic(
  p_draft_id uuid,
  p_rounds int DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_rounds int;
  v_season_year int;
  v_order_count int;
  v_pick_count int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;

  IF v_draft.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Draft is not in progress';
  END IF;

  v_rounds := COALESCE(p_rounds, v_draft.rounds, 3);
  IF v_rounds < 1 OR v_rounds > 3 THEN
    RAISE EXCEPTION 'Rookie draft rounds must be between 1 and 3.';
  END IF;

  PERFORM 1
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NOT NULL
   FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot reseed - picks have already been made';
  END IF;

  SELECT season_year
    INTO v_season_year
    FROM league_seasons
   WHERE id = v_draft.league_season_id
   FOR SHARE;

  SELECT count(*)
    INTO v_order_count
    FROM draft_orders
   WHERE draft_id = p_draft_id;

  IF v_order_count < 2 THEN
    RAISE EXCEPTION 'Draft orders not found';
  END IF;

  DELETE FROM snake_draft_picks
   WHERE draft_id = p_draft_id;

  WITH pick_slots AS (
    SELECT
      rounds.round,
      ordered.member_id AS original_owner_id,
      CASE
        WHEN rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
        ELSE ordered.position
      END AS pick_in_round
    FROM generate_series(1, v_rounds) AS rounds(round)
    CROSS JOIN draft_orders AS ordered
    WHERE ordered.draft_id = p_draft_id
  ),
  resolved AS (
    SELECT
      pick_slots.round,
      pick_slots.pick_in_round,
      pick_slots.original_owner_id,
      dp.id AS draft_pick_id,
      dp.current_owner_id AS member_id
    FROM pick_slots
    JOIN LATERAL (
      SELECT id, current_owner_id
        FROM draft_picks
       WHERE league_id = v_draft.league_id
         AND season_year = v_season_year
         AND round = pick_slots.round
         AND original_owner_id = pick_slots.original_owner_id
         AND is_used = false
       ORDER BY id
       LIMIT 1
       FOR UPDATE
    ) AS dp ON true
  )
  INSERT INTO snake_draft_picks (
    draft_id,
    overall_pick,
    round,
    pick_in_round,
    member_id,
    draft_pick_id
  )
  SELECT
    p_draft_id,
    ((round - 1) * v_order_count) + pick_in_round,
    round,
    pick_in_round,
    member_id,
    draft_pick_id
  FROM resolved
  ORDER BY round, pick_in_round;

  GET DIAGNOSTICS v_pick_count = ROW_COUNT;
  IF v_pick_count <> v_order_count * v_rounds THEN
    RAISE EXCEPTION 'Failed to reseed every rookie draft pick slot';
  END IF;

  RETURN v_pick_count;
END;
$$;

COMMIT;
