CREATE OR REPLACE FUNCTION private.guard_player_stats_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='250ms' AS $$
DECLARE old_id uuid; old_game uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.game_id) IS NOT DISTINCT FROM ROW(OLD.id,OLD.game_id) THEN RETURN NEW; END IF;
    old_id:=OLD.id; old_game:=OLD.game_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pgs-id:'||NEW.id::text,0));
  IF EXISTS(SELECT FROM public.player_game_stats row WHERE row.id=NEW.id AND row.game_id<>NEW.game_id
    AND (old_id IS NULL OR ROW(row.id,row.game_id) IS DISTINCT FROM ROW(old_id,old_game))) THEN
    RAISE EXCEPTION 'Duplicate player stats identity across seasons' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;
