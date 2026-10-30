-- Canonical SQL source for private.complete_notification_scan_chunk.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.complete_notification_scan_chunk(p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE state private.notification_scan_state%ROWTYPE; member uuid; next_due timestamptz;
BEGIN
  SELECT * INTO state FROM private.notification_scan_state WHERE id AND (available_at<=p_now OR scan_at IS NOT NULL OR EXISTS(SELECT 1 FROM private.notification_scan_dirty)) FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('processed',0,'remaining',false); END IF;
  IF state.scan_at IS NULL THEN
    UPDATE private.notification_scan_state SET scan_at=p_now,after_member_id=NULL,cycle=cycle+1
      WHERE id RETURNING * INTO state;
    DELETE FROM private.notification_scan_dirty WHERE true;
    RETURN jsonb_build_object('processed',0,'remaining',true);
  END IF;
  SELECT m.id INTO member FROM public.league_members m JOIN public.leagues league ON league.id=m.league_id AND league.deleted_at IS NULL
    WHERE state.after_member_id IS NULL OR m.id>state.after_member_id ORDER BY m.id LIMIT 1;
  IF member IS NOT NULL THEN
    PERFORM private.scan_notification_member(member,state.scan_at);
    UPDATE private.notification_scan_state SET after_member_id=member WHERE id;
    RETURN jsonb_build_object('processed',1,'remaining',true);
  END IF;
  SELECT LEAST(((p_now AT TIME ZONE 'America/New_York')::date+1)::timestamp AT TIME ZONE 'America/New_York',
    (SELECT min(game_time)-interval '2 hours' FROM public.nba_games WHERE game_date=(p_now AT TIME ZONE 'America/New_York')::date
      AND status='Scheduled' AND game_time>p_now+interval '2 hours'),
    (SELECT min(pick.timer_expires_at)-interval '1 minute' FROM public.snake_draft_picks pick
      JOIN public.drafts draft ON draft.id=pick.draft_id AND draft.status='in_progress' AND NOT draft.is_mock
      WHERE pick.picked_at IS NULL AND pick.skipped_at IS NULL AND pick.timer_expires_at>p_now+interval '1 minute'),
    CASE WHEN EXISTS(SELECT 1 FROM public.nba_games WHERE game_date=(p_now AT TIME ZONE 'America/New_York')::date
      AND status='Scheduled' AND game_time>p_now AND game_time<=p_now+interval '2 hours')
      THEN p_now+interval '1 minute' END) INTO next_due;
  UPDATE private.notification_scan_state SET scan_at=NULL,after_member_id=NULL,
    available_at=CASE WHEN EXISTS(SELECT 1 FROM private.notification_scan_dirty) THEN p_now+interval '1 minute' ELSE next_due END WHERE id;
  PERFORM private.enqueue_process_trades(p_now);
  PERFORM private.dispatch_notification_delivery(p_now,state.cycle);
  RETURN jsonb_build_object('processed',0,'remaining',false);
END;
$$;
