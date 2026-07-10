-- Canonical SQL source for public.withdraw_auction_nomination_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
    RETURN false;
  END IF;

  SELECT * INTO v_draft FROM drafts WHERE id = v_nom.draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;
  IF v_draft.status <> 'in_progress' THEN
    RETURN false;
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

  RETURN true;
END;
$$;
