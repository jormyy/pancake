BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_id uuid; v_other uuid; v_result jsonb; v_game uuid := gen_random_uuid();
BEGIN
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(v_game,'0022600900',2027,1,'2026-10-25','SAS','MIN','Scheduled');
  INSERT INTO players(first_name,last_name,nba_id,nba_team)
    VALUES('David','Jones Garcia','data-nba-jones','SAS') RETURNING id INTO v_id;
  v_result := resolve_player_imports_atomic(p_source=>'sleeper',p_records=>jsonb_build_array(jsonb_build_object(
    'provider_id','data-sleeper-jones','first_name','David','last_name','Jones-Garcia','metadata',jsonb_build_object('nba_team','SA','years_exp',1))));
  IF (v_result->'results'->0->>'player_id')::uuid IS DISTINCT FROM v_id THEN
    RAISE EXCEPTION 'Sleeper forks a unique normalized name and team match';
  END IF;
  INSERT INTO players(first_name,last_name,sportsdata_id,nba_team)
    VALUES('Legacy','Jones-Garcia',900001,'SA') RETURNING id INTO v_other;
  v_result := resolve_player_imports_atomic(p_source=>'nba_cdn',p_records=>jsonb_build_array(jsonb_build_object(
    'provider_id','data-nba-legacy','display_name','Legacy Jones Garcia','nba_game_id','0022600900','nba_team','SAS')));
  IF (v_result->'results'->0->>'player_id')::uuid IS DISTINCT FROM v_other THEN
    RAISE EXCEPTION 'Box score forks a unique legacy name and team match';
  END IF;
  v_result := resolve_player_imports_atomic('sleeper',jsonb_build_array(jsonb_build_object(
    'provider_id','data-other-team','first_name','Legacy','last_name','Jones Garcia','metadata',jsonb_build_object('nba_team','MIN'))));
  IF (v_result->'results'->0->>'player_id')::uuid = v_other THEN RAISE EXCEPTION 'Different teams link by name'; END IF;
  INSERT INTO players(first_name,last_name,nba_team,sleeper_id) VALUES('Choose','Fixture','MIN','data-already-owned');
  INSERT INTO players(first_name,last_name,nba_team,nba_id) VALUES('Choose','Fixture','MIN','data-unclaimed-nba') RETURNING id INTO v_other;
  v_result := resolve_player_imports_atomic('sleeper',jsonb_build_array(jsonb_build_object(
    'provider_id','data-choose-new','first_name','Choose','last_name','Fixture','metadata',jsonb_build_object('nba_team','MIN'))));
  IF (v_result->'results'->0->>'player_id')::uuid IS DISTINCT FROM v_other THEN
    RAISE EXCEPTION 'Importer ignores the sole candidate with an unclaimed source ID';
  END IF;
  INSERT INTO players(first_name,last_name,nba_team) VALUES('Shared','Fixture','MIN'),('Shared','Fixture','MIN');
  v_result := resolve_player_imports_atomic('sleeper',jsonb_build_array(jsonb_build_object(
    'provider_id','data-ambiguous','first_name','Shared','last_name','Fixture','metadata',jsonb_build_object('nba_team','MIN'))));
  IF v_result->'results'->0->>'action' <> 'ambiguous' OR EXISTS(SELECT FROM players WHERE sleeper_id='data-ambiguous') THEN
    RAISE EXCEPTION 'Ambiguous identity creates a player';
  END IF;
END $$;
ROLLBACK;
SELECT 'player data identity: 5 cases PASS';
