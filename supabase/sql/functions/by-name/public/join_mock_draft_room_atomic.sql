-- Canonical SQL source for public.join_mock_draft_room_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
