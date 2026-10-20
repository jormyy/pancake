BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_id uuid;
  v_game uuid := gen_random_uuid();
  v_result jsonb;
  v_before text;
  v_other uuid;
BEGIN
  SELECT id INTO v_id FROM players WHERE nba_id='1641794';
  IF v_id IS NULL THEN
    INSERT INTO players(first_name,last_name,nba_id) VALUES('Dillon','Jones','1641794') RETURNING id INTO v_id;
  END IF;
  INSERT INTO nba_games(id,nba_game_id,season_year,game_date,home_team,away_team,status,week_number)
    VALUES(v_game,'002-identity-control-'||v_game,1900,'1900-01-01','NYK','BKN','Final',1);
  INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,game_date,points)
    VALUES(v_id,v_game,1900,1,'1900-01-01',17);
  SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) INTO v_before FROM player_game_stats s WHERE player_id=v_id;
  v_result := resolve_player_imports_atomic('nba_cdn','[{"provider_id":"196295686","display_name":"Dillon Jones"}]');
  IF (v_result->'results'->0->>'player_id')::uuid <> v_id THEN RAISE EXCEPTION 'The reviewed source ID forked its canonical player'; END IF;
  IF (SELECT nba_id FROM players WHERE id=v_id) <> '1641794' THEN RAISE EXCEPTION 'Canonical identity changed'; END IF;
  UPDATE players SET nba_id='196295686' WHERE id=v_id;
  v_result := resolve_player_imports_atomic('nba_cdn','[{"provider_id":"1641794","display_name":"Dillon Jones"}]');
  IF (v_result->'results'->0->>'player_id')::uuid <> v_id OR (SELECT nba_id FROM players WHERE id=v_id) <> '1641794' THEN
    RAISE EXCEPTION 'Existing alternate identity was not repaired in place';
  END IF;
  IF (SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM player_game_stats s WHERE player_id=v_id) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'Identity correction changed game history';
  END IF;
  BEGIN
    PERFORM resolve_player_imports_atomic('nba_cdn','[{"provider_id":"196295686","display_name":"Different Person"}]');
    RAISE EXCEPTION 'An unverified source name was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM resolve_player_imports_atomic('nba_cdn','[{"provider_id":"unverified-dillon","display_name":"Dillon Jones"}]');
    RAISE EXCEPTION 'An unverified source ID was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO players(first_name,last_name,nba_id) VALUES('Dillon','Jones','196295686') RETURNING id INTO v_other;
  BEGIN
    PERFORM resolve_player_imports_atomic('nba_cdn','[{"provider_id":"196295686","display_name":"Dillon Jones"}]');
    RAISE EXCEPTION 'Two existing owners were silently merged';
  EXCEPTION WHEN check_violation THEN NULL; END;
  IF NOT EXISTS(SELECT FROM players WHERE id=v_other AND nba_id='196295686') THEN RAISE EXCEPTION 'Conflicting history was deleted'; END IF;
END;
$$;
ROLLBACK;
