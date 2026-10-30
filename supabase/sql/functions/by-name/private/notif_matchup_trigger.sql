-- Canonical SQL source for private.notif_matchup_trigger.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.notif_matchup_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  m record;
  v_loser uuid;
BEGIN
  IF OLD.is_finalized OR NOT NEW.is_finalized OR NEW.is_voided OR NEW.matchup_type = 'regular_season' OR NEW.winner_member_id IS NULL THEN RETURN NEW; END IF;
  v_loser := CASE WHEN NEW.winner_member_id = NEW.home_member_id THEN NEW.away_member_id ELSE NEW.home_member_id END;
  PERFORM private.notif_enqueue('playoff_eliminated',NEW.id::text,NEW.league_id,v_loser,jsonb_build_object('matchupId',NEW.id));
  IF NEW.matchup_type = 'playoff_final' THEN
    FOR m IN SELECT id FROM public.league_members WHERE league_id = NEW.league_id LOOP
      PERFORM private.notif_enqueue('champion',NEW.league_season_id::text,NEW.league_id,m.id,
        jsonb_build_object('matchupId',NEW.id,'winnerMemberId',NEW.winner_member_id));
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
