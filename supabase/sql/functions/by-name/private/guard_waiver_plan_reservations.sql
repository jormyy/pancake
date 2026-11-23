-- Canonical SQL source for private.guard_waiver_plan_reservations.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.guard_waiver_plan_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_player uuid;
BEGIN
  IF NEW.status<>'pending' THEN RETURN NEW; END IF;
  PERFORM private.lock_roster_scope(NEW.league_id, ARRAY[NEW.member_id], ARRAY[NEW.player_id, NEW.drop_player_id]);
  FOR v_player IN SELECT DISTINCT id FROM unnest(ARRAY[NEW.player_id,NEW.drop_player_id]) id
    WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM private.assert_roster_action_allowed(CASE WHEN v_player=NEW.drop_player_id THEN 'claim_drop' ELSE 'claim_add' END::private.roster_action,
      NEW.league_id, NEW.league_season_id, NEW.member_id, v_player);
  END LOOP;
  RETURN NEW;
END;
$$;
