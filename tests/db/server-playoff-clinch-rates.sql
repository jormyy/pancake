BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; pairs int[][]:=ARRAY[ARRAY[1,2,3,4],ARRAY[1,3,2,4],ARRAY[1,4,2,3]];
  outcomes int[][]:=ARRAY[ARRAY[1,0],ARRAY[0,1],ARRAY[0,1],ARRAY[2,0],ARRAY[0,2],ARRAY[1,0]];
  pair int[]; home int; away int; winner uuid; result int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(4,9540,'setup');
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
    SELECT 9540,n,date '2091-01-01'+(n-1)*7,date '2091-01-07'+(n-1)*7 FROM generate_series(1,9) n;
  INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    SELECT '002954000'||n,9540,n,date '2091-01-01'+(n-1)*7,'CLI','NCH','Scheduled' FROM generate_series(1,9) n;
  UPDATE leagues SET playoff_start_week=8,playoff_entrants=2,playoff_round_lengths=ARRAY[1] WHERE id=f.league_id;
  FOR week IN 1..7 LOOP
    FOR game IN 1..2 LOOP
      home:=pairs[(week-1)%3+1][game*2-1]; away:=pairs[(week-1)%3+1][game*2];
      result:=CASE WHEN week<=6 THEN outcomes[week][game] ELSE 0 END;
      winner:=CASE WHEN result=1 THEN f.member_ids[home] WHEN result=2 THEN f.member_ids[away] ELSE NULL END;
      INSERT INTO matchups(league_id,league_season_id,week_number,matchup_type,home_member_id,away_member_id,
        home_points,away_points,winner_member_id,is_finalized)
        VALUES(f.league_id,f.season_id,week,'regular_season',f.member_ids[home],f.member_ids[away],
          CASE WHEN result=2 THEN 0 ELSE 1 END,CASE WHEN result=1 THEN 0 ELSE 1 END,winner,week<=6);
    END LOOP;
  END LOOP;
  UPDATE leagues SET status='active' WHERE id=f.league_id;
  INSERT INTO standings(league_id,league_season_id,member_id,week_number,wins,losses,ties,waiver_priority)
    VALUES(f.league_id,f.season_id,f.member_ids[2],6,3,2,1,0);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM notification_outbox WHERE event_type='playoff_clinched'
    AND member_id=f.member_ids[2] AND data->>'leagueSeasonId'=f.season_id::text),
    'raw wins cannot clinch ahead of rivals whose ties keep their rate competitive');
  PERFORM pg_temp.check_rules((SELECT wins=3 AND ties=1 AND games_played=6 FROM private.playoff_seed_rankings(f.league_id,f.season_id,8)
    WHERE member_id=f.member_ids[2]),'seed ranking exposes the record used by clinch bounds');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
