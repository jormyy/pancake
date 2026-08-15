-- Canonical SQL source for public.expire_mock_draft_rooms.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
