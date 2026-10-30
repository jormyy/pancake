-- Canonical SQL source for private.prevent_pending_waiver_inactive_drop.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_pending_waiver_inactive_drop()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
DECLARE
  v_slot text;
BEGIN
  IF NEW.drop_player_id IS NULL THEN
    NEW.drop_roster_slot := NULL;
    RETURN NEW;
  END IF;
  SELECT CASE WHEN rp.is_on_taxi THEN 'taxi' WHEN rp.is_on_ir THEN 'ir' ELSE 'active' END
    INTO v_slot FROM roster_players rp
   WHERE rp.league_id=NEW.league_id AND rp.league_season_id=NEW.league_season_id
     AND rp.member_id=NEW.member_id AND rp.player_id=NEW.drop_player_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Waiver drop player must be on your roster.' USING ERRCODE='P0001';
  END IF;
  IF TG_OP='UPDATE' AND OLD.drop_player_id=NEW.drop_player_id
    AND OLD.drop_roster_slot IN ('taxi','ir') AND OLD.drop_roster_slot<>v_slot THEN
    RAISE EXCEPTION 'Drop player is no longer in the selected roster slot.' USING ERRCODE='P0001';
  END IF;
  NEW.drop_roster_slot := v_slot;
  RETURN NEW;
END;
$$;
