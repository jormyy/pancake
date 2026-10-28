\set ON_ERROR_STOP on
\set expected_db_port 54322
\getenv expected_db_port PANCAKE_TEST_DB_PORT
SELECT :'HOST' IN ('127.0.0.1','localhost') AND :'PORT' = :'expected_db_port' AS local_target \gset
\if :local_target
\else
  DO $$ BEGIN RAISE EXCEPTION 'Database test configuration is missing or invalid.'; END $$;
\endif
BEGIN;
UPDATE waiver_claims SET process_date='infinity'::date WHERE status='pending';
DELETE FROM season_weeks WHERE season_year=2199;
SET LOCAL TIME ZONE 'America/New_York';
SET LOCAL statement_timeout='20s';
DO $$
DECLARE
  u uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); m uuid:=gen_random_uuid();
  p uuid; c1 uuid; c2 uuid; placed timestamptz; actual timestamptz; expected timestamptz;
  before_reset timestamptz; after_reset timestamptz; wk int; got int; i int;
  today date:=(now() AT TIME ZONE 'America/New_York')::date;
  run_day date:=(now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(u,'authenticated','authenticated',u||'@example.test','x',now(),'{}','{}',now(),now());
  INSERT INTO leagues(id,name,slug,commissioner_id,status,waiver_mode,weekly_add_limit,timezone)
  VALUES(l,'Synthetic DST waiver',l::text,u,'playoffs','faab',NULL,'America/New_York');
  INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(m,l,u,'commissioner','DST');
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(s,l,2199,true);
  INSERT INTO waiver_priorities(league_id,league_season_id,member_id,priority) VALUES(l,s,m,1);
  FOR i IN 1..3 LOOP
    p:=gen_random_uuid();
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team)
    VALUES(p,'Synthetic','DST','PG',ARRAY['PG'],'Active','SIM');
    placed:=CASE i WHEN 1 THEN '2026-10-31 01:30:00-04'::timestamptz
      WHEN 2 THEN '2026-11-01 01:59:59-04'::timestamptz ELSE '2026-11-01 01:00:00-05'::timestamptz END;
    expected:=CASE i WHEN 1 THEN '2026-11-03 00:00:00-05'::timestamptz
      WHEN 2 THEN '2026-11-04 00:00:00-05'::timestamptz ELSE '2026-11-04 00:00:00-05'::timestamptz END;
    INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at)
    VALUES(l,s,p,placed) RETURNING clears_at INTO actual;
    IF actual<>expected OR actual-placed<interval '48 hours' OR actual-placed>=interval '72 hours' THEN
      RAISE EXCEPTION 'ASSERT DST drop %: clear % expected %, elapsed %',i,actual,expected,actual-placed;
    END IF;
  END LOOP;
  IF today<='2026-10-25' THEN
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(2199,2,'2026-10-19','2026-10-25');
    SELECT week_number,resets_at INTO wk,before_reset FROM private.current_add_week(l,s);
    IF wk<>2 OR before_reset<>'2026-10-26 04:00:00+00'::timestamptz THEN RAISE EXCEPTION 'ASSERT pre-DST reset % / %',wk,before_reset; END IF;
    UPDATE season_weeks SET week_start='2026-10-26',week_end='2026-11-01' WHERE season_year=2199;
    SELECT week_number,resets_at INTO wk,after_reset FROM private.current_add_week(l,s);
    IF wk<>2 OR after_reset<>'2026-11-02 05:00:00+00'::timestamptz OR after_reset-before_reset<>interval '169 hours' THEN
      RAISE EXCEPTION 'ASSERT DST week-2 reset % / % / %',wk,after_reset,after_reset-before_reset;
    END IF;
    RAISE NOTICE 'PASS SYNTHETIC calendar-derived weekly resets: Oct 26 04Z to Nov 2 05Z, 169 hours';
  ELSE
    RAISE NOTICE 'LIMIT: current_add_week has no reference-time argument; historical DST date selection is not asserted after Oct 25';
  END IF;
  IF private.weekly_add_limit_reset_label('2026-11-02 05:00:00+00')<>'Mon, Nov 2 at 12:00 AM ET'
    OR private.weekly_add_limit_reset_label('2026-10-26 04:00:00+00')<>'Mon, Oct 26 at 12:00 AM ET' THEN
    RAISE EXCEPTION 'ASSERT DST reset label must use ET midnight on both sides';
  END IF;
  FOR i IN 1..2 LOOP
    p:=gen_random_uuid();
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team)
    VALUES(p,'Synthetic','ET edge','PG',ARRAY['PG'],'Active','SIM');
    expected:=(CASE i WHEN 1 THEN (run_day-1)::timestamp ELSE run_day::timestamp END+interval '0 hours') AT TIME ZONE 'America/New_York';
    INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at)
    VALUES(l,s,p,expected-interval '48 hours');
    IF i=1 THEN c1:=create_waiver_claim_atomic(l,m,p,NULL,u,0); ELSE c2:=create_waiver_claim_atomic(l,m,p,NULL,u,0); END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM waiver_claims WHERE id IN(c1,c2)
    AND (process_date + time '00:00') AT TIME ZONE 'America/New_York' <= now()) THEN
    RAISE EXCEPTION 'ASSERT new submission must use a future ET run';
  END IF;
  UPDATE waiver_claims SET process_date=run_day-1 WHERE id=c1;
  UPDATE waiver_claims SET process_date=run_day WHERE id=c2;
  SELECT count(*) INTO got FROM process_due_waiver_claims_atomic(run_day-1,100) WHERE claim_id IN(c1,c2);
  IF got<>1 OR (SELECT status FROM waiver_claims WHERE id=c1)<>'succeeded' OR (SELECT status FROM waiver_claims WHERE id=c2)<>'pending' THEN
    RAISE EXCEPTION 'ASSERT ET previous-day processing must select only the previous run claim';
  END IF;
  SELECT count(*) INTO got FROM process_due_waiver_claims_atomic(run_day,100) WHERE claim_id IN(c1,c2);
  IF got<>1 OR (SELECT status FROM waiver_claims WHERE id=c2)<>'succeeded' THEN RAISE EXCEPTION 'ASSERT current run claim must process on its ET day'; END IF;
  RAISE NOTICE 'PASS SYNTHETIC fixed 2026 DST drop instants, 48-hour minimum before the league-local midnight run, ET midnight labels, real submission/processing day edges';
END $$;
ROLLBACK;
