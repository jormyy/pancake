-- Canonical SQL source for public.claim_lineup_refills.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.claim_lineup_refills(p_limit integer DEFAULT 1)
RETURNS TABLE(member_id uuid, league_id uuid, league_season_id uuid, requested_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM private.lineup_refill_requests r
   WHERE NOT EXISTS (
     SELECT 1 FROM public.lineup_optimizer_settings s
      WHERE s.league_id = r.league_id AND s.league_season_id = r.league_season_id
        AND s.member_id = r.member_id AND s.enabled
   );
  RETURN QUERY
  UPDATE private.lineup_refill_requests r SET claimed_at = clock_timestamp()
    FROM (
      SELECT q.member_id FROM private.lineup_refill_requests q
       WHERE q.claimed_at IS NULL OR q.claimed_at < clock_timestamp() - interval '10 minutes'
       ORDER BY q.requested_at, q.member_id
       LIMIT greatest(1, least(p_limit, 20))
       FOR UPDATE SKIP LOCKED
    ) due
   WHERE r.member_id = due.member_id
  RETURNING r.member_id, r.league_id, r.league_season_id, r.requested_at;
END;
$$;
