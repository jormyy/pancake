ALTER POLICY "waiver_claims_select_own_pending_or_league_resolved" ON public.waiver_claims
  USING (
    league_id IN (SELECT private.my_league_ids())
    AND (status NOT IN ('pending', 'cancelled')
      OR member_id IN (SELECT private.my_member_ids()))
  );
