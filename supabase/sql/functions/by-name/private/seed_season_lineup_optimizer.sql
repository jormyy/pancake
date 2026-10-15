CREATE OR REPLACE FUNCTION private.seed_season_lineup_optimizer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.lineup_optimizer_settings
    (league_id, league_season_id, member_id, enabled, enabled_at)
  SELECT NEW.league_id, NEW.id, member.id, COALESCE(previous.enabled, true),
    CASE WHEN COALESCE(previous.enabled, true) THEN now() ELSE NULL END
  FROM public.league_members AS member
  LEFT JOIN LATERAL (
    SELECT settings.enabled
    FROM public.lineup_optimizer_settings AS settings
    JOIN public.league_seasons AS season ON season.id = settings.league_season_id
    WHERE settings.member_id = member.id AND season.season_year < NEW.season_year
    ORDER BY season.season_year DESC
    LIMIT 1
  ) AS previous ON true
  WHERE member.league_id = NEW.league_id
  ON CONFLICT (league_id, league_season_id, member_id) DO NOTHING;
  RETURN NEW;
END;
$$;
