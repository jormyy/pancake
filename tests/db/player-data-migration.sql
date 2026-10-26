BEGIN;
DROP TRIGGER player_career_guard ON public.players;
DROP TRIGGER career_stats_insert ON public.player_game_stats;
DROP TRIGGER career_stats_update ON public.player_game_stats;
DROP TRIGGER career_stats_delete ON public.player_game_stats;
DROP TRIGGER career_game_update ON public.nba_games;
ALTER TABLE public.players DROP COLUMN career_games_base,DROP COLUMN career_games_base_season,
  DROP COLUMN career_games_base_checked_at,DROP COLUMN career_games_base_attempted_at,DROP COLUMN career_games_base_source;
CREATE TEMP TABLE legacy_counts(id uuid PRIMARY KEY, games integer NOT NULL);
DO $$
DECLARE v_id uuid; v_game uuid; v_i integer; v_null_ids uuid[] := '{}'; v_legacy uuid;
BEGIN
  FOR v_i IN 1..6 LOOP
    INSERT INTO players(first_name,last_name,years_exp,career_regular_season_games,nba_id,nba_team)
      VALUES('Preserved',v_i::text,CASE WHEN v_i=1 THEN 6 ELSE 2 END,
        (ARRAY[331,155,211,172,69,100])[v_i],'base-legacy-'||v_i,'BOS') RETURNING id INTO v_id;
    INSERT INTO legacy_counts VALUES(v_id,(ARRAY[331,155,211,172,69,100])[v_i]);
    v_game:=gen_random_uuid();
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES(v_game,'002250'||lpad((6000+v_i)::text,4,'0'),2026,1,DATE '2025-12-01'+v_i,'BOS','LAL','Final');
    INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played,did_not_play)
      VALUES(v_id,v_game,2026,1,12,false);
  END LOOP;
  FOR v_i IN 1..5 LOOP
    INSERT INTO players(first_name,last_name,years_exp,nba_team)
      VALUES('Base fixture',v_i::text,(ARRAY[0,1,1,10,6])[v_i],'MIN') RETURNING id INTO v_id;
    v_null_ids:=array_append(v_null_ids,v_id);
  END LOOP;
  FOR v_i IN 1..65 LOOP
    v_game:=gen_random_uuid();
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES(v_game,'002250'||lpad((7000+v_i)::text,4,'0'),2026,1,DATE '2025-12-01'+v_i,'MIN','LAL','Final');
    INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played,did_not_play)
      VALUES(v_null_ids[4],v_game,2026,1,12,true);
    IF v_i=1 THEN
      INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played,did_not_play)
        VALUES(v_null_ids[2],v_game,2026,1,12,true),(v_null_ids[3],v_game,2026,1,12,false),(v_null_ids[5],v_game,2026,1,12,false);
    END IF;
  END LOOP;
  v_game:=gen_random_uuid();
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(v_game,'0022607800',2027,1,'2026-10-25','MIN','LAL','Final');
  INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played,did_not_play)
    VALUES(v_null_ids[1],v_game,2027,1,0,true),(v_null_ids[2],v_game,2027,1,12,true);
  UPDATE player_game_stats SET points=1 WHERE player_id=v_null_ids[1];
  INSERT INTO players(first_name,last_name,nba_id,nba_team) VALUES('Merged','Fixture','base-merge-nba','BOS') RETURNING id INTO v_id;
  INSERT INTO players(first_name,last_name,sleeper_id,nba_team,career_regular_season_games)
    VALUES('Merged','Fixture','base-merge-sleeper','BOS',331) RETURNING id INTO v_legacy;
  INSERT INTO legacy_counts VALUES(v_id,331);
END $$;
\ir ../../supabase/migrations/20261027000201_player_career_counter.sql
DO $$
BEGIN
  IF EXISTS(SELECT FROM legacy_counts c JOIN players p ON p.id=c.id
    WHERE p.career_regular_season_games IS DISTINCT FROM c.games) THEN
    RAISE EXCEPTION 'Migration changes an existing count or prevents its one-time ESPN base fetch';
  END IF;
  IF EXISTS(SELECT FROM legacy_counts c JOIN players p ON p.id=c.id WHERE p.career_games_base IS NOT NULL) THEN RAISE EXCEPTION 'Migration replaces a known count before its ESPN base fetch'; END IF;
  IF (SELECT count(*) FROM legacy_counts c JOIN players p ON p.id=c.id)<>7 THEN RAISE EXCEPTION 'Migration loses a count owner'; END IF;
  IF NOT EXISTS(SELECT FROM players WHERE first_name='Base fixture' AND last_name='1' AND career_games_base=0
    AND career_games_base_season=2026 AND career_games_base_source='rookie' AND career_regular_season_games=1) THEN RAISE EXCEPTION 'Rookie base excludes a real appearance'; END IF;
  IF NOT EXISTS(SELECT FROM players WHERE first_name='Base fixture' AND last_name='2' AND career_games_base=0
    AND career_games_base_season=2020 AND career_games_base_source='coverage' AND career_regular_season_games=2) THEN RAISE EXCEPTION 'Coverage misses the current season'; END IF;
  IF NOT EXISTS(SELECT FROM players WHERE first_name='Base fixture' AND last_name='3' AND career_games_base_source='coverage'
    AND career_regular_season_games=1) THEN RAISE EXCEPTION 'Coverage requires a current-season debut'; END IF;
  IF NOT EXISTS(SELECT FROM players WHERE first_name='Base fixture' AND last_name='4' AND career_games_base_source='threshold'
    AND career_regular_season_games=65) THEN RAISE EXCEPTION 'Threshold fallback misses positive DNP rows'; END IF;
  IF NOT EXISTS(SELECT FROM players WHERE first_name='Base fixture' AND last_name='5' AND career_games_base IS NULL
    AND career_regular_season_games IS NULL) THEN RAISE EXCEPTION 'Returning veteran gets a false zero base'; END IF;
END $$;
ROLLBACK;
SELECT 'migration keeps seven known counts and handles five missing-count groups: PASS';
