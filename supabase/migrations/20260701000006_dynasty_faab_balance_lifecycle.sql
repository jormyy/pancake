-- Dynasty transactions/trade release: seed/reset FAAB balances for new members and seasons.

CREATE OR REPLACE FUNCTION private.seed_faab_balances_for_member()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  INSERT INTO faab_balances (
    league_id,
    league_season_id,
    member_id,
    balance
  )
  SELECT
    NEW.league_id,
    season.id,
    NEW.id,
    league.faab_starting_budget
  FROM league_seasons AS season
  JOIN leagues AS league ON league.id = season.league_id
  WHERE season.league_id = NEW.league_id
    AND season.is_current = true
  ON CONFLICT (league_id, league_season_id, member_id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.seed_faab_balances_for_season()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  INSERT INTO faab_balances (
    league_id,
    league_season_id,
    member_id,
    balance
  )
  SELECT
    NEW.league_id,
    NEW.id,
    member.id,
    league.faab_starting_budget
  FROM league_members AS member
  JOIN leagues AS league ON league.id = member.league_id
  WHERE member.league_id = NEW.league_id
  ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
     SET balance = EXCLUDED.balance,
         updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS seed_faab_balances_for_member ON public.league_members;
CREATE TRIGGER seed_faab_balances_for_member
  AFTER INSERT ON public.league_members
  FOR EACH ROW
  EXECUTE FUNCTION private.seed_faab_balances_for_member();

DROP TRIGGER IF EXISTS seed_faab_balances_for_season ON public.league_seasons;
CREATE TRIGGER seed_faab_balances_for_season
  AFTER INSERT ON public.league_seasons
  FOR EACH ROW
  EXECUTE FUNCTION private.seed_faab_balances_for_season();

SELECT private.ensure_season_faab_balances(season.league_id, season.id)
FROM public.league_seasons AS season
WHERE season.is_current = true;
