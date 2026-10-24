CREATE OR REPLACE FUNCTION private.set_projection_period_end()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.projection_date IS NOT NULL THEN
    NEW.projection_period_end:=NEW.projection_date;
  ELSE
    SELECT date_trunc('week',week_start::timestamp)::date+6 INTO NEW.projection_period_end
      FROM public.season_weeks WHERE season_year=NEW.season_year AND week_number=NEW.week_number;
    NEW.projection_period_end:=COALESCE(NEW.projection_period_end,(NEW.started_at AT TIME ZONE 'America/Los_Angeles')::date);
  END IF;
  RETURN NEW;
END;
$$;
