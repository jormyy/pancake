-- Canonical SQL source for public.auto_pick_snake_pick_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.auto_pick_snake_pick_atomic(p_draft_id uuid, p_member_id uuid, p_reason text DEFAULT 'manual'::text, p_to_taxi boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  SELECT pool.player_id
    INTO v_player_id
    FROM private.rookie_draft_pool(p_draft_id) AS pool
   WHERE NOT COALESCE(p_to_taxi,false) OR v_draft.is_mock OR
     private.can_acquire_draft_taxi(v_draft.league_id,v_draft.league_season_id,p_member_id,pool.player_id)
   ORDER BY pool.draft_overall_pick, pool.player_id
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
      'source', 'nba_draft_class',
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
$function$;
