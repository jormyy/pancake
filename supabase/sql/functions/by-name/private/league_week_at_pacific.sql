CREATE OR REPLACE FUNCTION private.league_week_at_pacific(p_season_id uuid,p_reference_at timestamptz)
RETURNS int LANGUAGE sql STABLE SET search_path=public AS $$
  SELECT week.week_number FROM league_seasons season JOIN season_weeks week ON week.season_year=season.season_year
    WHERE season.id=p_season_id
      AND (p_reference_at AT TIME ZONE 'America/Los_Angeles')::date BETWEEN week.week_start AND week.week_end;
$$;
