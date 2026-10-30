-- Canonical SQL source for private.guard_waiver_plan_reservations.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.guard_waiver_plan_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_player uuid; lock_reason text;
BEGIN
  IF NEW.status<>'pending' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.league_id::text),hashtext(NEW.member_id::text));
  FOR v_player IN SELECT DISTINCT id FROM unnest(ARRAY[NEW.player_id,NEW.drop_player_id]) id
    WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(NEW.league_id::text),hashtext(v_player::text));
    SELECT locked.reason INTO lock_reason FROM private.locked_assets(NEW.league_id,NEW.league_season_id,NEW.member_id) locked
      WHERE locked.asset_kind='player' AND locked.asset_id=v_player AND locked.source_kind='trade'
      ORDER BY locked.source_id LIMIT 1;
    IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE='PA004'; END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
