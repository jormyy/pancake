-- Canonical SQL source for private.guard_accepted_trade_capacity.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.guard_accepted_trade_capacity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_member uuid; v_league uuid; v_season uuid;
BEGIN
  FOR v_league,v_season,v_member IN
    SELECT DISTINCT league_id,league_season_id,member_id FROM (
      SELECT OLD.league_id,OLD.league_season_id,OLD.member_id WHERE TG_OP<>'INSERT'
      UNION ALL SELECT NEW.league_id,NEW.league_season_id,NEW.member_id WHERE TG_OP<>'DELETE'
    ) affected ORDER BY league_id,member_id,league_season_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_league::text),hashtext(v_member::text));
    IF TG_WHEN='AFTER' THEN
      PERFORM private.assert_accepted_trade_capacity(v_league,v_season,v_member);
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
