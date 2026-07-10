SET lock_timeout = '5s';
SET statement_timeout = '2min';

CREATE OR REPLACE FUNCTION private.ineligible_ir_player_names(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT string_agg(COALESCE(player_row.display_name, 'Unknown'), ', ' ORDER BY player_row.display_name)
    FROM public.roster_players AS roster_row
    JOIN public.players AS player_row
      ON player_row.id = roster_row.player_id
   WHERE roster_row.member_id = p_member_id
     AND roster_row.league_id = p_league_id
     AND roster_row.league_season_id = p_league_season_id
     AND roster_row.is_on_ir = true
     AND NOT (
       lower(COALESCE(player_row.injury_status, '')) = 'out'
       OR lower(COALESCE(player_row.injury_status, '')) LIKE 'ir%'
     )
$$;

CREATE OR REPLACE FUNCTION private.prevent_pending_waiver_claim_with_ineligible_ir()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ineligible text;
BEGIN
  IF NEW.status = 'pending'::waiver_claim_status THEN
    v_ineligible := private.ineligible_ir_player_names(
      NEW.league_id,
      NEW.league_season_id,
      NEW.member_id
    );

    IF v_ineligible IS NOT NULL AND length(v_ineligible) > 0 THEN
      RAISE EXCEPTION 'You have ineligible players on IR (%). Activate or drop them before placing waiver claims.',
        v_ineligible
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS waiver_claims_pending_ir_guard ON public.waiver_claims;
CREATE TRIGGER waiver_claims_pending_ir_guard
  BEFORE INSERT OR UPDATE OF status, member_id, league_id, league_season_id
  ON public.waiver_claims
  FOR EACH ROW
  EXECUTE FUNCTION private.prevent_pending_waiver_claim_with_ineligible_ir();

CREATE INDEX IF NOT EXISTS idx_waiver_claims_pending_due_processing
  ON public.waiver_claims (
    league_id,
    league_season_id,
    player_id,
    process_date,
    bid_amount DESC,
    claim_order ASC,
    submitted_at ASC,
    id ASC,
    member_id
  )
  WHERE status = 'pending'::public.waiver_claim_status;

RESET statement_timeout;
RESET lock_timeout;
