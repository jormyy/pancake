-- Canonical SQL source for public.leave_mock_draft_room_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
