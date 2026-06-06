CREATE OR REPLACE FUNCTION private.prevent_active_over_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF NEW.status = 'active'::league_status
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM 1
      FROM league_seasons AS season
      JOIN league_members AS member
        ON member.league_id = NEW.id
      LEFT JOIN roster_players AS roster
        ON roster.league_id = NEW.id
       AND roster.league_season_id = season.id
       AND roster.member_id = member.id
       AND roster.is_on_ir = false
       AND roster.is_on_taxi = false
     WHERE season.league_id = NEW.id
       AND season.is_current = true
     GROUP BY member.id
    HAVING count(roster.id) > NEW.roster_size
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'League cannot become active while a roster exceeds the active roster cap.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_active_over_cap ON public.leagues;
CREATE TRIGGER prevent_active_over_cap
  BEFORE UPDATE OF status ON public.leagues
  FOR EACH ROW
  EXECUTE FUNCTION private.prevent_active_over_cap();
