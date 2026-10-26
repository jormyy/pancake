BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  v_names text[] := ARRAY['David Jones Garcia','Joan Beringer','Nic Claxton','Taelon Peter','Trevon Scott','Will Richard'];
  v_teams text[] := ARRAY['SAS','MIN','CHI','IND','BKN','GSW'];
  v_i int; v_a uuid; v_b uuid; v_game uuid := gen_random_uuid(); v_fixture record; v_trade uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_fixture FROM pg_temp.rules_fixture(2,2097,'offseason');
  INSERT INTO trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,status)
    VALUES(v_trade,v_fixture.league_id,v_fixture.season_id,v_fixture.member_ids[1],v_fixture.member_ids[2],'completed');
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(v_game,'0022600901',2027,1,'2026-10-25','SAS','MIN','Final');
  FOR v_i IN 1..6 LOOP
    INSERT INTO players(first_name,last_name,nba_id,nba_team) VALUES(split_part(v_names[v_i],' ',1),
      substr(v_names[v_i],strpos(v_names[v_i],' ')+1),'data-nba-'||v_i,v_teams[v_i]) RETURNING id INTO v_a;
    INSERT INTO players(first_name,last_name,sleeper_id,espn_id,nba_team) VALUES(split_part(v_names[v_i],' ',1),
      CASE WHEN v_i=1 THEN 'Jones-Garcia' ELSE substr(v_names[v_i],strpos(v_names[v_i],' ')+1) END,
      'data-sleeper-'||v_i,'data-espn-'||v_i,v_teams[v_i]) RETURNING id INTO v_b;
    INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played,did_not_play)
      VALUES(v_a,v_game,2027,1,12,false);
    INSERT INTO player_projections(player_id,season_year,week_number,projected_points) VALUES(v_b,2027,1,15);
    INSERT INTO dynasty_rankings(source,source_rank,source_player_name,player_id)
      VALUES('data-merge',v_i,v_names[v_i],v_b);
    INSERT INTO player_watches(league_id,member_id,player_id) VALUES(v_fixture.league_id,v_fixture.member_ids[1],v_b);
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      VALUES(v_fixture.league_id,v_fixture.season_id,v_fixture.member_ids[1],v_b,'draft');
    INSERT INTO trade_items(trade_id,league_id,side,player_id,from_member_id,to_member_id)
      VALUES(v_trade,v_fixture.league_id,'proposer',v_b,v_fixture.member_ids[1],v_fixture.member_ids[2]);
    INSERT INTO waiver_claims(league_id,league_season_id,member_id,player_id,priority_at_submission,process_date,status)
      VALUES(v_fixture.league_id,v_fixture.season_id,v_fixture.member_ids[2],v_b,1,current_date,'succeeded');
    IF v_i=1 THEN
      INSERT INTO players(first_name,last_name,sportsdata_id,nba_team) VALUES('David','Jones-Garcia',900002,'SA');
    END IF;
  END LOOP;
  INSERT INTO players(first_name,last_name,nba_id,nba_team) VALUES('Conflict','Fixture','data-conflict-a','MIN'),('Conflict','Fixture','data-conflict-b','MIN');
  INSERT INTO players(first_name,last_name,nba_id,nba_team) VALUES('Different','Fixture','data-team-a','MIN');
  INSERT INTO players(first_name,last_name,sleeper_id,nba_team) VALUES('Different','Fixture','data-team-b','BOS');
  PERFORM merge_duplicate_players();
  FOR v_i IN 1..6 LOOP
    IF (SELECT count(*) FROM players WHERE nba_id='data-nba-'||v_i OR sleeper_id='data-sleeper-'||v_i) <> 1 THEN
      RAISE EXCEPTION 'Production duplicate pattern % did not merge',v_names[v_i];
    END IF;
    SELECT id INTO STRICT v_a FROM players WHERE nba_id='data-nba-'||v_i AND sleeper_id='data-sleeper-'||v_i AND espn_id='data-espn-'||v_i;
    IF NOT EXISTS(SELECT FROM player_game_stats WHERE player_id=v_a) OR NOT EXISTS(SELECT FROM player_projections WHERE player_id=v_a) THEN
      RAISE EXCEPTION 'Merge loses stats or projections';
    END IF;
    IF NOT EXISTS(SELECT FROM dynasty_rankings WHERE source='data-merge' AND source_rank=v_i AND player_id=v_a)
      OR NOT EXISTS(SELECT FROM player_watches WHERE player_id=v_a AND member_id=v_fixture.member_ids[1])
      OR NOT EXISTS(SELECT FROM roster_players WHERE player_id=v_a AND member_id=v_fixture.member_ids[1])
      OR NOT EXISTS(SELECT FROM trade_items WHERE player_id=v_a AND trade_id=v_trade)
      OR NOT EXISTS(SELECT FROM waiver_claims WHERE player_id=v_a AND member_id=v_fixture.member_ids[2]) THEN
      RAISE EXCEPTION 'Merge loses rankings, watches, roster, trade, or claim references';
    END IF;
    IF v_i=1 AND NOT EXISTS(SELECT FROM players WHERE id=v_a AND sportsdata_id='900002') THEN RAISE EXCEPTION 'Merge loses legacy source'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM players WHERE first_name IN ('Conflict','Different')) <> 4 THEN RAISE EXCEPTION 'Unsafe merge'; END IF;
END $$;
ROLLBACK;
SELECT 'player data merges: 6 production patterns and 2 near misses PASS';
