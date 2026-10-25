-- Canonical SQL source for private.enforce_taxi_lifecycle.
-- Keep the latest migration definition identical.

CREATE OR REPLACE FUNCTION private.enforce_taxi_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE
  v_entry boolean := false;
  v_continuity boolean := false;
  v_context private.taxi_acquisition_context%ROWTYPE;
  v_year int;
  v_prior_year int;
  v_cap int;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    IF TG_OP = 'INSERT' THEN
      v_entry := NEW.is_on_taxi;
    ELSE
      v_entry := NEW.is_on_taxi AND (NOT OLD.is_on_taxi OR
        (OLD.league_id,OLD.league_season_id,OLD.member_id,OLD.player_id)
          IS DISTINCT FROM (NEW.league_id,NEW.league_season_id,NEW.member_id,NEW.player_id));
    END IF;
    IF TG_OP='UPDATE' AND NOT v_entry THEN NEW.taxi_start_season_year := OLD.taxi_start_season_year; END IF;
    IF v_entry THEN
      SELECT * INTO v_context FROM private.taxi_acquisition_context
       WHERE transaction_id=pg_current_xact_id() AND league_id=NEW.league_id
         AND league_season_id=NEW.league_season_id AND member_id=NEW.member_id AND player_id=NEW.player_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Players can enter taxi only through a draft or trade acquisition, a free-agent add, or a waiver claim.' USING ERRCODE='P0001';
      END IF;
      SELECT season_year INTO v_year FROM league_seasons WHERE id=NEW.league_season_id;
      SELECT taxi_max_seasons INTO v_cap FROM leagues WHERE id=NEW.league_id;
      IF TG_OP='UPDATE' AND (OLD.is_on_taxi OR v_context.source='trade') THEN
        NEW.taxi_start_season_year := private.taxi_start_year(NEW.league_id,NEW.player_id,COALESCE(OLD.taxi_start_season_year,v_year));
      ELSIF v_context.source='carry_over' THEN
        SELECT COALESCE(taxi_start_season_year,season.season_year) INTO v_prior_year
          FROM roster_players roster JOIN league_seasons season ON season.id=roster.league_season_id
          WHERE roster.league_season_id=v_context.related_id AND roster.member_id=NEW.member_id AND roster.player_id=NEW.player_id;
        v_prior_year := private.taxi_start_year(NEW.league_id,NEW.player_id,v_prior_year);
        NEW.taxi_start_season_year := v_prior_year;
        IF v_cap IS NOT NULL AND v_year-v_prior_year >= v_cap THEN
          NEW.is_on_taxi := false;
          INSERT INTO league_member_taxi_exits(league_id,member_id,player_id,exited_at) VALUES(NEW.league_id,NEW.member_id,NEW.player_id,now()) ON CONFLICT DO NOTHING;
        END IF;
      ELSE
        NEW.taxi_start_season_year := private.taxi_start_year(NEW.league_id,NEW.player_id,v_year);
      END IF;
      IF v_context.source='carry_over' AND TG_OP='INSERT' THEN
        v_continuity := EXISTS (SELECT 1 FROM roster_players
          WHERE league_id=NEW.league_id AND league_season_id=v_context.related_id
            AND member_id=NEW.member_id AND player_id=NEW.player_id AND is_on_taxi);
      ELSIF v_context.source='merge' AND TG_OP='UPDATE' THEN
        v_continuity := OLD.is_on_taxi AND OLD.player_id=v_context.related_id
          AND (OLD.league_id,OLD.league_season_id,OLD.member_id)=(NEW.league_id,NEW.league_season_id,NEW.member_id);
      ELSIF v_context.source IN ('draft','trade','free_agent','waiver') THEN
        IF NOT EXISTS (SELECT 1 FROM league_seasons WHERE id=NEW.league_season_id AND league_id=NEW.league_id AND is_current) THEN
          RAISE EXCEPTION 'Taxi acquisitions require the current season.' USING ERRCODE='P0001';
        END IF;
        PERFORM private.assert_taxi_acquisition_allowed(NEW.league_id,NEW.league_season_id,NEW.member_id,NEW.player_id);
      ELSE
        RAISE EXCEPTION 'Invalid taxi acquisition.' USING ERRCODE='P0001';
      END IF;
      IF v_context.source='trade' AND TG_OP='UPDATE' AND OLD.is_on_taxi AND NEW.is_on_taxi THEN v_continuity := true; END IF;
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
           AND c.league_id=OLD.league_id AND c.league_season_id=OLD.league_season_id
           AND c.member_id=OLD.member_id AND r.member_id=OLD.member_id AND r.is_on_taxi)
        -- A commissioner's draft reset undoes the acquisition; the team did not move the player out.
        OR EXISTS (
        SELECT 1 FROM private.taxi_acquisition_context c
         WHERE c.transaction_id=pg_current_xact_id() AND c.source='draft_reset'
           AND c.league_id=OLD.league_id AND c.league_season_id=OLD.league_season_id
           AND c.member_id=OLD.member_id AND c.player_id=OLD.player_id);
    END IF;
    IF NOT v_continuity AND (TG_OP='DELETE' OR NOT NEW.is_on_taxi OR v_entry) THEN
      INSERT INTO league_member_taxi_exits(league_id,member_id,player_id,exited_at)
      VALUES (OLD.league_id,OLD.member_id,OLD.player_id,now()) ON CONFLICT(league_id,member_id,player_id) DO NOTHING;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
