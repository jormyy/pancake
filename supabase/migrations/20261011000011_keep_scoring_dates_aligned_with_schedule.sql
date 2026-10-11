CREATE TABLE public.game_calendar_corrections (
  game_id uuid NOT NULL REFERENCES public.nba_games(id) ON DELETE CASCADE,
  season_year integer NOT NULL,
  game_date date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(game_id, season_year, game_date)
);
ALTER TABLE public.game_calendar_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.game_calendar_corrections FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.game_calendar_corrections TO service_role;
CREATE INDEX game_calendar_corrections_recent
  ON public.game_calendar_corrections(season_year, updated_at);

CREATE OR REPLACE FUNCTION set_pgs_game_date()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  SELECT game_date, season_year, week_number
    INTO NEW.game_date, NEW.season_year, NEW.week_number
    FROM nba_games WHERE id = NEW.game_id FOR SHARE;
  RETURN NEW;
END;
$$;

DROP TRIGGER trg_pgs_game_date ON public.player_game_stats;
CREATE TRIGGER trg_pgs_game_date
  BEFORE INSERT OR UPDATE ON public.player_game_stats
  FOR EACH ROW EXECUTE FUNCTION public.set_pgs_game_date();

CREATE OR REPLACE FUNCTION private.sync_game_calendar_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM player_game_stats WHERE game_id = NEW.id) THEN
    INSERT INTO game_calendar_corrections(game_id, season_year, game_date, updated_at)
    SELECT DISTINCT NEW.id, calendar.season_year, calendar.game_date, now()
      FROM (VALUES(OLD.season_year, OLD.game_date),
                  (NEW.season_year, NEW.game_date)) AS calendar(season_year, game_date)
    ON CONFLICT(game_id, season_year, game_date)
    DO UPDATE SET updated_at = EXCLUDED.updated_at;

    UPDATE player_game_stats
       SET game_date = NEW.game_date, season_year = NEW.season_year,
           week_number = NEW.week_number, updated_at = now()
     WHERE game_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.sync_game_calendar_correction() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER sync_game_calendar_correction
  AFTER UPDATE OF game_date, season_year, week_number ON public.nba_games
  FOR EACH ROW
  WHEN (OLD.game_date IS DISTINCT FROM NEW.game_date
     OR OLD.season_year IS DISTINCT FROM NEW.season_year
     OR OLD.week_number IS DISTINCT FROM NEW.week_number)
  EXECUTE FUNCTION private.sync_game_calendar_correction();

-- Preserve both sides of existing corrections before repairing copied dates.
INSERT INTO public.game_calendar_corrections(game_id, season_year, game_date)
SELECT DISTINCT stats.game_id, stats.season_year, stats.game_date
  FROM public.player_game_stats stats JOIN public.nba_games game ON game.id=stats.game_id
 WHERE stats.game_date IS NOT NULL AND (stats.game_date,stats.season_year,stats.week_number)
       IS DISTINCT FROM (game.game_date,game.season_year,game.week_number)
ON CONFLICT(game_id,season_year,game_date) DO UPDATE SET updated_at=now();
UPDATE public.player_game_stats stats
   SET game_date=game.game_date,season_year=game.season_year,week_number=game.week_number,updated_at=now()
  FROM public.nba_games game
 WHERE game.id=stats.game_id AND (stats.game_date,stats.season_year,stats.week_number)
       IS DISTINCT FROM (game.game_date,game.season_year,game.week_number);
