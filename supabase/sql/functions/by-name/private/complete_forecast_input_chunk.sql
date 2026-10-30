-- Canonical SQL source for private.complete_forecast_input_chunk.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  IF EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty AND available_at<=now()
    AND NOT private.matchup_forecast_refresh_pending(matchup_id)
    AND (claimed_at IS NULL OR claimed_at<now()-interval '3 minutes')) THEN
    PERFORM private.work_enqueue('matchup-forecasts',date_trunc('minute',now())::text,now());
  END IF;
  RETURN jsonb_build_object('processed',processed,'remaining',EXISTS(SELECT 1 FROM private.forecast_refresh_requests WHERE available_at<=now())
    OR EXISTS(SELECT 1 FROM private.matchup_forecast_expiries WHERE available_at<=now()));
END;
$$;
