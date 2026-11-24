BEGIN;
CREATE TEMP TABLE parity_case(label text, player_id uuid) ON COMMIT DROP;

INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions,years_exp) VALUES
('00000000-0000-0000-0000-00005a090101','Stats','Mover','QOL','PG',ARRAY['PG'],3),
('00000000-0000-0000-0000-00005a090102','Member','Mover','QOM','SG',ARRAY['SG'],3),
('00000000-0000-0000-0000-00005a090103','Final','Today','QFT','SF',ARRAY['SF'],3),
('00000000-0000-0000-0000-00005a090104','Later','Today','QLT','PF',ARRAY['PF'],3),
('00000000-0000-0000-0000-00005a090105','Postponed','Today','QPP','C',ARRAY['C'],3),
('00000000-0000-0000-0000-00005a090106','No','Team',NULL,'PG',ARRAY['PG'],3),
('00000000-0000-0000-0000-00005a090107','Stats','Sitter','QSO','SG',ARRAY['SG'],3);

INSERT INTO nba_games(id,week_number,season_year,game_date,home_team,away_team,status,game_time)
SELECT id::uuid,1,2105,(now() AT TIME ZONE 'America/New_York')::date,home,away,status,now()+tip
FROM (VALUES
  ('00000000-0000-0000-0000-00005a090201','QNW','QX1','InProgress',interval '-1 hour'),
  ('00000000-0000-0000-0000-00005a090202','QOL','QX2','Scheduled',interval '3 hours'),
  ('00000000-0000-0000-0000-00005a090203','QOM','QX3','InProgress',interval '-1 hour'),
  ('00000000-0000-0000-0000-00005a090204','QNM','QX4','Scheduled',interval '3 hours'),
  ('00000000-0000-0000-0000-00005a090205','QFT','QX5','Final',interval '-4 hours'),
  ('00000000-0000-0000-0000-00005a090206','QLT','QX6','Scheduled',interval '5 hours'),
  ('00000000-0000-0000-0000-00005a090207','QPP','QX7','Postponed',interval '2 hours'),
  ('00000000-0000-0000-0000-00005a090208','QSO','QX8','InProgress',interval '-1 hour'),
  ('00000000-0000-0000-0000-00005a090209','QSN','QX9','Scheduled',interval '3 hours')
) AS fixture(id,home,away,status,tip);

INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,points) VALUES
('00000000-0000-0000-0000-00005a090101','00000000-0000-0000-0000-00005a090201',2105,1,12),
('00000000-0000-0000-0000-00005a090107','00000000-0000-0000-0000-00005a090209',2105,1,0);

INSERT INTO parity_case VALUES
('traded player whose stats row is on his new team''s started game','00000000-0000-0000-0000-00005a090101'),
('player whose stats row is on a later game while his listed team tipped off','00000000-0000-0000-0000-00005a090107'),
('player whose team''s game is final today','00000000-0000-0000-0000-00005a090103'),
('player whose team tips off later today','00000000-0000-0000-0000-00005a090104'),
('player whose team''s game is postponed','00000000-0000-0000-0000-00005a090105'),
('player with no NBA team','00000000-0000-0000-0000-00005a090106');

DO $$
BEGIN
  IF to_regclass('private.player_game_memberships') IS NOT NULL THEN
    EXECUTE $sql$INSERT INTO private.player_game_memberships(player_id,game_id,nba_team)
      VALUES ('00000000-0000-0000-0000-00005a090102','00000000-0000-0000-0000-00005a090204','QNM')$sql$;
    INSERT INTO parity_case VALUES
      ('traded player whose membership is on his new team''s later game while his old team tipped off','00000000-0000-0000-0000-00005a090102');
  END IF;
END;
$$;

DO $$
DECLARE c record; lineup boolean; roster boolean; failures text[] := '{}';
BEGIN
  FOR c IN SELECT * FROM parity_case ORDER BY label LOOP
    lineup := private.lineup_game_started(c.player_id, (now() AT TIME ZONE 'America/New_York')::date);
    roster := private.roster_status_game_started(c.player_id);
    IF lineup IS DISTINCT FROM roster THEN
      failures := failures || format('%s: lineup lock %s, roster lock %s', c.label, lineup, roster);
    END IF;
  END LOOP;
  IF cardinality(failures) > 0 THEN
    RAISE EXCEPTION 'Game-started predicates disagree. Decide game locks only in private.player_game_started: %', array_to_string(failures, '; ');
  END IF;
  RAISE NOTICE 'game lock parity holds for % fixtures', (SELECT count(*) FROM parity_case);
END;
$$;

ROLLBACK;
