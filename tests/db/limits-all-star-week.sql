\set ON_ERROR_STOP on
\set expected_db_port 54322
\getenv expected_db_port PANCAKE_TEST_DB_PORT
SELECT :'HOST' IN ('127.0.0.1','localhost') AND :'PORT' = :'expected_db_port' AS local_target \gset
\if :local_target
\else
  DO $$ BEGIN RAISE EXCEPTION 'Refuse a database outside the expected loopback target.'; END $$;
\endif
\getenv local_db_url SUPABASE_DB_URL
SELECT split_part(:'local_db_url','@',2)=:'HOST'||':'||:'PORT'||'/'||:'DBNAME' AS same_target,
  regexp_replace(:'local_db_url','^(postgres(?:ql)?://)[^:]+:', '\1supabase_admin:') AS local_admin_url \gset
\if :same_target
  \connect :local_admin_url
\else
  DO $$ BEGIN RAISE EXCEPTION 'Refuse a database outside the expected loopback target.'; END $$;
\endif
\unset local_db_url
\unset local_admin_url
SELECT md5(string_agg(pg_get_functiondef(p.oid),E'\n' ORDER BY p.oid)) AS function_hash_before
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE p.prokind='f' AND (n.nspname IN('public','private') OR p.oid IN(
  'pg_catalog.now()'::regprocedure,'pg_catalog.clock_timestamp()'::regprocedure,
  'pg_catalog.statement_timestamp()'::regprocedure,'pg_catalog.transaction_timestamp()'::regprocedure)) \gset
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='5s';
UPDATE waiver_claims SET process_date='infinity'::date WHERE status='pending';
DELETE FROM season_weeks WHERE season_year IN(2025,2026,public.current_season_year_et(now()),public.current_season_year_et(now())+1);
CREATE TEMP TABLE c2_calendar(season_year int,week_number int,week_start date,week_end date,PRIMARY KEY(season_year,week_number));
INSERT INTO c2_calendar VALUES
(2025,1,'2024-10-22','2024-10-27'),
(2025,2,'2024-10-28','2024-11-03'),
(2025,3,'2024-11-04','2024-11-10'),
(2025,4,'2024-11-11','2024-11-17'),
(2025,5,'2024-11-18','2024-11-24'),
(2025,6,'2024-11-25','2024-12-01'),
(2025,7,'2024-12-02','2024-12-08'),
(2025,8,'2024-12-09','2024-12-15'),
(2025,9,'2024-12-16','2024-12-22'),
(2025,10,'2024-12-23','2024-12-29'),
(2025,11,'2024-12-30','2025-01-05'),
(2025,12,'2025-01-06','2025-01-12'),
(2025,13,'2025-01-13','2025-01-19'),
(2025,14,'2025-01-20','2025-01-26'),
(2025,15,'2025-01-27','2025-02-02'),
(2025,16,'2025-02-03','2025-02-09'),
(2025,17,'2025-02-10','2025-02-23'),
(2025,18,'2025-02-24','2025-03-02'),
(2025,19,'2025-03-03','2025-03-09'),
(2025,20,'2025-03-10','2025-03-16'),
(2025,21,'2025-03-17','2025-03-23'),
(2025,22,'2025-03-24','2025-03-30'),
(2025,23,'2025-03-31','2025-04-06'),
(2025,24,'2025-04-07','2025-04-13'),
(2026,1,'2025-10-21','2025-10-26'),
(2026,2,'2025-10-27','2025-11-02'),
(2026,3,'2025-11-03','2025-11-09'),
(2026,4,'2025-11-10','2025-11-16'),
(2026,5,'2025-11-17','2025-11-23'),
(2026,6,'2025-11-24','2025-11-30'),
(2026,7,'2025-12-01','2025-12-07'),
(2026,8,'2025-12-08','2025-12-14'),
(2026,9,'2025-12-15','2025-12-21'),
(2026,10,'2025-12-22','2025-12-28'),
(2026,11,'2025-12-29','2026-01-04'),
(2026,12,'2026-01-05','2026-01-11'),
(2026,13,'2026-01-12','2026-01-18'),
(2026,14,'2026-01-19','2026-01-25'),
(2026,15,'2026-01-26','2026-02-01'),
(2026,16,'2026-02-02','2026-02-08'),
(2026,17,'2026-02-09','2026-02-22'),
(2026,18,'2026-02-23','2026-03-01'),
(2026,19,'2026-03-02','2026-03-08'),
(2026,20,'2026-03-09','2026-03-15'),
(2026,21,'2026-03-16','2026-03-22'),
(2026,22,'2026-03-23','2026-03-29'),
(2026,23,'2026-03-30','2026-04-05'),
(2026,24,'2026-04-06','2026-04-12');
CREATE TYPE pg_temp.all_star_fixture AS (l uuid,s uuid,u uuid[],m uuid[]);
CREATE FUNCTION pg_temp.check_that(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT All-Star: %',label; END IF;
END $$;
CREATE FUNCTION pg_temp.player() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p uuid:=gen_random_uuid();
BEGIN
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team)
  VALUES(p,'SYNTHETIC','All-Star','PG',ARRAY['PG'],'Active','SIM');
  RETURN p;
END $$;
CREATE FUNCTION pg_temp.setup(y int,mode text,skipped boolean) RETURNS pg_temp.all_star_fixture LANGUAGE plpgsql AS $$
DECLARE f pg_temp.all_star_fixture; data jsonb; i int;
BEGIN
  f.u:=ARRAY[gen_random_uuid(),gen_random_uuid()];
  FOR i IN 1..2 LOOP
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(f.u[i],'authenticated','authenticated',f.u[i]||'@example.test','x',now(),'{}','{}',now(),now());
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',f.u[1]::text,true);
  data:=create_league('SYNTHETIC C2 waiver limits','Before break',200);
  f.l:=(data->>'id')::uuid;
  PERFORM set_config('request.jwt.claim.sub',f.u[2]::text,true);
  PERFORM join_league_by_invite_code((SELECT invite_code FROM leagues WHERE id=f.l),'After break');
  SELECT array_agg(id ORDER BY array_position(f.u,user_id)) INTO f.m FROM league_members WHERE league_id=f.l;
  SELECT id INTO f.s FROM league_seasons WHERE league_id=f.l AND is_current;
  UPDATE league_seasons SET season_year=y WHERE id=f.s;
  UPDATE leagues SET status='active',waiver_mode=mode,weekly_add_limit=2,roster_size=20 WHERE id=f.l;
  PERFORM set_config('request.jwt.claim.sub',f.u[1]::text,true);
  IF skipped THEN PERFORM update_league_settings_atomic(f.l,'{"skipped_weeks":[1]}'); END IF;
  PERFORM pg_temp.check_that((SELECT skipped_weeks=CASE WHEN skipped THEN ARRAY[1] ELSE ARRAY[]::int[] END FROM league_seasons WHERE id=f.s),'real skipped-week setting');
  PERFORM pg_temp.check_that((SELECT array_agg(member_id ORDER BY priority)=f.m FROM waiver_priorities WHERE league_season_id=f.s),'initial order');
  RETURN f;
END $$;
CREATE FUNCTION pg_temp.align(y int,checkpoint date) RETURNS int LANGUAGE plpgsql AS $$
DECLARE shift_days int:=((now() AT TIME ZONE private.add_week_timezone())::date-checkpoint);
BEGIN
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
  SELECT season_year,week_number,week_start+shift_days,week_end+shift_days FROM c2_calendar WHERE season_year=y
  ON CONFLICT(season_year,week_number) DO UPDATE SET week_start=EXCLUDED.week_start,week_end=EXCLUDED.week_end;
  RETURN shift_days;
END $$;
CREATE FUNCTION pg_temp.expect_week(f pg_temp.all_star_fixture,y int,checkpoint date,w int,reset_day date) RETURNS void LANGUAGE plpgsql AS $$
DECLARE shift_days int; actual record; expected timestamptz; label text;
BEGIN
  shift_days:=pg_temp.align(y,checkpoint);
  expected:=(reset_day+shift_days)::timestamp AT TIME ZONE 'America/New_York';
  SELECT * INTO actual FROM private.current_add_week(f.l,f.s);
  PERFORM pg_temp.check_that(actual.week_number=w AND actual.resets_at=expected,
    format('season %s checkpoint %s: week/reset %s/%s expected %s/%s',y,checkpoint,actual.week_number,actual.resets_at,w,expected));
  label:=to_char(expected AT TIME ZONE 'America/New_York','Dy, Mon FMDD "at" FMHH12:MI AM')||' ET';
  PERFORM pg_temp.check_that(private.weekly_add_limit_reset_label(actual.resets_at)=label,'reset label follows add-week zone');
  PERFORM pg_temp.check_that(private.current_add_week_number(f.l,f.s)=w,'number consumer matches range');
  RAISE NOTICE '%',jsonb_build_object('provenance','REAL-DERIVED C2 ranges; SYNTHETIC uniform date translation','season',y,'checkpoint',checkpoint,'shift_days',shift_days,'week',w,'resets_at',actual.resets_at);
END $$;
CREATE FUNCTION pg_temp.claim(f pg_temp.all_star_fixture,team int,p uuid,bid int,ready boolean) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at)
  SELECT f.l,f.s,p,CASE WHEN ready THEN now()-interval '73 hours' ELSE now() END
  WHERE NOT EXISTS(SELECT 1 FROM waiver_wire_log WHERE league_id=f.l AND player_id=p AND cleared_at IS NULL);
  RETURN create_waiver_claim_atomic(f.l,f.m[team],p,NULL,f.u[team],bid);
END $$;
CREATE FUNCTION pg_temp.drain() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM * FROM process_due_waiver_claims_atomic((now() AT TIME ZONE 'America/New_York')::date,100);
END $$;
CREATE FUNCTION pg_temp.expect_limit(f pg_temp.all_star_fixture) RETURNS void LANGUAGE plpgsql AS $$
DECLARE message text; reset_at timestamptz; state record;
BEGIN
  SELECT resets_at INTO reset_at FROM private.current_add_week(f.l,f.s);
  BEGIN
    PERFORM private.assert_weekly_add_available(f.l,f.s,f.m[1]);
  EXCEPTION WHEN SQLSTATE 'PA001' THEN message:=SQLERRM;
  END;
  PERFORM pg_temp.check_that(message='Weekly add limit reached (2/2 adds used this week). Adds reset '||private.weekly_add_limit_reset_label(reset_at)||'.','exact exhaustion message and merged reset');
  SELECT * INTO state FROM get_member_transaction_state(f.m[1],f.l);
  PERFORM pg_temp.check_that(state.weekly_add_count=2 AND state.weekly_add_limit=2 AND state.add_limit_resets_at=reset_at AND state.add_limit_message=message,'member state reports same merged limit and reset');
END $$;
DO $$
DECLARE y int; mode text; skipped boolean; f pg_temp.all_star_fixture; merged record; following record; last_week record;
  p uuid; before_claim uuid; loser uuid; limited uuid; after_claim uuid; next_id uuid; start_day date; expected_order uuid[];
BEGIN
  PERFORM pg_temp.check_that(private.add_week_timezone()='America/New_York','add-week zone');
  FOR y IN SELECT DISTINCT season_year FROM c2_calendar ORDER BY season_year LOOP
    SELECT * INTO merged FROM c2_calendar WHERE season_year=y AND week_number=17;
    SELECT * INTO following FROM c2_calendar WHERE season_year=y AND week_number=18;
    SELECT * INTO last_week FROM c2_calendar WHERE season_year=y ORDER BY week_number DESC LIMIT 1;
    PERFORM pg_temp.check_that(merged.week_end-merged.week_start=13 AND following.week_start=merged.week_end+1 AND last_week.week_number=24,'C2 merged range, following number and shortened season');
    PERFORM pg_temp.check_that(private.weekly_add_limit_reset_label((merged.week_end+1)::timestamp AT TIME ZONE 'America/New_York')=
      CASE y WHEN 2025 THEN 'Mon, Feb 24 at 12:00 AM ET' ELSE 'Mon, Feb 23 at 12:00 AM ET' END,'real historical reset date label');
    FOR mode IN SELECT unnest(ARRAY['faab','rolling']) LOOP
      FOR skipped IN SELECT unnest(ARRAY[false,true]) LOOP
        f:=pg_temp.setup(y,mode,skipped);
        IF skipped THEN
          SELECT week_start INTO start_day FROM c2_calendar WHERE season_year=y AND week_number=1;
          PERFORM pg_temp.expect_week(f,y,start_day,1,(SELECT week_end+1 FROM c2_calendar WHERE season_year=y AND week_number=1));
          PERFORM add_free_agent_atomic(f.m[1],f.l,pg_temp.player());
          SELECT week_start INTO start_day FROM c2_calendar WHERE season_year=y AND week_number=2;
          PERFORM pg_temp.expect_week(f,y,start_day,2,(SELECT week_end+1 FROM c2_calendar WHERE season_year=y AND week_number=2));
          PERFORM add_free_agent_atomic(f.m[1],f.l,pg_temp.player());
          PERFORM pg_temp.check_that((SELECT array_agg(add_count ORDER BY week_number)=ARRAY[1,1] FROM weekly_add_counts WHERE league_season_id=f.s AND member_id=f.m[1]),'skipped week does not consume first eligible bucket');
        END IF;
        PERFORM pg_temp.expect_week(f,y,merged.week_start+3,17,merged.week_end+1);
        p:=pg_temp.player(); before_claim:=pg_temp.claim(f,1,p,5,true); loser:=pg_temp.claim(f,2,p,4,true);
        limited:=pg_temp.claim(f,1,pg_temp.player(),1,false);
        after_claim:=pg_temp.claim(f,2,pg_temp.player(),7,false);
        PERFORM pg_temp.drain();
        PERFORM pg_temp.check_that((SELECT status='succeeded' FROM waiver_claims WHERE id=before_claim),'pre-break claim succeeds');
        PERFORM pg_temp.check_that((SELECT status='failed_priority' FROM waiver_claims WHERE id=loser),'pre-break losing claim');
        PERFORM pg_temp.check_that((SELECT add_count=1 FROM weekly_add_counts WHERE league_season_id=f.s AND member_id=f.m[1] AND week_number=17),'pre-break waiver consumes merged bucket');
        PERFORM pg_temp.check_that((SELECT array_agg(priority ORDER BY array_position(f.m,member_id))=ARRAY[3,2] FROM waiver_priorities WHERE league_season_id=f.s),'pre-break winner last');
        PERFORM pg_temp.expect_week(f,y,merged.week_start+7,17,merged.week_end+1);
        PERFORM pg_temp.check_that((SELECT add_count=1 FROM weekly_add_counts WHERE league_season_id=f.s AND member_id=f.m[1] AND week_number=17),'no reset on Monday during break');
        PERFORM pg_temp.expect_week(f,y,merged.week_end-3,17,merged.week_end+1);
        PERFORM add_free_agent_atomic(f.m[1],f.l,pg_temp.player());
        PERFORM pg_temp.check_that((SELECT add_count=2 FROM weekly_add_counts WHERE league_season_id=f.s AND member_id=f.m[1] AND week_number=17),'pre/post-break additions share one limit');
        PERFORM pg_temp.expect_limit(f);
        UPDATE waiver_wire_log SET placed_on_waivers_at=now()-interval '73 hours',clears_at=now()-interval '1 second'
          WHERE league_season_id=f.s AND player_id IN(SELECT player_id FROM waiver_claims WHERE id IN(limited,after_claim));
        UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date WHERE id IN(limited,after_claim);
        PERFORM pg_temp.drain();
        PERFORM pg_temp.check_that((SELECT status='failed_roster' AND failure_reason LIKE 'Weekly add limit reached (2/2 adds used this week). Adds reset % ET.' FROM waiver_claims WHERE id=limited),'processing rechecks shared merged limit');
        PERFORM pg_temp.check_that((SELECT status='succeeded' FROM waiver_claims WHERE id=after_claim),'post-break claim succeeds');
        PERFORM pg_temp.check_that((SELECT array_agg(priority ORDER BY array_position(f.m,member_id))=ARRAY[3,4] FROM waiver_priorities WHERE league_season_id=f.s),'rolling order persists across break; failure keeps position');
        PERFORM pg_temp.check_that((SELECT array_agg(balance ORDER BY array_position(f.m,member_id))=CASE mode WHEN 'faab' THEN ARRAY[95,93] ELSE ARRAY[100,100] END FROM faab_balances WHERE league_season_id=f.s),'winner-only FAAB, no break reset or failed-claim debit');
        PERFORM pg_temp.check_that(commissioner_override_weekly_add_count_atomic(f.l,f.m[1],1)=1,'override selects merged bucket');
        PERFORM private.consume_weekly_add(f.l,f.s,f.m[1]);
        PERFORM pg_temp.expect_limit(f);
        PERFORM pg_temp.expect_week(f,y,merged.week_end,17,merged.week_end+1);
        PERFORM pg_temp.expect_limit(f);
        PERFORM pg_temp.expect_week(f,y,following.week_start,18,following.week_end+1);
        PERFORM private.assert_weekly_add_available(f.l,f.s,f.m[1]);
        PERFORM add_free_agent_atomic(f.m[1],f.l,pg_temp.player());
        PERFORM pg_temp.check_that((SELECT array_agg(add_count ORDER BY week_number)=ARRAY[2,1] FROM weekly_add_counts WHERE league_season_id=f.s AND member_id=f.m[1] AND week_number IN(17,18)),'following week starts one fresh bucket');
        PERFORM pg_temp.check_that((SELECT array_agg(priority ORDER BY array_position(f.m,member_id))=ARRAY[3,4] FROM waiver_priorities WHERE league_season_id=f.s),'weekly reset does not reset rolling priority');
        UPDATE leagues SET status='playoffs' WHERE id=f.l;
        PERFORM pg_temp.expect_week(f,y,(SELECT week_start FROM c2_calendar WHERE season_year=y AND week_number=21),21,(SELECT week_end+1 FROM c2_calendar WHERE season_year=y AND week_number=21));
        PERFORM commissioner_override_weekly_add_count_atomic(f.l,f.m[1],2);
        PERFORM pg_temp.expect_limit(f);
        PERFORM pg_temp.expect_week(f,y,last_week.week_end,24,last_week.week_end+1);
        UPDATE leagues SET status='offseason' WHERE id=f.l;
        PERFORM pg_temp.expect_week(f,y,last_week.week_end+1,25,last_week.week_end+8);
        PERFORM add_free_agent_atomic(f.m[1],f.l,pg_temp.player());
        PERFORM pg_temp.expect_week(f,y,last_week.week_end+7,25,last_week.week_end+8);
        PERFORM pg_temp.check_that((SELECT add_count=1 FROM weekly_add_counts WHERE league_season_id=f.s AND member_id=f.m[1] AND week_number=25),'post-schedule bucket lasts seven days');
        PERFORM pg_temp.expect_week(f,y,last_week.week_end+8,26,last_week.week_end+15);
        PERFORM commissioner_override_weekly_add_count_atomic(f.l,f.m[1],1);
        PERFORM pg_temp.check_that((SELECT array_agg(add_count ORDER BY week_number)=ARRAY[1,1] FROM weekly_add_counts WHERE league_season_id=f.s AND member_id=f.m[1] AND week_number IN(25,26)),'shortened-season fallback increments once');
        PERFORM expire_waiver_wire_logs();
        UPDATE leagues SET status='playoffs' WHERE id=f.l;
        SELECT new_season_id INTO next_id FROM advance_season_atomic(f.l);
        SELECT array_agg(id ORDER BY id) INTO expected_order FROM league_members WHERE league_id=f.l;
        PERFORM pg_temp.check_that((SELECT array_agg(member_id ORDER BY priority)=expected_order FROM waiver_priorities WHERE league_season_id=next_id),'season rollover alone rebuilds priority');
        PERFORM pg_temp.check_that((SELECT count(*)=2 AND min(balance)=100 AND max(balance)=100 FROM faab_balances WHERE league_season_id=next_id),'season rollover alone resets FAAB');
        f.s:=next_id;
        PERFORM pg_temp.expect_week(f,y,last_week.week_end+1,1000,last_week.week_end+8);
        PERFORM commissioner_override_weekly_add_count_atomic(f.l,f.m[1],1);
        PERFORM pg_temp.expect_week(f,y,last_week.week_end+8,1001,last_week.week_end+15);
        PERFORM private.assert_weekly_add_available(f.l,f.s,f.m[1]);
        PERFORM pg_temp.check_that((SELECT array_agg(add_count ORDER BY week_number)=ARRAY[1,0] FROM weekly_add_counts WHERE league_season_id=f.s AND member_id=f.m[1] AND week_number IN(1000,1001)),'unscheduled offseason uses prior merged calendar end');
        RAISE NOTICE 'PASS All-Star season=% mode=% skipped=%: shared 14-day limit, FAAB, rolling priority, weeks 18/21/24/25/26/1000/1001',y,mode,skipped;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;
\set clock_source `cat scripts/season-sim/clock.sql`
SELECT replace(replace(replace(replace(
  substring(:'clock_source' FROM '(?s)BEGIN;(.*)COMMIT;'),
  $param$:'sim_ms'$param$, '1738857600000'),
  $param$:'real_ms'$param$, (extract(epoch FROM clock_timestamp())*1000)::text),
  $param$:'rate'$param$, '0'), $param$:'cap_ms'$param$, 'NULL') \gexec
DO $$
DECLARE saved record;
BEGIN
  FOR saved IN SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p
    WHERE p.pronamespace=pg_my_temp_schema() AND p.prokind='f'
  LOOP EXECUTE saved.definition; END LOOP;
END $$;
INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
SELECT * FROM c2_calendar
ON CONFLICT(season_year,week_number) DO UPDATE SET week_start=excluded.week_start,week_end=excluded.week_end;
CREATE FUNCTION pg_temp.at_time(at_instant timestamptz) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE season_sim.clock SET sim_ms=extract(epoch FROM at_instant)*1000,rate=0,cap_ms=NULL WHERE singleton;
  PERFORM pg_temp.check_that(now()=at_instant AND clock_timestamp()=at_instant,'isolated database clock checkpoint');
END $$;
CREATE FUNCTION pg_temp.offer(f pg_temp.all_star_fixture) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE pick uuid; requested uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','',true);
  SELECT p.id INTO pick FROM draft_picks p WHERE p.league_id=f.l AND p.current_owner_id=f.m[1]
    AND NOT EXISTS(SELECT 1 FROM trade_items i WHERE i.pick_id=p.id) ORDER BY p.season_year,p.round LIMIT 1;
  SELECT p.id INTO requested FROM draft_picks p WHERE p.league_id=f.l AND p.current_owner_id=f.m[2]
    AND NOT EXISTS(SELECT 1 FROM trade_items i WHERE i.pick_id=p.id) ORDER BY p.season_year,p.round LIMIT 1;
  PERFORM pg_temp.check_that(pick IS NOT NULL AND requested IS NOT NULL,'both sides own a real draft pick');
  RETURN submit_trade_offer_atomic(f.u[1],gen_random_uuid(),f.m[1],'propose',jsonb_build_object(
    'leagueId',f.l,'leagueSeasonId',f.s,'recipientMemberId',f.m[2],
    'offerPlayerIds','[]'::jsonb,'requestPlayerIds','[]'::jsonb,
    'offerPickIds',jsonb_build_array(pick),'requestPickIds',jsonb_build_array(requested),
    'offerFaabAmount',0,'requestFaabAmount',0,'notes',NULL,'expiresAt',NULL));
END $$;
CREATE FUNCTION pg_temp.accept(f pg_temp.all_star_fixture,offer_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','',true);
  result:=accept_trade_atomic(offer_id,f.m[2]);
  PERFORM pg_temp.check_that(result->>'expired'='false' AND result->>'allAccepted'='true'
    AND (SELECT status='accepted' FROM trades WHERE id=offer_id),'real acceptance succeeds');
END $$;
CREATE FUNCTION pg_temp.locked(f pg_temp.all_star_fixture,offer_id uuid,label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE message text; participant_before jsonb; offer_before jsonb; request_count int;
BEGIN
  SELECT to_jsonb(t) INTO offer_before FROM trades t WHERE id=offer_id;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY member_id) INTO participant_before FROM trade_participants t WHERE trade_id=offer_id;
  SELECT count(*) INTO request_count FROM private.trade_offer_requests WHERE member_id=f.m[1];
  BEGIN PERFORM pg_temp.offer(f); EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
  PERFORM pg_temp.check_that(message='Trades are locked from the trade deadline until the champion is finalized.',label||' proposal rejected by deadline');
  message:=NULL;
  BEGIN PERFORM pg_temp.accept(f,offer_id); EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
  PERFORM pg_temp.check_that(message='Trades are locked from the trade deadline until the champion is finalized.',label||' acceptance rejected by deadline');
  PERFORM expire_pending_trades_atomic(100);
  PERFORM pg_temp.check_that((SELECT status='pending' AND to_jsonb(t)=offer_before FROM trades t WHERE id=offer_id)
    AND (SELECT jsonb_agg(to_jsonb(t) ORDER BY member_id)=participant_before FROM trade_participants t WHERE trade_id=offer_id)
    AND (SELECT count(*)=request_count FROM private.trade_offer_requests WHERE member_id=f.m[1]),label||' pending offer and acceptance locks unchanged; no failed request receipt');
  PERFORM set_config('request.jwt.claim.sub',f.u[1]::text,true);
END $$;
CREATE FUNCTION pg_temp.champion(f pg_temp.all_star_fixture) RETURNS void LANGUAGE plpgsql AS $$
DECLARE final_id uuid; token jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','',true);
  UPDATE leagues SET status='playoffs' WHERE id=f.l;
  INSERT INTO matchups(league_id,league_season_id,week_number,matchup_type,home_member_id,away_member_id)
  VALUES(f.l,f.s,24,'playoff_final',f.m[1],f.m[2]) RETURNING id INTO final_id;
  token:=capture_score_inputs(f.s,24);
  PERFORM finalize_score_week_atomic(f.l,f.s,24,jsonb_build_array(jsonb_build_object('id',final_id,
    'winner_member_id',f.m[1],'home_points',10,'away_points',5,
    'home_max_possible_points',10,'away_max_possible_points',5,'input_token',token)),'[]');
  PERFORM pg_temp.check_that((SELECT is_finalized AND winner_member_id=f.m[1] FROM matchups WHERE id=final_id),'real finalization RPC declares champion');
END $$;
DO $$
DECLARE f pg_temp.all_star_fixture; y int; skipped boolean; deadline date; accepted uuid; pending uuid; reopened uuid;
BEGIN
  FOR y IN 2025..2026 LOOP
    deadline:=make_date(y,2,CASE y WHEN 2025 THEN 6 ELSE 5 END);
    FOREACH skipped IN ARRAY ARRAY[false,true] LOOP
      PERFORM pg_temp.at_time((deadline::timestamp AT TIME ZONE 'America/New_York')+interval '12 hours');
      f:=pg_temp.setup(y,'faab',skipped);
      PERFORM update_league_settings_atomic(f.l,jsonb_build_object('trade_deadline',to_char(deadline,'MM-DD')));
      PERFORM pg_temp.check_that((SELECT trade_deadline=deadline FROM leagues WHERE id=f.l),'settings derives real NBA deadline year');
      accepted:=pg_temp.offer(f);
      PERFORM pg_temp.accept(f,accepted);
      PERFORM pg_temp.at_time(((deadline+1)::timestamp AT TIME ZONE 'America/New_York')-interval '1 microsecond');
      pending:=pg_temp.offer(f);
      PERFORM pg_temp.at_time((deadline+1)::timestamp AT TIME ZONE 'America/New_York');
      PERFORM pg_temp.locked(f,pending,'next New York date');
      UPDATE leagues SET status='playoffs' WHERE id=f.l;
      PERFORM pg_temp.locked(f,pending,'playoffs before champion');
      PERFORM pg_temp.at_time((make_date(y,4,14)::timestamp AT TIME ZONE 'America/New_York')+interval '12 hours');
      PERFORM pg_temp.champion(f);
      PERFORM pg_temp.accept(f,pending);
      reopened:=pg_temp.offer(f);
      PERFORM pg_temp.accept(f,reopened);
      RAISE NOTICE 'PASS deadline season=% skipped=%: settings, on-date proposal/acceptance, exact ET midnight lock, pending preservation, champion reopening; calendar=REAL-DERIVED clock/results=SYNTHETIC',y,skipped;
    END LOOP;
  END LOOP;
END $$;
DO $$
DECLARE f pg_temp.all_star_fixture; pending uuid; before_claim uuid; after_claim uuid; reset_before timestamptz; reset_after timestamptz; w int;
BEGIN
  PERFORM pg_temp.at_time('2026-02-12 12:00 America/New_York');
  f:=pg_temp.setup(2026,'faab',true);
  PERFORM update_league_settings_atomic(f.l,'{"trade_deadline":"02-15"}');
  PERFORM pg_temp.check_that((SELECT trade_deadline='2026-02-15' FROM leagues WHERE id=f.l),'inside merged week deadline derives date');
  before_claim:=pg_temp.claim(f,1,pg_temp.player(),5,true);
  PERFORM pg_temp.drain();
  PERFORM pg_temp.check_that((SELECT status='succeeded' FROM waiver_claims WHERE id=before_claim),'pre-deadline merged-week waiver win');
  SELECT week_number,resets_at INTO w,reset_before FROM private.current_add_week(f.l,f.s);
  PERFORM pg_temp.check_that(w=17 AND reset_before='2026-02-23 00:00 America/New_York','merged reset before deadline');
  PERFORM pg_temp.at_time('2026-02-15 23:59:59.999999 America/New_York');
  pending:=pg_temp.offer(f);
  PERFORM pg_temp.at_time('2026-02-16 00:00 America/New_York');
  PERFORM pg_temp.locked(f,pending,'middle of merged matchup');
  PERFORM add_free_agent_atomic(f.m[1],f.l,pg_temp.player());
  PERFORM pg_temp.expect_limit(f);
  SELECT week_number,resets_at INTO w,reset_after FROM private.current_add_week(f.l,f.s);
  PERFORM pg_temp.check_that(w=17 AND reset_after=reset_before
    AND (SELECT add_count=2 FROM weekly_add_counts WHERE league_season_id=f.s AND member_id=f.m[1] AND week_number=17),'deadline changes neither merged reset nor used count');
  PERFORM pg_temp.at_time('2026-02-23 00:00 America/New_York');
  PERFORM private.assert_weekly_add_available(f.l,f.s,f.m[1]);
  after_claim:=pg_temp.claim(f,1,pg_temp.player(),7,true);
  PERFORM pg_temp.drain();
  PERFORM pg_temp.check_that((SELECT status='succeeded' FROM waiver_claims WHERE id=after_claim)
    AND (SELECT array_agg(add_count ORDER BY week_number)=ARRAY[2,1] FROM weekly_add_counts WHERE league_season_id=f.s AND member_id=f.m[1] AND week_number IN(17,18))
    AND (SELECT balance=88 FROM faab_balances WHERE league_season_id=f.s AND member_id=f.m[1])
    AND (SELECT priority=4 FROM waiver_priorities WHERE league_season_id=f.s AND member_id=f.m[1]),'post-merged reset permits waiver, keeps FAAB and rolling priority');
  RAISE NOTICE 'PASS deadline inside REAL-DERIVED merged week: Feb 16 lock, Feb 23 reset, shared limit, FAAB 88, priority 4; clock/fixtures=SYNTHETIC';
END $$;
DO $$
DECLARE f pg_temp.all_star_fixture; accepted uuid; pending uuid; result jsonb;
BEGIN
  PERFORM pg_temp.at_time('2025-02-06 12:00 America/New_York');
  f:=pg_temp.setup(2025,'faab',true);
  PERFORM update_league_settings_atomic(f.l,'{"trade_deadline":"02-06"}');
  PERFORM pg_temp.at_time('2025-04-14 12:00 America/New_York');
  PERFORM pg_temp.champion(f);
  PERFORM pg_temp.at_time('2025-04-16 12:00 America/New_York');
  result:=apply_season_boundary_after_grace(f.l,f.s,'rollover');
  PERFORM pg_temp.check_that((result->>'applied')::boolean AND (result->>'new_year')::int=2026,'real automatic RPC rolls 2025 into 2026');
  f.s:=(result->>'new_season_id')::uuid;
  PERFORM pg_temp.check_that((SELECT trade_deadline='2026-02-06' AND status='offseason' FROM leagues WHERE id=f.l)
    AND (SELECT season_year=2026 AND is_current FROM league_seasons WHERE id=f.s),'rollover derives 2026 recurring deadline');
  UPDATE leagues SET status='active' WHERE id=f.l;
  PERFORM pg_temp.at_time('2026-02-06 12:00 America/New_York');
  accepted:=pg_temp.offer(f);
  PERFORM pg_temp.accept(f,accepted);
  pending:=pg_temp.offer(f);
  PERFORM pg_temp.at_time('2026-02-07 00:00 America/New_York');
  PERFORM pg_temp.locked(f,pending,'derived 2026 deadline');
  RAISE NOTICE 'PASS real-year rollover 2025 -> 2026: recurring Feb 6 deadline enforced through real submission/acceptance RPCs; calendar=REAL-DERIVED clock/results=SYNTHETIC';
END $$;
ROLLBACK;
SELECT to_regprocedure('pg_catalog.season_sim_native_now()') IS NULL
  AND md5(string_agg(pg_get_functiondef(p.oid),E'\n' ORDER BY p.oid))=:'function_hash_before' AS clock_restored
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE p.prokind='f' AND (n.nspname IN('public','private') OR p.oid IN(
  'pg_catalog.now()'::regprocedure,'pg_catalog.clock_timestamp()'::regprocedure,
  'pg_catalog.statement_timestamp()'::regprocedure,'pg_catalog.transaction_timestamp()'::regprocedure)) \gset
\if :clock_restored
\else
  DO $$ BEGIN RAISE EXCEPTION 'Database clock or function definitions were not restored.'; END $$;
\endif
