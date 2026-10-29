CREATE OR REPLACE FUNCTION private.queue_changed_matchup_forecasts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE affected_league uuid;
BEGIN
  IF TG_TABLE_NAME='matchups' THEN
    PERFORM private.queue_matchup_forecasts(NEW.league_id,NEW.id);
  ELSIF TG_TABLE_NAME IN ('lineup_optimizer_settings','lineup_slot_templates') THEN
    IF TG_OP='DELETE' THEN PERFORM private.queue_matchup_forecasts(OLD.league_id);
    ELSE PERFORM private.queue_matchup_forecasts(NEW.league_id); END IF;
  ELSIF TG_TABLE_NAME='players' THEN
    FOR affected_league IN SELECT DISTINCT roster.league_id FROM public.roster_players roster
      WHERE roster.player_id=NEW.id ORDER BY roster.league_id LOOP
      PERFORM private.queue_matchup_forecasts(affected_league);
    END LOOP;
  ELSIF NEW.topic IN ('lineup','roster','score')
    OR NEW.topic='inventory' AND (NEW.details IS NULL OR NEW.details @> '[{"resource":"season"}]'::jsonb) THEN
    PERFORM private.queue_matchup_forecasts(NEW.league_id);
  END IF;
  RETURN NEW;
END;
$$;
