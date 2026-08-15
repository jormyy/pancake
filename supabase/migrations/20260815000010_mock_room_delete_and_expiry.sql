-- Mock draft rooms lingered forever: there was no delete path, and finished
-- or never-started rooms stayed in the league list indefinitely.
-- 1. delete_mock_draft_room_atomic: the creator (or the commissioner) can
--    delete a mock room at any time. Children cascade; real drafts are
--    untouchable through this path (is_mock gate).
-- 2. expire_mock_draft_rooms + daily cron: rooms self-expire 24h after they
--    finish, 24h after their scheduled time if never started, or 24h after
--    an abandoned live session began.

CREATE OR REPLACE FUNCTION public.delete_mock_draft_room_atomic(
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

  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.league_members AS lm
     WHERE lm.id = p_member_id
       AND lm.league_id = v_draft.league_id
       AND lm.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to delete this mock draft room'
      USING ERRCODE = '42501';
  END IF;

  IF v_draft.created_by_member_id IS DISTINCT FROM p_member_id AND NOT EXISTS (
    SELECT 1
      FROM public.leagues AS league
      JOIN public.league_members AS lm
        ON lm.league_id = league.id
     WHERE league.id = v_draft.league_id
       AND lm.id = p_member_id
       AND lm.user_id = league.commissioner_id
  ) THEN
    RAISE EXCEPTION 'Only the room creator or the commissioner can delete a mock draft room'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.drafts WHERE id = p_draft_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_mock_draft_room_atomic(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_mock_draft_room_atomic(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.delete_mock_draft_room_atomic(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.delete_mock_draft_room_atomic(uuid, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.expire_mock_draft_rooms()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired integer;
BEGIN
  DELETE FROM public.drafts
   WHERE is_mock
     AND (
       (status IN ('completed'::draft_status, 'cancelled'::draft_status)
         AND COALESCE(completed_at, created_at) < now() - interval '24 hours')
       OR (status = 'pending'::draft_status
         AND COALESCE(scheduled_at, created_at) < now() - interval '24 hours')
       OR (status IN ('in_progress'::draft_status, 'paused'::draft_status)
         AND COALESCE(started_at, created_at) < now() - interval '24 hours')
     );

  GET DIAGNOSTICS v_expired = ROW_COUNT;
  RETURN v_expired;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_mock_draft_rooms() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_mock_draft_rooms() FROM anon;
REVOKE ALL ON FUNCTION public.expire_mock_draft_rooms() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_mock_draft_rooms() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'mock-room-expiry',
      '30 9 * * *',
      $job$SELECT public.expire_mock_draft_rooms()$job$
    );
  END IF;
END $$;
