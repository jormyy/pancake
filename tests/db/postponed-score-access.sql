BEGIN;
CREATE TEMP TABLE score_access_checks(label text PRIMARY KEY);
INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(9003,1,'2026-01-10','2026-01-10');
INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_status_text)
VALUES ('002-availability-ppd',9003,1,'2026-01-10','BOS','MIA','Scheduled','PPD - postponed'),
 ('002-availability-live',9003,1,'2026-01-10','BOS','MIA','InProgress','Q4'),
 ('002-availability-scheduled',9003,1,'2026-01-10','BOS','MIA','Scheduled','7:30 PM ET'),
 ('002-availability-final',9003,1,'2026-01-10','BOS','MIA','Final','Final'),
 ('002-availability-cancelled',9003,1,'2026-01-10','BOS','MIA','Scheduled','Cancelled'),
 ('003-availability-playoff',9003,1,'2026-01-10','BOS','MIA','Final','Final'),
 ('001-availability-preseason',9003,1,'2026-01-10','BOS','MIA','Final','Final'),
 ('004-availability-playoff',9003,1,'2026-01-10','BOS','MIA','Final','Final'),
 ('availability-bbref-scheduled',9003,1,'2026-01-10','BOS','MIA','Scheduled','7:30 PM ET'),
 ('availability-bbref-live',9003,1,'2026-01-10','BOS','MIA','InProgress','Q4'),
 ('availability-bbref-final',9003,1,'2026-01-10','BOS','MIA','Final','Final'),
 ('availability-bbref-ppd',9003,1,'2026-01-10','BOS','MIA','Scheduled','PPD - postponed'),
 ('availability-bbref-cancelled',9003,1,'2026-01-10','BOS','MIA','Scheduled','Cancelled'),
 ('availability-bbref-suspended',9003,1,'2026-01-10','BOS','MIA','InProgress','Suspended');
DO $$
DECLARE original_revision bigint;
BEGIN
  SELECT revision INTO original_revision FROM private.score_input_revisions WHERE scope='nba:9003:1';
  UPDATE nba_games SET game_status_text='Q3 4:00' WHERE nba_game_id='002-availability-live';
  IF (SELECT revision FROM private.score_input_revisions WHERE scope='nba:9003:1')<>original_revision THEN
    RAISE EXCEPTION 'Display clock changes must not invalidate scoring';
  END IF;
  UPDATE nba_games SET game_status_text='7:30 PM ET' WHERE nba_game_id='002-availability-ppd';
  IF (SELECT revision FROM private.score_input_revisions WHERE scope='nba:9003:1')<>original_revision+1 THEN
    RAISE EXCEPTION 'Availability-only changes must invalidate score certification';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM get_score_sync_games('2026-01-10','2026-01-10',9003) WHERE nba_game_id='002-availability-ppd') THEN
    RAISE EXCEPTION 'Rescheduled games must re-enter score inputs';
  END IF;
  UPDATE nba_games SET game_status_text='PPD - postponed' WHERE nba_game_id='002-availability-ppd';
  INSERT INTO score_access_checks VALUES('display changes stay quiet'),('availability changes invalidate'),('rescheduled inputs return');
END;
$$;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  UPDATE nba_games SET game_status_text='Q4 2:30' WHERE nba_game_id='002-availability-live';
  IF (SELECT array_agg(nba_game_id ORDER BY nba_game_id) FROM get_score_sync_games('2026-01-10','2026-01-10',9003)) IS DISTINCT FROM
    ARRAY['002-availability-final','002-availability-live','002-availability-scheduled',
      'availability-bbref-final','availability-bbref-live','availability-bbref-scheduled'] THEN
    RAISE EXCEPTION 'Service must see available CDN and non-CDN regular games only';
  END IF;
  IF (SELECT count(*) FROM get_score_sync_games('2026-01-10','2026-01-10',9003)
      WHERE status='Final' AND stats_synced_at IS NULL)<>2 THEN
    RAISE EXCEPTION 'Both providers must expose final games without completion markers';
  END IF;
  UPDATE nba_games SET game_status_text='7:30 PM ET' WHERE nba_game_id='availability-bbref-ppd';
  IF NOT EXISTS(SELECT 1 FROM get_score_sync_games('2026-01-10','2026-01-10',9003)
      WHERE nba_game_id='availability-bbref-ppd') THEN
    RAISE EXCEPTION 'Rescheduled non-CDN games must re-enter score inputs';
  END IF;
  IF EXISTS(SELECT 1 FROM get_score_sync_games('2026-01-11','2026-01-11',9003)) THEN
    RAISE EXCEPTION 'Date scope leaks';
  END IF;
  IF EXISTS(SELECT 1 FROM get_score_sync_games('2026-01-10','2026-01-10',9004)) THEN
    RAISE EXCEPTION 'Season scope leaks';
  END IF;
END;
$$;
RESET ROLE;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I',role_name);
    BEGIN
      PERFORM get_score_sync_games('2026-01-10','2026-01-10');
      RAISE EXCEPTION 'Client bypasses the internal score input boundary';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
    INSERT INTO score_access_checks VALUES(role_name||' denied internal score inputs');
  END LOOP;
END;
$$;
SELECT count(*)+5 AS passed FROM score_access_checks;
ROLLBACK;
