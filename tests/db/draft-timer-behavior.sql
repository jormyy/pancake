BEGIN;
CREATE FUNCTION pg_temp.assert_true(value boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION '%',label; END IF; END;
$$;
CREATE FUNCTION pg_temp.draft_timer_fail_second() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Synthetic opening-night second pick failure'; END;
$$;
DO $$
DECLARE
  v_users uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  v_members uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_draft uuid;
  v_pick uuid;
  v_warning jsonb;
  v_cutoff timestamptz;
  v_at timestamptz;
  v_seconds int;
  v_count int;
  v_mode text;
  v_result record;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data) SELECT id,'authenticated','authenticated',id||'@example.test','{}' FROM unnest(v_users)id;
  INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,playoff_entrants,playoff_round_lengths)
    VALUES(v_league,'Synthetic timer behavior',v_league::text,v_users[1],'offseason',10,2,ARRAY[1]);
  INSERT INTO league_seasons(id,league_id,season_year,is_current,skipped_weeks) VALUES(v_season,v_league,2189,true,ARRAY[1]);
  INSERT INTO league_members(id,league_id,user_id,role) VALUES(v_members[1],v_league,v_users[1],'commissioner'),(v_members[2],v_league,v_users[2],'manager');
  INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
    SELECT v_league,2189,r,m,m FROM unnest(v_members)m CROSS JOIN generate_series(1,3)r;
  INSERT INTO players(first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
    SELECT 'Synthetic timer',gen_random_uuid()::text,'PG',ARRAY['PG'],0,n FROM generate_series(1,12)n;
  PERFORM pg_sleep(1.1);
  FOREACH v_seconds IN ARRAY ARRAY[60,604800] LOOP
    v_at := clock_timestamp();
    v_draft := (start_rookie_draft_atomic(v_league,1,true,v_seconds)->>'id')::uuid;
    PERFORM pg_temp.assert_true((SELECT extract(epoch FROM min(timer_expires_at)-v_at) BETWEEN v_seconds-0.1 AND v_seconds+1 FROM snake_draft_picks WHERE draft_id=v_draft),'Initial timer arms with the full duration');
    PERFORM pause_draft_atomic(v_draft);
    PERFORM pg_temp.assert_true((SELECT timer_paused_remaining_seconds=v_seconds FROM drafts WHERE id=v_draft),'A seven-day pause remains in the database');
    PERFORM resume_draft_atomic(v_draft);
    v_at := clock_timestamp();
    PERFORM reset_draft_atomic(v_draft);
    PERFORM pg_temp.assert_true((SELECT extract(epoch FROM min(timer_expires_at)-v_at) BETWEEN v_seconds-0.1 AND v_seconds+1 FROM snake_draft_picks WHERE draft_id=v_draft),'Reset arms with the full configured duration');
    PERFORM make_snake_pick_atomic(v_draft,(SELECT member_id FROM snake_draft_picks WHERE draft_id=v_draft AND overall_pick=1),(SELECT id FROM players WHERE years_exp=0 AND nba_draft_number IS NOT NULL ORDER BY nba_draft_number,id LIMIT 1));
    PERFORM pg_temp.assert_true((SELECT extract(epoch FROM min(timer_expires_at)-clock_timestamp()) BETWEEN v_seconds-1 AND v_seconds+1 FROM snake_draft_picks WHERE draft_id=v_draft),'A manual pick arms the next configured duration');
    UPDATE drafts SET status='cancelled' WHERE id=v_draft;
  END LOOP;
  FOREACH v_seconds IN ARRAY ARRAY[59,604801] LOOP
    BEGIN
      INSERT INTO drafts(league_id,league_season_id,draft_type,is_mock,pick_timer_seconds) VALUES(v_league,v_season,'snake',true,v_seconds);
      RAISE EXCEPTION 'Storage accepts an invalid timer';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  INSERT INTO drafts(league_id,league_season_id,draft_type,is_mock,pick_timer_seconds) VALUES(v_league,v_season,'auction',true,5),(v_league,v_season,'auction',true,3600);
  BEGIN
    INSERT INTO drafts(league_id,league_season_id,draft_type,is_mock,pick_timer_seconds) VALUES(v_league,v_season,'auction',true,3601);
    RAISE EXCEPTION 'Auction range expands';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  v_warning := draft_timer_start_warning(v_league,3,604800);
  PERFORM pg_temp.assert_true(v_warning->>'code'='opening_night_unpublished','An unpublished schedule has an explicit warning');
  PERFORM pg_temp.assert_true((v_warning->>'remainingPicks')::int=6,'Warning counts all rounds and managers');
  PERFORM pg_temp.assert_true(extract(epoch FROM (v_warning->>'estimatedFinishAt')::timestamptz-clock_timestamp()) BETWEEN 3628798 AND 3628801,'Warning multiplies remaining picks by the timer');
  INSERT INTO nba_games(season_year,nba_game_id,game_date,week_number,home_team,away_team,status) VALUES
    (2189,'0018900001','2189-10-01',1,'BOS','NYK','Scheduled'),
    (2189,'0038900001','2189-10-02',1,'BOS','NYK','Scheduled'),
    (2189,'0048900001','2189-10-03',1,'BOS','NYK','Scheduled'),
    (2189,'0058900001','2189-10-04',1,'BOS','NYK','Scheduled'),
    (2189,'0068900001','2189-10-05',1,'BOS','NYK','Scheduled'),
    (2189,'0028900001','2189-10-20',1,'BOS','NYK','Scheduled'),
    (2189,'0028900002','2189-10-20',1,'LAL','GSW','Scheduled');
  v_cutoff := private.draft_timer_opening_night_cutoff(2189);
  PERFORM pg_temp.assert_true(v_cutoff='2189-10-20 13:00:00+00','Opening day includes a two-game week and excludes exhibitions and Cup final');
  v_warning := draft_timer_start_warning(v_league,3,60);
  PERFORM pg_temp.assert_true(v_warning->>'code' IS NULL,'A short draft before published opening night has no warning');
  UPDATE nba_games SET game_date=(clock_timestamp() AT TIME ZONE 'America/New_York')::date WHERE season_year=2189 AND nba_game_id LIKE '002%';
  v_warning := draft_timer_start_warning(v_league,3,604800);
  PERFORM pg_temp.assert_true(v_warning->>'code'='opening_night_overrun','A long draft warns before opening night');
  UPDATE nba_games SET game_date='2189-10-20' WHERE season_year=2189 AND nba_game_id LIKE '002%';
  FOREACH v_mode IN ARRAY ARRAY['auto_pick','skip_pick','pause_draft','commissioner_pick'] LOOP
    UPDATE leagues SET status='offseason' WHERE id=v_league;
    UPDATE draft_picks SET is_used=false,used_at=NULL,rookie_draft_id=NULL WHERE league_id=v_league;
    v_draft := (start_rookie_draft_atomic(v_league,1,false,604800,v_mode)->>'id')::uuid;
    SELECT id INTO v_pick FROM snake_draft_picks WHERE draft_id=v_draft ORDER BY overall_pick LIMIT 1;
    IF v_mode='commissioner_pick' THEN
      UPDATE snake_draft_picks SET timer_expires_at=clock_timestamp()-interval '1 second' WHERE id=v_pick;
      PERFORM * FROM process_expired_snake_pick_atomic(v_draft);
      PERFORM pg_temp.assert_true((SELECT pause_reason='timer_expired_commissioner_pick' AND timer_paused_remaining_seconds IS NULL FROM drafts WHERE id=v_draft),'Commissioner expiry waits without a deadline');
    ELSE
      PERFORM pause_draft_atomic(v_draft);
    END IF;
    SELECT count(*) INTO v_count FROM private.draft_timer_complete_opening_night(100,v_cutoff-interval '1 microsecond');
    PERFORM pg_temp.assert_true(v_count=0,'Opening-night completion never fires early');
    SELECT count(*) INTO v_count FROM private.draft_timer_complete_opening_night(100,v_cutoff);
    PERFORM pg_temp.assert_true(v_count=2,'At the cutoff every unfinished pick is auto-picked despite a paused draft and skipped week one');
    PERFORM pg_temp.assert_true((SELECT status='completed' AND paused_at IS NULL AND pause_reason IS NULL AND timer_paused_remaining_seconds IS NULL FROM drafts WHERE id=v_draft),'Completion preserves the notification state contract');
    PERFORM pg_temp.assert_true((SELECT count(*)=2 AND bool_and(picked_at IS NOT NULL AND timer_expires_at IS NULL AND skipped_at IS NULL) FROM snake_draft_picks WHERE draft_id=v_draft),'Opening-night picks are picks, not skips');
    PERFORM pg_temp.assert_true((SELECT count(*)=2 FROM draft_audit_logs WHERE draft_id=v_draft AND action='auto_pick' AND metadata->>'reason'='season_boundary_backstop'),'Opening-night completion uses the existing best-available auto-pick path');
    SELECT count(*) INTO v_count FROM private.draft_timer_complete_opening_night(100,v_cutoff);
    PERFORM pg_temp.assert_true(v_count=0,'Opening-night retries cannot duplicate picks');
    UPDATE draft_picks SET rookie_draft_id=NULL WHERE league_id=v_league;
    DELETE FROM drafts WHERE id=v_draft;
  END LOOP;
  UPDATE leagues SET status='offseason' WHERE id=v_league;
  UPDATE draft_picks SET is_used=false,used_at=NULL,rookie_draft_id=NULL WHERE league_id=v_league;
  v_draft := (start_rookie_draft_atomic(v_league,1,false,604800,'commissioner_pick')->>'id')::uuid;
  PERFORM pause_draft_atomic(v_draft);
  EXECUTE format('CREATE TRIGGER draft_timer_fail_second BEFORE UPDATE ON snake_draft_picks FOR EACH ROW WHEN (OLD.draft_id=%L AND OLD.overall_pick=2) EXECUTE FUNCTION pg_temp.draft_timer_fail_second()',v_draft);
  SELECT count(*) INTO v_count FROM private.draft_timer_complete_opening_night(100,v_cutoff);
  PERFORM pg_temp.assert_true(v_count=1 AND (SELECT status='paused' FROM drafts WHERE id=v_draft),'A failed cutoff returns one error and keeps the pause');
  PERFORM pg_temp.assert_true((SELECT count(*)=2 FROM snake_draft_picks WHERE draft_id=v_draft AND player_id IS NULL),'A failed second pick rolls back the first pick');
  DROP TRIGGER draft_timer_fail_second ON snake_draft_picks;
  UPDATE nba_games SET game_date=(clock_timestamp() AT TIME ZONE 'America/New_York')::date-1 WHERE season_year=2189 AND nba_game_id LIKE '002%';
  SELECT count(*) INTO v_count FROM process_expired_snake_picks_atomic();
  PERFORM pg_temp.assert_true(v_count=2 AND (SELECT status='completed' FROM drafts WHERE id=v_draft),'The per-minute expiry path completes a paused draft without a deadline');
  FOREACH v_mode IN ARRAY ARRAY['auto_pick','skip_pick','pause_draft','commissioner_pick'] LOOP
    v_draft := (start_rookie_draft_atomic(v_league,1,true,604800,v_mode)->>'id')::uuid;
    UPDATE snake_draft_picks SET timer_expires_at=clock_timestamp()-interval '1 second' WHERE draft_id=v_draft AND overall_pick=1;
    FOR v_result IN SELECT * FROM process_expired_snake_pick_atomic(v_draft) LOOP
      PERFORM pg_temp.assert_true(v_result.error_message IS NULL,'Expiry processes without error');
    END LOOP;
    IF v_mode IN ('pause_draft','commissioner_pick') THEN
      PERFORM pg_temp.assert_true((SELECT status='paused' AND timer_paused_remaining_seconds IS NULL FROM drafts WHERE id=v_draft),'Expiry pause has no saved remaining duration');
      IF v_mode='commissioner_pick' THEN
        BEGIN
          PERFORM resume_draft_atomic(v_draft);
          RAISE EXCEPTION 'Commissioner wait resumes without a pick';
        EXCEPTION WHEN OTHERS THEN
          IF SQLERRM <> 'Draft is waiting for a commissioner pick.' THEN RAISE; END IF;
        END;
        PERFORM commissioner_snake_pick_atomic(v_draft,(SELECT member_id FROM snake_draft_picks WHERE draft_id=v_draft AND overall_pick=1),(SELECT id FROM players WHERE years_exp=0 AND nba_draft_number IS NOT NULL ORDER BY nba_draft_number,id LIMIT 1));
        PERFORM pg_temp.assert_true((SELECT extract(epoch FROM min(timer_expires_at)-clock_timestamp()) BETWEEN 604798 AND 604801 FROM snake_draft_picks WHERE draft_id=v_draft),'A commissioner pick arms a full seven-day timer');
      ELSIF v_mode='pause_draft' THEN
        v_at := clock_timestamp();
        PERFORM resume_draft_atomic(v_draft);
        PERFORM pg_temp.assert_true((SELECT extract(epoch FROM min(timer_expires_at)-v_at) BETWEEN 604799 AND 604801 FROM snake_draft_picks WHERE draft_id=v_draft),'Expiry pause resumes with a full seven-day timer');
      END IF;
    ELSE
      PERFORM pg_temp.assert_true((SELECT extract(epoch FROM min(timer_expires_at)-clock_timestamp()) BETWEEN 604798 AND 604801 FROM snake_draft_picks WHERE draft_id=v_draft),'Auto-pick and skip arm the next seven-day timer');
    END IF;
    UPDATE drafts SET status='cancelled' WHERE id=v_draft;
  END LOOP;
  PERFORM pg_temp.assert_true((SELECT schedule='* * * * *' FROM cron.job WHERE jobname='nba-close-expired-nominations'),'Expiry dispatch runs once each minute');
END;
$$;
SET LOCAL TIME ZONE 'America/New_York';
SELECT pg_temp.assert_true(extract(epoch FROM ('2026-03-07 12:00:00 America/New_York'::timestamptz + make_interval(secs=>604800)) - '2026-03-07 12:00:00 America/New_York'::timestamptz)=604800,'Spring DST keeps seven elapsed days');
SELECT pg_temp.assert_true(extract(epoch FROM ('2026-10-31 12:00:00 America/New_York'::timestamptz + make_interval(secs=>604800)) - '2026-10-31 12:00:00 America/New_York'::timestamptz)=604800,'Fall DST keeps seven elapsed days');
ROLLBACK;
