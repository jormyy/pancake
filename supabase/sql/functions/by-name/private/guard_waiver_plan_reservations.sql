-- Canonical SQL source for private.guard_waiver_plan_reservations.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.guard_waiver_plan_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_player uuid;
BEGIN
  IF NEW.status<>'pending' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.league_id::text),hashtext(NEW.member_id::text));
  FOR v_player IN SELECT DISTINCT id FROM unnest(ARRAY[NEW.player_id,NEW.drop_player_id]) id
    WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(NEW.league_id::text),hashtext(v_player::text));
    PERFORM private.assert_roster_action_allowed(CASE WHEN v_player=NEW.drop_player_id THEN 'claim_drop' ELSE 'claim_add' END::private.roster_action,
      NEW.league_id, NEW.league_season_id, NEW.member_id, v_player);
  END LOOP;
  RETURN NEW;
END;
$$;
