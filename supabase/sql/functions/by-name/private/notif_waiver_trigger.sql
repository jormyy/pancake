CREATE OR REPLACE FUNCTION private.notif_waiver_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_event text;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
  v_event := CASE WHEN NEW.status = 'succeeded' THEN 'waiver_claim_won'
    WHEN NEW.status IN ('failed_priority','failed_roster') THEN 'waiver_claim_lost' END;
  IF v_event IS NOT NULL THEN
    PERFORM private.notif_enqueue(v_event,NEW.id::text,NEW.league_id,NEW.member_id,
      jsonb_build_object('claimId',NEW.id,'playerId',NEW.player_id,'body',COALESCE(NEW.failure_reason,'Your waiver claim succeeded.')));
    IF NOT EXISTS (SELECT 1 FROM public.waiver_claims pending WHERE pending.league_id = NEW.league_id
      AND pending.league_season_id = NEW.league_season_id AND pending.member_id = NEW.member_id
      AND pending.process_date <= NEW.process_date AND pending.status = 'pending') THEN
      PERFORM private.notif_enqueue('waivers_processed',NEW.league_season_id::text || ':' || NEW.process_date::text,
        NEW.league_id,NEW.member_id,jsonb_build_object('leagueSeasonId',NEW.league_season_id));
    END IF;
  END IF;
  IF NEW.status = 'failed_priority' AND EXISTS (
    SELECT 1 FROM public.waiver_wire_log settled
    JOIN public.waiver_claims winner ON winner.id=settled.claimed_by_claim_id
    JOIN public.leagues league ON league.id=settled.league_id AND league.waiver_mode='faab'
    WHERE settled.league_id=NEW.league_id AND settled.league_season_id=NEW.league_season_id
      AND settled.player_id=NEW.player_id AND settled.cleared_at=NEW.processed_at
      AND winner.league_id=NEW.league_id AND winner.league_season_id=NEW.league_season_id
      AND winner.player_id=NEW.player_id AND winner.status='succeeded'
      AND winner.processed_at=NEW.processed_at AND winner.bid_amount>NEW.bid_amount
  ) THEN
    PERFORM private.notif_enqueue('faab_outbid',NEW.id::text,NEW.league_id,NEW.member_id,
      jsonb_build_object('claimId',NEW.id,'playerId',NEW.player_id));
  END IF;
  RETURN NEW;
END;
$$;
