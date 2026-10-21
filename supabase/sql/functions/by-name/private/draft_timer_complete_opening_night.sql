CREATE OR REPLACE FUNCTION private.draft_timer_complete_opening_night(
  p_limit int DEFAULT 100,
  p_at timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (
  pick_id uuid, draft_id uuid, member_id uuid, player_id uuid,
  picked boolean, error_code text, error_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft record;
  v_pick record;
  v_result jsonb;
  v_results jsonb;
BEGIN
  IF NOT private.draft_timer_opening_night_completion_enabled() THEN RETURN; END IF;
  FOR v_draft IN
    SELECT draft.id
      FROM drafts AS draft
      JOIN league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
     WHERE draft.draft_type = 'snake' AND NOT draft.is_mock
       AND (draft.status IN ('in_progress', 'paused') OR (draft.status = 'completed' AND EXISTS (
         SELECT 1 FROM snake_draft_picks AS unmade WHERE unmade.draft_id=draft.id
           AND unmade.player_id IS NULL AND unmade.skipped_at IS NOT NULL)))
       AND private.draft_timer_opening_night_cutoff(season.season_year) <= p_at
     ORDER BY draft.id
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 0), 500)
  LOOP
    BEGIN
      v_results := '[]'::jsonb;
      IF NOT pg_try_advisory_xact_lock(hashtext(v_draft.id::text), 0) THEN CONTINUE; END IF;
      PERFORM 1 FROM drafts AS current_draft WHERE current_draft.id=v_draft.id
        AND (current_draft.status IN ('in_progress','paused') OR (current_draft.status='completed' AND EXISTS (
          SELECT 1 FROM snake_draft_picks AS unmade WHERE unmade.draft_id=current_draft.id
            AND unmade.player_id IS NULL AND unmade.skipped_at IS NOT NULL))) FOR UPDATE;
      IF NOT FOUND THEN CONTINUE; END IF;
      UPDATE draft_picks AS asset
         SET is_used=false, used_at=NULL, rookie_draft_id=NULL
        FROM snake_draft_picks AS skipped
       WHERE skipped.draft_id=v_draft.id AND skipped.player_id IS NULL AND skipped.skipped_at IS NOT NULL
         AND asset.id=skipped.draft_pick_id AND asset.rookie_draft_id=v_draft.id;
      UPDATE snake_draft_picks SET skipped_at=NULL, skip_reason=NULL
       WHERE snake_draft_picks.draft_id=v_draft.id AND snake_draft_picks.player_id IS NULL
         AND snake_draft_picks.skipped_at IS NOT NULL;
      UPDATE drafts SET status='in_progress', completed_at=NULL
       WHERE id=v_draft.id AND status='completed';
      FOR v_pick IN
        SELECT pick.id, pick.member_id FROM snake_draft_picks AS pick
         WHERE pick.draft_id = v_draft.id AND pick.player_id IS NULL AND pick.skipped_at IS NULL
         ORDER BY pick.overall_pick
      LOOP
        v_result := public.auto_pick_snake_pick_atomic(v_draft.id, v_pick.member_id, 'season_boundary_backstop');
        v_results := v_results || jsonb_build_array(jsonb_build_object('pick_id',v_pick.id,
          'draft_id',v_draft.id,'member_id',v_pick.member_id,'player_id',v_result->>'player_id'));
      END LOOP;
      PERFORM private.complete_rookie_draft_if_ready(v_draft.id, p_at);
      INSERT INTO draft_audit_logs(draft_id, league_id, action, metadata)
        SELECT id, league_id, 'opening_night_completion', jsonb_build_object('cutoff', p_at)
          FROM drafts WHERE id = v_draft.id;
      RETURN QUERY SELECT result.pick_id, result.draft_id, result.member_id, result.player_id,
        true, NULL::text, NULL::text
        FROM jsonb_to_recordset(v_results) AS result(pick_id uuid, draft_id uuid, member_id uuid, player_id uuid);
    EXCEPTION WHEN OTHERS THEN
      RETURN QUERY SELECT NULL::uuid, v_draft.id, NULL::uuid, NULL::uuid, false, SQLSTATE::text, SQLERRM::text;
    END;
  END LOOP;
END;
$$;
