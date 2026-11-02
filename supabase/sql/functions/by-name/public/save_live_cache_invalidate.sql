CREATE OR REPLACE FUNCTION public.save_live_cache_invalidate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME='nba_games' THEN
    IF TG_OP='UPDATE' AND ROW(NEW.nba_game_id,NEW.season_year,NEW.game_date,NEW.home_team,NEW.away_team)
      IS NOT DISTINCT FROM ROW(OLD.nba_game_id,OLD.season_year,OLD.game_date,OLD.home_team,OLD.away_team) THEN
      IF NEW.id::text IS DISTINCT FROM current_setting('app.live_feed_game',true)
        AND ROW(NEW.status,NEW.home_score,NEW.away_score,NEW.game_status_text,NEW.live_stats_elapsed_seconds,NEW.live_scoreboard_elapsed_seconds)
          IS DISTINCT FROM ROW(OLD.status,OLD.home_score,OLD.away_score,OLD.game_status_text,OLD.live_stats_elapsed_seconds,OLD.live_scoreboard_elapsed_seconds) THEN
        UPDATE private.live_feed_state SET stats_snapshot=NULL WHERE game_id=NEW.id AND stats_snapshot IS NOT NULL;
      END IF;
      RETURN NULL;
    END IF;
    DELETE FROM private.live_game_identity_checks WHERE season_year=NEW.season_year;
    IF TG_OP='UPDATE' THEN
      DELETE FROM private.live_game_identity_checks WHERE season_year=OLD.season_year;
      UPDATE private.live_feed_state SET stats_snapshot=NULL WHERE game_id=NEW.id AND stats_snapshot IS NOT NULL;
    END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM changed_stats) THEN RETURN NULL; END IF;
    UPDATE private.live_feed_state feed SET stats_snapshot=NULL
      WHERE feed.stats_snapshot IS NOT NULL
        AND feed.game_id::text IS DISTINCT FROM current_setting('app.live_feed_game',true)
        AND feed.game_id IN (SELECT game_id FROM changed_stats);
    IF TG_OP='UPDATE' THEN
      UPDATE private.live_feed_state feed SET stats_snapshot=NULL
        WHERE feed.stats_snapshot IS NOT NULL
          AND feed.game_id::text IS DISTINCT FROM current_setting('app.live_feed_game',true)
          AND feed.game_id IN (SELECT game_id FROM prior_stats);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
