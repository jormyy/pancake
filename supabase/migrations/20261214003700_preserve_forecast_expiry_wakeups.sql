CREATE TABLE private.matchup_forecast_expiries(
  matchup_id uuid PRIMARY KEY REFERENCES public.matchup_forecasts(matchup_id) ON DELETE CASCADE,
  available_at timestamptz NOT NULL
);
CREATE INDEX matchup_forecast_expiries_due ON private.matchup_forecast_expiries(available_at,matchup_id);
ALTER TABLE private.matchup_forecast_expiries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.matchup_forecast_expiries FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION private.queue_matchup_forecast_expiry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  INSERT INTO private.matchup_forecast_expiries AS queued(matchup_id,available_at)
    VALUES(NEW.matchup_id,NEW.valid_until)
  ON CONFLICT(matchup_id) DO UPDATE SET available_at=EXCLUDED.available_at
    WHERE queued.available_at IS DISTINCT FROM EXCLUDED.available_at;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.queue_matchup_forecast_expiry() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.enqueue_matchup_forecasts(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM private.forecast_refresh_requests WHERE available_at<=p_now)
    OR EXISTS(SELECT 1 FROM private.matchup_forecast_expiries WHERE available_at<=p_now) THEN
    PERFORM private.work_enqueue('forecast-inputs',date_trunc('minute',p_now)::text,p_now,'{"schedulerChunk":"forecasts"}');
  END IF;
  IF EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty AND available_at<=p_now
    AND (claimed_at IS NULL OR claimed_at<p_now-interval '3 minutes')) THEN
    PERFORM private.work_enqueue('matchup-forecasts',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.complete_forecast_input_chunk()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE requested private.forecast_refresh_requests%ROWTYPE; matchup uuid; due timestamptz; processed integer:=0; input_revision bigint;
BEGIN
  SELECT matchup_id INTO matchup FROM private.matchup_forecast_expiries WHERE available_at<=now()
    ORDER BY available_at,matchup_id LIMIT 1;
  IF FOUND THEN
    PERFORM 1 FROM public.matchups WHERE id=matchup FOR KEY SHARE;
    IF FOUND THEN PERFORM private.queue_matchup_forecasts(NULL,matchup); END IF;
    DELETE FROM private.matchup_forecast_expiries WHERE matchup_id=matchup AND available_at<=now();
    RETURN jsonb_build_object('processed',0,'remaining',true);
  END IF;
  SELECT * INTO requested FROM private.forecast_refresh_requests WHERE available_at<=now()
    ORDER BY available_at,scope LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('processed',0,'remaining',false); END IF;
  IF requested.matchup_id IS NOT NULL THEN
    matchup:=requested.matchup_id;
  ELSE
    SELECT item.id INTO matchup FROM public.matchups item
    JOIN public.league_seasons season ON season.id=item.league_season_id AND season.is_current
    JOIN public.leagues league ON league.id=item.league_id AND league.deleted_at IS NULL
    JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=item.week_number
    JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(item.end_week_number,item.week_number)
    WHERE NOT item.is_voided AND (requested.league_id IS NULL OR item.league_id=requested.league_id)
      AND (requested.after_matchup_id IS NULL OR item.id>requested.after_matchup_id)
      AND last_week.week_end>=(now() AT TIME ZONE 'America/New_York')::date-1
      AND first_week.week_start<=(now() AT TIME ZONE 'America/New_York')::date+14
    ORDER BY item.id LIMIT 1;
  END IF;
  IF matchup IS NULL THEN
    DELETE FROM private.forecast_refresh_requests WHERE scope=requested.scope;
  ELSE
    SELECT current.revision INTO input_revision FROM private.forecast_refresh_requests current WHERE scope='matchup:'||matchup;
    due:=private.refresh_matchup_forecast_input(matchup);
    processed:=1;
    IF requested.matchup_id IS NOT NULL THEN
      IF due IS NULL THEN DELETE FROM private.forecast_refresh_requests WHERE scope=requested.scope;
      ELSE UPDATE private.forecast_refresh_requests SET available_at=due,after_matchup_id=NULL WHERE scope=requested.scope;
      END IF;
    ELSE
      UPDATE private.forecast_refresh_requests SET after_matchup_id=matchup WHERE scope=requested.scope;
      IF due IS NOT NULL THEN
        IF input_revision IS NOT NULL THEN
          UPDATE private.forecast_refresh_requests SET available_at=due,after_matchup_id=NULL
            WHERE scope='matchup:'||matchup AND revision=input_revision;
        ELSE
          INSERT INTO private.forecast_refresh_requests(scope,matchup_id,available_at)
            VALUES('matchup:'||matchup,matchup,due) ON CONFLICT DO NOTHING;
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('processed',processed,'remaining',EXISTS(SELECT 1 FROM private.forecast_refresh_requests WHERE available_at<=now())
    OR EXISTS(SELECT 1 FROM private.matchup_forecast_expiries WHERE available_at<=now()));
END;
$$;

REVOKE ALL ON FUNCTION private.complete_forecast_input_chunk() FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER queue_matchup_forecast_expiry AFTER INSERT OR UPDATE OF valid_until ON public.matchup_forecasts
  FOR EACH ROW EXECUTE FUNCTION private.queue_matchup_forecast_expiry();
INSERT INTO private.matchup_forecast_expiries(matchup_id,available_at)
  SELECT matchup_id,valid_until FROM public.matchup_forecasts;
