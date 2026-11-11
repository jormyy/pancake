CREATE OR REPLACE FUNCTION private.guard_trade_pick_years()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='250ms' AS $$
DECLARE league uuid; document jsonb; location text[]; pick jsonb; year integer;
BEGIN
  IF TG_TABLE_NAME='trade_estimate_quotes' THEN
    league:=NEW.league_id;
    document:=jsonb_build_object('inputs',NEW.inputs);
  ELSE
    SELECT league_id INTO STRICT league FROM public.trades WHERE id=NEW.trade_id;
    document:=NEW.snapshot;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('draft-pick-calendar-years:'||league::text,0));
  FOR location IN SELECT ARRAY['inputs','picks'] UNION ALL SELECT ARRAY['quote','inputs','picks'] LOOP
    IF document#>location IS NULL THEN CONTINUE; END IF;
    IF jsonb_typeof(document#>location) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Draft pick years changed. Refresh the trade estimate and try again.' USING ERRCODE='22023';
    END IF;
    FOR pick IN SELECT value FROM jsonb_array_elements(document#>location) LOOP
      SELECT season_year INTO year FROM public.draft_picks
        WHERE id::text=pick->>'id' AND league_id=league FOR SHARE;
      IF NOT FOUND OR jsonb_typeof(pick->'seasonYear') IS DISTINCT FROM 'number'
        OR pick->>'seasonYear' IS DISTINCT FROM year::text THEN
        RAISE EXCEPTION 'Draft pick years changed. Refresh the trade estimate and try again.' USING ERRCODE='22023';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NEW;
END;
$$;
