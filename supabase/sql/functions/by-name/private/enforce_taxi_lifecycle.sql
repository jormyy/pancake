-- Canonical SQL source for private.enforce_taxi_lifecycle.
-- Keep the latest migration definition identical.

CREATE OR REPLACE FUNCTION private.enforce_taxi_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE
  v_entry boolean := false;
  v_continuity boolean := false;
  v_context private.taxi_acquisition_context%ROWTYPE;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    IF TG_OP = 'INSERT' THEN
      v_entry := NEW.is_on_taxi;
    ELSE
      v_entry := NEW.is_on_taxi AND (NOT OLD.is_on_taxi OR
        (OLD.league_id,OLD.league_season_id,OLD.member_id,OLD.player_id)
          IS DISTINCT FROM (NEW.league_id,NEW.league_season_id,NEW.member_id,NEW.player_id));
    END IF;
    IF v_entry THEN
      SELECT * INTO v_context FROM private.taxi_acquisition_context
       WHERE transaction_id=pg_current_xact_id() AND league_id=NEW.league_id
         AND league_season_id=NEW.league_season_id AND member_id=NEW.member_id AND player_id=NEW.player_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Players can enter taxi only through a draft or trade acquisition.' USING ERRCODE='P0001';
      END IF;
      IF v_context.source='carry_over' AND TG_OP='INSERT' THEN
        v_continuity := EXISTS (SELECT 1 FROM roster_players
          WHERE league_id=NEW.league_id AND league_season_id=v_context.related_id
            AND member_id=NEW.member_id AND player_id=NEW.player_id AND is_on_taxi);
      ELSIF v_context.source='merge' AND TG_OP='UPDATE' THEN
        v_continuity := OLD.is_on_taxi AND OLD.player_id=v_context.related_id
          AND (OLD.league_id,OLD.league_season_id,OLD.member_id)=(NEW.league_id,NEW.league_season_id,NEW.member_id);
      ELSIF v_context.source IN ('draft','trade') THEN
        IF NOT EXISTS (SELECT 1 FROM league_seasons WHERE id=NEW.league_season_id AND league_id=NEW.league_id AND is_current) THEN
          RAISE EXCEPTION 'Taxi acquisitions require the current season.' USING ERRCODE='P0001';
        END IF;
        PERFORM private.assert_taxi_acquisition_allowed(NEW.league_id,NEW.league_season_id,NEW.member_id,NEW.player_id);
      ELSE
        RAISE EXCEPTION 'Invalid taxi acquisition.' USING ERRCODE='P0001';
      END IF;
      IF v_context.source IN ('carry_over','merge') AND NOT v_continuity THEN
        RAISE EXCEPTION 'Taxi continuity does not match the existing roster.' USING ERRCODE='P0001';
      END IF;

    END IF;
  END IF;

  IF TG_OP <> 'INSERT' AND OLD.is_on_taxi
     AND EXISTS (SELECT 1 FROM leagues WHERE id=OLD.league_id)
     AND EXISTS (SELECT 1 FROM players WHERE id=OLD.player_id)
     AND EXISTS (SELECT 1 FROM league_seasons WHERE id=OLD.league_season_id AND is_current) THEN
    IF TG_OP='DELETE' THEN
      -- Removing a duplicate identity that still has a taxi row is continuity.
      v_continuity := EXISTS (
        SELECT 1 FROM private.taxi_acquisition_context c JOIN roster_players r
          ON r.league_id=c.league_id AND r.league_season_id=c.league_season_id AND r.player_id=c.player_id
         WHERE c.transaction_id=pg_current_xact_id() AND c.source='merge' AND c.related_id=OLD.player_id
           AND c.league_id=OLD.league_id AND c.league_season_id=OLD.league_season_id AND r.is_on_taxi);
    END IF;
    IF NOT v_continuity AND (TG_OP='DELETE' OR NOT NEW.is_on_taxi OR v_entry) THEN
      INSERT INTO league_player_taxi_exits(league_id,player_id,exited_at)
      VALUES (OLD.league_id,OLD.player_id,now()) ON CONFLICT(league_id,player_id) DO NOTHING;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
