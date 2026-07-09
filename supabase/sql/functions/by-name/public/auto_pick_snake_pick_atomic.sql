-- Canonical SQL source for public.auto_pick_snake_pick_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.auto_pick_snake_pick_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_reason text DEFAULT 'manual'
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

  SELECT player.id
    INTO v_player_id
    FROM players AS player
   WHERE player.years_exp = 0
     AND player.nba_draft_number IS NOT NULL
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
    v_reason = 'timer_expired'
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
