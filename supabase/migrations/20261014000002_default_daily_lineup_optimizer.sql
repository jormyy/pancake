BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE public.league_members, public.league_seasons,
  public.lineup_optimizer_settings IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.lineup_optimizer_settings ALTER COLUMN enabled SET DEFAULT true;

CREATE OR REPLACE FUNCTION private.seed_member_lineup_optimizer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.lineup_optimizer_settings
    (league_id, league_season_id, member_id, enabled_at)
  SELECT NEW.league_id, season.id, NEW.id, now()
  FROM public.league_seasons AS season
  WHERE season.league_id = NEW.league_id AND season.is_current
  ON CONFLICT (league_id, league_season_id, member_id) DO NOTHING;
  RETURN NEW;
END;
$$;

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

REVOKE ALL ON FUNCTION private.seed_member_lineup_optimizer() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.seed_season_lineup_optimizer() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER seed_member_lineup_optimizer
AFTER INSERT ON public.league_members
FOR EACH ROW EXECUTE FUNCTION private.seed_member_lineup_optimizer();

CREATE TRIGGER seed_season_lineup_optimizer
AFTER INSERT OR UPDATE OF is_current ON public.league_seasons
FOR EACH ROW WHEN (NEW.is_current)
EXECUTE FUNCTION private.seed_season_lineup_optimizer();

INSERT INTO public.lineup_optimizer_settings
  (league_id, league_season_id, member_id, enabled, enabled_at)
SELECT member.league_id, season.id, member.id, true, now()
FROM public.league_members AS member
JOIN public.league_seasons AS season ON season.league_id = member.league_id AND season.is_current
ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
SET enabled = true, enabled_at = COALESCE(lineup_optimizer_settings.enabled_at, EXCLUDED.enabled_at)
WHERE NOT lineup_optimizer_settings.enabled;

COMMIT;
