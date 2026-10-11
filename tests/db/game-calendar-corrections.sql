BEGIN;
DO $$
DECLARE
  v_player uuid := gen_random_uuid();
  v_game uuid := gen_random_uuid();
  v_stat player_game_stats%ROWTYPE;
BEGIN
  IF has_table_privilege('anon','public.game_calendar_corrections','SELECT')
     OR has_table_privilege('authenticated','public.game_calendar_corrections','INSERT') THEN
    RAISE EXCEPTION 'Internal correction ledger has client privileges';
  END IF;
  INSERT INTO players(id,first_name,last_name) VALUES(v_player,'Calendar','Player');
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
  VALUES(v_game,'0029900099',2199,1,'2198-10-01','XC1','XC2','Final');
  INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,game_date,points)
  VALUES(v_player,v_game,1900,77,'1900-01-01',30);
  SELECT * INTO v_stat FROM player_game_stats WHERE game_id=v_game;
  IF (v_stat.game_date,v_stat.season_year,v_stat.week_number) IS DISTINCT FROM ('2198-10-01'::date,2199,1) THEN
    RAISE EXCEPTION 'Inserted stats do not inherit the authoritative game calendar';
  END IF;
  UPDATE nba_games SET game_date='2198-10-08',week_number=2 WHERE id=v_game;
  SELECT * INTO v_stat FROM player_game_stats WHERE game_id=v_game;
  IF (v_stat.game_date,v_stat.season_year,v_stat.week_number) IS DISTINCT FROM ('2198-10-08'::date,2199,2)
     OR (SELECT count(*) FROM game_calendar_corrections WHERE game_id=v_game)<>2 THEN
    RAISE EXCEPTION 'Moved game did not update stats and invalidate both scoring dates';
  END IF;
  UPDATE player_game_stats SET game_date='2198-10-01',season_year=1900,week_number=1,points=31 WHERE game_id=v_game;
  SELECT * INTO v_stat FROM player_game_stats WHERE game_id=v_game;
  IF (v_stat.game_date,v_stat.season_year,v_stat.week_number,v_stat.points) IS DISTINCT FROM ('2198-10-08'::date,2199,2,31) THEN
    RAISE EXCEPTION 'A stale stat writer replaced the corrected game calendar';
  END IF;
  UPDATE nba_games SET game_date='2198-10-08',week_number=3 WHERE id=v_game;
  IF (SELECT count(*) FROM game_calendar_corrections WHERE game_id=v_game)<>2 THEN
    RAISE EXCEPTION 'Same-date correction duplicated the ledger';
  END IF;
  UPDATE nba_games SET game_date='2199-10-01',season_year=2200,week_number=1 WHERE id=v_game;
  IF NOT EXISTS(SELECT 1 FROM game_calendar_corrections WHERE game_id=v_game AND season_year=2199 AND game_date='2198-10-08')
     OR NOT EXISTS(SELECT 1 FROM game_calendar_corrections WHERE game_id=v_game AND season_year=2200 AND game_date='2199-10-01') THEN
    RAISE EXCEPTION 'Cross-season correction lost the previous scoring calendar';
  END IF;
END;
$$;
ROLLBACK;
