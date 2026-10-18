CREATE OR REPLACE FUNCTION private.guard_waiver_plan_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_player uuid;
BEGIN
  IF NEW.status<>'pending' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.league_id::text),hashtext(NEW.member_id::text));
  FOR v_player IN SELECT DISTINCT id FROM unnest(ARRAY[NEW.player_id,NEW.drop_player_id]) id
    WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(NEW.league_id::text),hashtext(v_player::text));
    IF EXISTS (SELECT 1 FROM trade_participants participant JOIN trades trade ON trade.id=participant.trade_id
      WHERE trade.league_season_id=NEW.league_season_id AND trade.status IN ('pending','accepted')
        AND v_player=ANY(participant.drop_player_ids)) THEN
      RAISE EXCEPTION 'Player is reserved as a planned drop in a trade.' USING ERRCODE='PT001';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
