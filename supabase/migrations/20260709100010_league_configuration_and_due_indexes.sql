CREATE OR REPLACE FUNCTION public.update_league_configuration_atomic(
  p_league_id uuid,
  p_settings jsonb,
  p_slots jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION 'p_settings must be a JSON object.'
      USING ERRCODE = '22023';
  END IF;

  IF p_settings <> '{}'::jsonb THEN
    PERFORM public.update_league_settings_atomic(p_league_id, p_settings);
  END IF;

  IF p_slots IS NOT NULL THEN
    PERFORM public.update_lineup_slots_atomic(p_league_id, p_slots);
  END IF;
END;
$$;

-- Supabase CLI applies migration files through pipeline mode, which rejects
-- CREATE INDEX CONCURRENTLY. Stage both replacements before removing the old
-- index, and fail fast rather than waiting behind waiver writes.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE INDEX idx_waiver_claims_pending_due_groups
  ON public.waiver_claims (process_date, league_id, league_season_id, player_id)
  INCLUDE (member_id, bid_amount, claim_order, submitted_at)
  WHERE status = 'pending'::public.waiver_claim_status;

CREATE INDEX idx_waiver_claims_pending_player_candidates
  ON public.waiver_claims (league_id, league_season_id, player_id, process_date)
  INCLUDE (member_id, bid_amount, claim_order, submitted_at)
  WHERE status = 'pending'::public.waiver_claim_status;

DROP INDEX IF EXISTS public.idx_waiver_claims_pending_due_processing;

RESET statement_timeout;
RESET lock_timeout;

REVOKE ALL ON FUNCTION public.update_league_configuration_atomic(uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_league_configuration_atomic(uuid, jsonb, jsonb) TO authenticated, service_role;
