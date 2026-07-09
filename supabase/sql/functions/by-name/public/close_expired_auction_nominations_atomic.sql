-- Canonical SQL source for public.close_expired_auction_nominations_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.close_expired_auction_nominations_atomic(
  p_limit int DEFAULT 100
)
RETURNS TABLE (
  nomination_id uuid,
  closed boolean,
  error_code text,
  error_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 0), 500);
  v_nomination record;
  v_closed boolean;
BEGIN
  FOR v_nomination IN
    SELECT nomination.id
      FROM public.nominations AS nomination
      JOIN public.drafts AS draft
        ON draft.id = nomination.draft_id
     WHERE nomination.status = 'open'::public.nomination_status
       AND nomination.countdown_expires_at < now()
       AND draft.status = 'in_progress'::public.draft_status
     ORDER BY nomination.countdown_expires_at, nomination.nominated_at, nomination.id
     LIMIT v_limit
     FOR UPDATE OF nomination SKIP LOCKED
  LOOP
    BEGIN
      SELECT public.close_auction_nomination_atomic(v_nomination.id)
        INTO v_closed;

      RETURN QUERY
      SELECT
        v_nomination.id,
        COALESCE(v_closed, false),
        NULL::text,
        NULL::text;
    EXCEPTION WHEN OTHERS THEN
      RETURN QUERY
      SELECT
        v_nomination.id,
        false,
        SQLSTATE::text,
        SQLERRM::text;
    END;
  END LOOP;
END;
$$;
