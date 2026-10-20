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

  RETURN v_result || jsonb_build_object('player_id', v_player_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_season_boundary_if_due(
  p_now timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp := timezone('America/New_York', p_now);
BEGIN


  IF v_now::time < make_time(9, 0, 0) THEN
    RETURN;
  END IF;


  PERFORM private.roll_setup_league_seasons(p_now);

  IF NOT EXISTS (
    SELECT 1
      FROM public.leagues
     WHERE status IN (
       'active'::public.league_status,
       'playoffs'::public.league_status,
       'offseason'::public.league_status,
       'drafting'::public.league_status
     )
  ) THEN
    RETURN;
  END IF;

  IF NOT private.claim_cron_dispatch('season-boundary', to_char(v_now, 'YYYY-MM-DD')) THEN
    RETURN;
  END IF;
  PERFORM private.invoke_claimed_edge_function('season-boundary', 'season-boundary');
END;
$$;
