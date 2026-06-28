-- Hide pending waiver strategy from other managers.
--
-- Pending claims reveal targeted players, planned drops, and waiver priority.
-- Managers may read their own pending claims; league-wide claim history becomes
-- visible only after processing. Expired, uncleared waiver-wire rows are also
-- hidden because they can indirectly signal that a pending claim exists.

DROP POLICY IF EXISTS "waiver_claims_select" ON public.waiver_claims;
DROP POLICY IF EXISTS "waiver_claims_select_own_pending_or_league_resolved" ON public.waiver_claims;

CREATE POLICY "waiver_claims_select_own_pending_or_league_resolved" ON public.waiver_claims
  FOR SELECT TO authenticated
  USING (
    league_id IN (SELECT private.my_league_ids())
    AND (
      status <> 'pending'::waiver_claim_status
      OR member_id IN (SELECT private.my_member_ids())
    )
  );

DROP POLICY IF EXISTS "waiver_wire_log_select" ON public.waiver_wire_log;
DROP POLICY IF EXISTS "waiver_wire_log_select_visible_league_rows" ON public.waiver_wire_log;

CREATE POLICY "waiver_wire_log_select_visible_league_rows" ON public.waiver_wire_log
  FOR SELECT TO authenticated
  USING (
    league_id IN (SELECT private.my_league_ids())
    AND (
      cleared_at IS NOT NULL
      OR clears_at > now()
    )
  );
