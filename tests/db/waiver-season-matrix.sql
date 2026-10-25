\set ON_ERROR_STOP on
\set expected_db_port 54322
\getenv expected_db_port PANCAKE_TEST_DB_PORT
SELECT :'HOST' IN ('127.0.0.1','localhost') AND :'PORT' = :'expected_db_port' AS lane_local \gset
\if :lane_local
\else
  \quit 2
\endif
BEGIN;
UPDATE waiver_claims SET process_date='infinity'::date WHERE status='pending';
DELETE FROM season_weeks WHERE season_year=2187;
SET LOCAL statement_timeout = '25s';
CREATE TYPE pg_temp.fixture AS (l uuid, s uuid, u uuid[], m uuid[]);
CREATE FUNCTION pg_temp.check_that(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT: %', label; END IF;
END $$;
CREATE FUNCTION pg_temp.expect_error(statement text, code text, message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = code AND position(message IN SQLERRM) > 0 THEN RETURN; END IF;
    RAISE;
  END;
  RAISE EXCEPTION 'ASSERT: expected %: %', code, message;
END $$;
CREATE FUNCTION pg_temp.player() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p uuid := gen_random_uuid();
BEGIN
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team)
  VALUES(p,'Synthetic','Waiver','PG',ARRAY['PG'],'Active','SIM');
  RETURN p;
END $$;
CREATE FUNCTION pg_temp.setup(mode text DEFAULT 'faab', add_limit int DEFAULT NULL, size int DEFAULT 20)
RETURNS pg_temp.fixture LANGUAGE plpgsql AS $$
DECLARE f pg_temp.fixture; i int; data jsonb;
BEGIN
  f.u := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  FOR i IN 1..3 LOOP
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(f.u[i],'authenticated','authenticated',f.u[i]||'@example.test','x',now(),'{}','{}',now(),now());
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',f.u[1]::text,true);
  data := public.create_league('Synthetic waiver season','Team A',200);
  f.l := (data->>'id')::uuid;
  FOR i IN 2..3 LOOP
    PERFORM set_config('request.jwt.claim.sub',f.u[i]::text,true);
    PERFORM public.join_league_by_invite_code((SELECT invite_code FROM leagues WHERE id=f.l),'Team '||i);
  END LOOP;
  SELECT array_agg(id ORDER BY array_position(f.u,user_id)) INTO f.m FROM league_members WHERE league_id=f.l;
  SELECT id INTO f.s FROM league_seasons WHERE league_id=f.l AND is_current;
  PERFORM pg_temp.check_that((SELECT array_agg(priority ORDER BY array_position(f.m,member_id))=ARRAY[1,2,3]
    FROM waiver_priorities WHERE league_season_id=f.s),'initial and joining-member priority');
  PERFORM pg_temp.check_that((SELECT count(*)=3 AND min(balance)=100 AND max(balance)=100
    FROM faab_balances WHERE league_season_id=f.s),'season/member starting balances');
  UPDATE league_seasons SET season_year=2187 WHERE id=f.s;
  UPDATE leagues SET status='active',waiver_mode=mode,weekly_add_limit=add_limit,roster_size=size WHERE id=f.l;
  PERFORM set_config('request.jwt.claim.sub',f.u[1]::text,true);
  RETURN f;
END $$;
CREATE FUNCTION pg_temp.claim(f pg_temp.fixture, team int, p uuid, bid int DEFAULT 0, pref int DEFAULT NULL, drop_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at)
  SELECT f.l,f.s,p,now()-interval '48 hours'
  WHERE NOT EXISTS(SELECT 1 FROM waiver_wire_log WHERE league_id=f.l AND player_id=p AND cleared_at IS NULL);
  UPDATE waiver_wire_log SET clears_at=now()
  WHERE league_id=f.l AND league_season_id=f.s AND player_id=p AND cleared_at IS NULL;
  RETURN public.create_waiver_claim_atomic(f.l,f.m[team],p,drop_id,f.u[team],bid,pref);
END $$;
CREATE FUNCTION pg_temp.drain() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM * FROM public.process_due_waiver_claims_atomic((now() AT TIME ZONE 'America/New_York')::date,100);
END $$;
INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
VALUES(2187,1,(now() AT TIME ZONE 'America/New_York')::date-3,(now() AT TIME ZONE 'America/New_York')::date+3),
      (2187,2,(now() AT TIME ZONE 'America/New_York')::date+4,(now() AT TIME ZONE 'America/New_York')::date+10);
DO $$
DECLARE f pg_temp.fixture; p uuid; q uuid; c uuid; d uuid; e uuid;
BEGIN
  f := pg_temp.setup(); p:=pg_temp.player();
  c:=pg_temp.claim(f,1,p,10); d:=pg_temp.claim(f,2,p,11); e:=pg_temp.claim(f,3,p,11);
  PERFORM pg_temp.expect_error(format('SELECT create_waiver_claim_atomic(%L,%L,%L,NULL,%L,10)',f.l,f.m[1],p,f.u[1]),'P0001','already have a pending claim');
  PERFORM pg_temp.drain();
  PERFORM pg_temp.check_that((SELECT status='succeeded' FROM waiver_claims WHERE id=d),'highest bid and priority tie winner');
  PERFORM pg_temp.check_that((SELECT count(*)=2 FROM waiver_claims WHERE id IN(c,e) AND status='failed_priority'
    AND failure_reason='Claimed by a higher FAAB bid or tiebreaker.'),'loser status and reason');
  PERFORM pg_temp.check_that((SELECT array_agg(balance ORDER BY array_position(f.m,member_id))=ARRAY[100,89,100]
    FROM faab_balances WHERE league_season_id=f.s),'only winner pays');
  PERFORM pg_temp.check_that((SELECT array_agg(priority ORDER BY array_position(f.m,member_id))=ARRAY[1,4,3]
    FROM waiver_priorities WHERE league_season_id=f.s),'winner last and losers retain priority');
  PERFORM pg_temp.check_that((SELECT count(*)=1 FROM roster_transactions WHERE related_claim_id=d AND transaction_type='waiver_add'),'winner transaction once');
  PERFORM pg_temp.drain();
  PERFORM pg_temp.check_that((SELECT balance=89 FROM faab_balances WHERE member_id=f.m[2] AND league_season_id=f.s),'retry does not debit twice');
  q:=pg_temp.player();
  c:=pg_temp.claim(f,1,q,0);
  PERFORM pg_temp.drain();
  PERFORM pg_temp.check_that((SELECT status='succeeded' FROM waiver_claims WHERE id=c),'zero bid clears exactly at clears_at');
  PERFORM pg_temp.check_that((SELECT balance=100 FROM faab_balances WHERE member_id=f.m[1] AND league_season_id=f.s),'zero bid is free');
  PERFORM pg_temp.expect_error(format('SELECT create_waiver_claim_atomic(%L,%L,%L,NULL,%L,101)',f.l,f.m[1],pg_temp.player(),f.u[1]),'P0001','FAAB bid exceeds');
  PERFORM pg_temp.expect_error(format('SELECT create_waiver_claim_atomic(%L,%L,%L,NULL,%L,-1)',f.l,f.m[1],pg_temp.player(),f.u[1]),'22023','non-negative');
  PERFORM pg_temp.check_that(public.commissioner_adjust_faab_balance_atomic(f.l,f.m[1],7)=7,'commissioner absolute balance');
  PERFORM pg_temp.check_that(public.commissioner_adjust_faab_balance_atomic(f.l,f.m[1],0)=0,'commissioner zero balance');
  PERFORM public.commissioner_adjust_faab_balance_atomic(f.l,f.m[1],7);
  p:=pg_temp.player(); q:=pg_temp.player();
  c:=pg_temp.claim(f,1,p,7,1); d:=pg_temp.claim(f,1,q,7,2);
  PERFORM pg_temp.drain();
  PERFORM pg_temp.check_that((SELECT status='succeeded' FROM waiver_claims WHERE id=c),'exact balance wins');
  PERFORM pg_temp.check_that((SELECT status='failed_priority' AND failure_reason='Insufficient FAAB budget for this bid.' FROM waiver_claims WHERE id=d),'later claim rechecks balance');
  PERFORM pg_temp.check_that((SELECT balance=0 FROM faab_balances WHERE member_id=f.m[1] AND league_season_id=f.s),'exact debit');
  PERFORM private.ensure_faab_balance(f.l,f.s,member_id) FROM unnest(f.m) member_id;
  PERFORM pg_temp.check_that(private.ensure_faab_balance(f.l,f.s,f.m[1])=0,'ensure never replenishes spent money');
  DELETE FROM faab_balances WHERE member_id=f.m[3] AND league_season_id=f.s;
  PERFORM pg_temp.check_that(private.ensure_faab_balance(f.l,f.s,f.m[3])=100,'lazy balance matches configured budget');
  PERFORM pg_temp.expect_error(format('SELECT commissioner_adjust_faab_balance_atomic(%L,%L,-1)',f.l,f.m[1]),'22023','non-negative');
  PERFORM set_config('request.jwt.claim.sub',f.u[2]::text,true);
  PERFORM pg_temp.expect_error(format('SELECT commissioner_adjust_faab_balance_atomic(%L,%L,100)',f.l,f.m[1]),'42501','Only the league commissioner');
  RAISE NOTICE 'PASS FAAB bidding, ties, losers, exact/zero balances, retries, ordered spending, adjustment';
END $$;
DO $$
DECLARE f pg_temp.fixture; p uuid; q uuid; r uuid; c uuid; d uuid; e uuid; first_id uuid;
BEGIN
  f:=pg_temp.setup('rolling',NULL,1); p:=pg_temp.player(); q:=pg_temp.player();
  c:=pg_temp.claim(f,1,p,90,1); d:=pg_temp.claim(f,1,q,80,2); e:=pg_temp.claim(f,2,q,70,1);
  PERFORM pg_temp.check_that((SELECT bid_amount=0 FROM waiver_claims WHERE id=c),'rolling ignores bid');
  PERFORM public.reorder_waiver_claim_atomic(d,f.m[1],f.u[1],'up');
  PERFORM pg_temp.check_that((SELECT claim_order=1 FROM waiver_claims WHERE id=d),'reorder up');
  PERFORM public.reorder_waiver_claim_atomic(d,f.m[1],f.u[1],'down');
  PERFORM pg_temp.check_that((SELECT claim_order=2 FROM waiver_claims WHERE id=d),'reorder down');
  SELECT claim_id INTO first_id FROM process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date) LIMIT 1;
  PERFORM pg_temp.check_that(first_id=c,'rolling preference wins first across players');
  PERFORM pg_temp.drain();
  PERFORM pg_temp.check_that((SELECT status='succeeded' FROM waiver_claims WHERE id=e),'updated priority changes next player winner');
  PERFORM pg_temp.check_that((SELECT status='failed_priority' FROM waiver_claims WHERE id=d),'loser marked');
  PERFORM pg_temp.check_that((SELECT array_agg(member_id ORDER BY priority)=ARRAY[f.m[3],f.m[1],f.m[2]]
    FROM waiver_priorities WHERE league_season_id=f.s),'successive winners move last');
  r:=pg_temp.player(); c:=pg_temp.claim(f,1,r);
  PERFORM pg_temp.drain();
  PERFORM pg_temp.check_that((SELECT status='failed_roster' AND failure_reason='Roster full and no drop player specified.' FROM waiver_claims WHERE id=c),'roster full fails');
  PERFORM pg_temp.check_that((SELECT priority=4 FROM waiver_priorities WHERE member_id=f.m[1] AND league_season_id=f.s),'failure preserves priority');
  PERFORM pg_temp.check_that((SELECT balance=100 FROM faab_balances WHERE member_id=f.m[1] AND league_season_id=f.s),'rolling never debits');
  f:=pg_temp.setup('rolling'); p:=pg_temp.player(); q:=pg_temp.player();
  c:=pg_temp.claim(f,1,p); d:=pg_temp.claim(f,2,q);
  UPDATE waiver_claims SET process_date=process_date-1 WHERE id=d;
  SELECT claim_id INTO first_id FROM process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date) LIMIT 1;
  PERFORM pg_temp.check_that(first_id=d,'earlier process date precedes priority');
  PERFORM pg_temp.drain();
  f:=pg_temp.setup('faab'); p:=pg_temp.player(); q:=pg_temp.player(); r:=pg_temp.player();
  c:=pg_temp.claim(f,1,p,2,1); d:=pg_temp.claim(f,1,q,2,2); e:=pg_temp.claim(f,1,r,2,3);
  PERFORM public.reorder_waiver_claim_atomic(d,f.m[1],f.u[1],'up');
  PERFORM pg_temp.check_that((SELECT array_agg(id ORDER BY claim_order)=ARRAY[d,c,e] FROM waiver_claims WHERE member_id=f.m[1]),'reorder preserves every other preference');
  PERFORM pg_temp.drain();
  RAISE NOTICE 'PASS rolling preference, simultaneous groups, order after success/failure, roster cap';
END $$;
DO $$
DECLARE f pg_temp.fixture; p uuid; q uuid; c uuid; d uuid; used int;
BEGIN
  f:=pg_temp.setup('faab',2); p:=pg_temp.player(); q:=pg_temp.player();
  c:=pg_temp.claim(f,1,p,5); d:=pg_temp.claim(f,1,q,4);
  PERFORM public.add_free_agent_atomic(f.m[1],f.l,pg_temp.player());
  PERFORM pg_temp.drain();
  PERFORM pg_temp.check_that((SELECT status='succeeded' FROM waiver_claims WHERE id=c),'one FA and one waiver share limit');
  PERFORM pg_temp.check_that((SELECT status='failed_roster' AND failure_reason LIKE 'Weekly add limit reached (2/2 adds used this week). Adds reset % ET.' FROM waiver_claims WHERE id=d),'processing rechecks limit and reports reset');
  PERFORM pg_temp.check_that((SELECT add_count=2 FROM weekly_add_counts WHERE member_id=f.m[1] AND league_season_id=f.s AND week_number=1),'successes count once and failure does not count');
  PERFORM pg_temp.check_that((SELECT balance=95 FROM faab_balances WHERE member_id=f.m[1] AND league_season_id=f.s),'limit failure keeps money');
  PERFORM pg_temp.expect_error(format('SELECT add_free_agent_atomic(%L,%L,%L)',f.m[1],f.l,pg_temp.player()),'PA001','Weekly add limit reached (2/2');
  PERFORM pg_temp.expect_error(format('SELECT create_waiver_claim_atomic(%L,%L,%L,NULL,%L,0)',f.l,f.m[1],pg_temp.player(),f.u[1]),'PA001','Weekly add limit reached (2/2');
  PERFORM pg_temp.check_that(public.commissioner_override_weekly_add_count_atomic(f.l,f.m[1],1)=1,'override absolute count');
  PERFORM pg_temp.check_that(public.commissioner_override_weekly_add_count_atomic(f.l,f.m[1],0)=0,'override zero');
  PERFORM pg_temp.expect_error(format('SELECT commissioner_override_weekly_add_count_atomic(%L,%L,-1)',f.l,f.m[1]),'22023','non-negative');
  PERFORM public.add_free_agent_atomic(f.m[1],f.l,pg_temp.player());
  PERFORM pg_temp.check_that((SELECT add_count=1 FROM weekly_add_counts WHERE member_id=f.m[1] AND league_season_id=f.s AND week_number=1),'override takes effect');
  PERFORM pg_temp.check_that(private.weekly_add_limit_reached(NULL,2)=false AND private.weekly_add_limit_reached(2,2)
    AND private.weekly_add_limit_reached(3,2) AND NOT private.weekly_add_limit_reached(100,NULL),'limit null and boundary truth table');
  f:=pg_temp.setup('rolling');
  PERFORM public.add_free_agent_atomic(f.m[1],f.l,pg_temp.player());
  PERFORM pg_temp.check_that((SELECT count(*)=0 FROM weekly_add_counts WHERE league_season_id=f.s),'unlimited does not create counts');
  RAISE NOTICE 'PASS shared FA/waiver limits, failure preservation, override, null limits';
END $$;
DO $$
DECLARE f pg_temp.fixture; p uuid; q uuid; drop_id uuid; c uuid; d uuid;
BEGIN
  f:=pg_temp.setup('faab',3,1); drop_id:=pg_temp.player(); p:=pg_temp.player(); q:=pg_temp.player();
  PERFORM public.add_free_agent_atomic(f.m[1],f.l,drop_id);
  c:=pg_temp.claim(f,1,p,5,1,drop_id); d:=pg_temp.claim(f,1,q,4,2,drop_id);
  PERFORM pg_temp.drain();
  PERFORM pg_temp.check_that((SELECT status='succeeded' AND drop_player_id=drop_id FROM waiver_claims WHERE id=c),'winning claim preserves drop history');
  PERFORM pg_temp.check_that((SELECT status='failed_roster' AND drop_player_id IS NULL AND failure_reason='Roster full and no drop player specified.' FROM waiver_claims WHERE id=d),'prior win clears reused drop then fails full roster');
  PERFORM pg_temp.check_that((SELECT add_count=2 FROM weekly_add_counts WHERE member_id=f.m[1] AND league_season_id=f.s),'failed reused drop consumes no add');
  PERFORM pg_temp.check_that((SELECT balance=95 FROM faab_balances WHERE member_id=f.m[1] AND league_season_id=f.s),'failed reused drop consumes no FAAB');
  PERFORM pg_temp.check_that((SELECT count(*)=1 AND bool_and(player_id=p) FROM roster_players WHERE member_id=f.m[1] AND league_season_id=f.s),'atomic drop/add roster');
  RAISE NOTICE 'PASS an earlier win invalidates a shared drop without charging the later failure';
END $$;
DO $$
DECLARE f pg_temp.fixture; p uuid; injured uuid; c uuid; rid uuid;
BEGIN
  f:=pg_temp.setup('faab',3); injured:=pg_temp.player(); p:=pg_temp.player();
  UPDATE leagues SET ir_slots=1 WHERE id=f.l;
  UPDATE players SET injury_status='Out' WHERE id=injured;
  PERFORM public.add_free_agent_atomic(f.m[1],f.l,injured);
  SELECT id INTO rid FROM roster_players WHERE member_id=f.m[1] AND player_id=injured;
  PERFORM public.toggle_ir_atomic(rid,true,f.u[1]);
  c:=pg_temp.claim(f,1,p,10);
  UPDATE players SET injury_status=NULL WHERE id=injured;
  PERFORM pg_temp.drain();
  PERFORM pg_temp.check_that((SELECT status='failed_roster' AND failure_reason LIKE 'You have ineligible players on IR (%' FROM waiver_claims WHERE id=c),'IR recovery invalidates pending claim');
  PERFORM pg_temp.check_that((SELECT balance=100 FROM faab_balances WHERE member_id=f.m[1] AND league_season_id=f.s),'IR failure keeps FAAB');
  PERFORM pg_temp.check_that((SELECT add_count=1 FROM weekly_add_counts WHERE member_id=f.m[1] AND league_season_id=f.s),'IR failure consumes no add');
  PERFORM pg_temp.expect_error(format('SELECT create_waiver_claim_atomic(%L,%L,%L,NULL,%L,0)',f.l,f.m[1],p,f.u[1]),'P0001','ineligible players on IR');
  RAISE NOTICE 'PASS IR eligibility at submission and processing preserves budget and counts';
END $$;
DO $$
DECLARE f pg_temp.fixture; p uuid; c uuid; wk record; today date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  f:=pg_temp.setup('faab',1);
  PERFORM public.update_league_settings_atomic(f.l,'{"skipped_weeks":[1]}');
  PERFORM pg_temp.check_that((SELECT skipped_weeks=ARRAY[1] FROM league_seasons WHERE id=f.s),'skip through settings');
  SELECT * INTO wk FROM private.current_add_week(f.l,f.s);
  PERFORM pg_temp.check_that(wk.week_number=1 AND wk.resets_at=(today+4)::timestamp AT TIME ZONE 'America/New_York','skipped week calendar bucket and ET reset');
  p:=pg_temp.player(); c:=pg_temp.claim(f,1,p,5);
  PERFORM pg_temp.drain();
  PERFORM pg_temp.check_that((SELECT status='succeeded' FROM waiver_claims WHERE id=c),'waivers process in skipped week');
  PERFORM pg_temp.check_that((SELECT add_count=1 AND week_number=1 FROM weekly_add_counts WHERE member_id=f.m[1] AND league_season_id=f.s),'skipped week uses its own limit');
  PERFORM pg_temp.check_that((SELECT balance=95 FROM faab_balances WHERE member_id=f.m[1] AND league_season_id=f.s),'skipping does not reseed FAAB');
  UPDATE season_weeks SET week_start=today-7,week_end=today-1 WHERE season_year=2187 AND week_number=1;
  UPDATE season_weeks SET week_start=today,week_end=today+6 WHERE season_year=2187 AND week_number=2;
  SELECT * INTO wk FROM private.current_add_week(f.l,f.s);
  PERFORM pg_temp.check_that(wk.week_number=2 AND wk.resets_at=(today+7)::timestamp AT TIME ZONE 'America/New_York','first eligible week retains number and resets at ET midnight');
  p:=pg_temp.player(); c:=pg_temp.claim(f,2,p,0);
  PERFORM pg_temp.drain();
  PERFORM pg_temp.check_that((SELECT status='succeeded' FROM waiver_claims WHERE id=c),'first eligible week processes a waiver');
  PERFORM pg_temp.check_that((SELECT count(*)=1 AND min(week_number)=2 AND min(add_count)=1 FROM weekly_add_counts WHERE member_id=f.m[2] AND league_season_id=f.s),'first eligible waiver consumes only week 2');
  PERFORM public.add_free_agent_atomic(f.m[1],f.l,pg_temp.player());
  PERFORM pg_temp.check_that((SELECT array_agg(add_count ORDER BY week_number)=ARRAY[1,1] FROM weekly_add_counts WHERE member_id=f.m[1] AND league_season_id=f.s),'first eligible week has a fresh limit');
  PERFORM pg_temp.expect_error(format('SELECT add_free_agent_atomic(%L,%L,%L)',f.m[1],f.l,pg_temp.player()),'PA001','1/1 adds used');
  RAISE NOTICE 'PASS skipped week 1 and first eligible week 2: calendar reset, counts, FAAB';
END $$;
DO $$
DECLARE f pg_temp.fixture; p uuid; q uuid; c uuid; next_id uuid; old_order uuid[]; rid uuid;
BEGIN
  f:=pg_temp.setup();
  PERFORM public.update_league_settings_atomic(f.l,'{"faab_starting_budget":37}');
  PERFORM public.commissioner_adjust_faab_balance_atomic(f.l,f.m[1],7);
  p:=pg_temp.player();
  PERFORM public.add_free_agent_atomic(f.m[1],f.l,p);
  SELECT id INTO rid FROM roster_players WHERE league_season_id=f.s AND player_id=p;
  PERFORM public.drop_player_atomic(rid);
  PERFORM pg_temp.check_that((SELECT clears_at>=placed_on_waivers_at+interval '48 hours'
    AND (clears_at AT TIME ZONE 'America/New_York')::time=time '03:00'
    AND ((clears_at AT TIME ZONE 'America/New_York')-interval '1 day') AT TIME ZONE 'America/New_York'
      < placed_on_waivers_at+interval '48 hours'
    FROM waiver_wire_log WHERE league_season_id=f.s AND player_id=p),'drop clears at the first 03:00 ET after 48 hours');
  c:=public.create_waiver_claim_atomic(f.l,f.m[2],p,NULL,f.u[2],1);
  PERFORM pg_temp.drain();
  PERFORM pg_temp.check_that((SELECT status='pending' FROM waiver_claims WHERE id=c),'future clear does not process early');
  UPDATE leagues SET status='playoffs' WHERE id=f.l;
  PERFORM pg_temp.expect_error(format('SELECT advance_season_atomic(%L)',f.l),'P0001','pending waiver');
  PERFORM public.cancel_waiver_claim_atomic(c,f.m[2],f.u[2]);
  PERFORM pg_temp.expect_error(format('SELECT advance_season_atomic(%L)',f.l),'P0001','waiver holds');
  UPDATE waiver_wire_log SET clears_at=now()-interval '1 second' WHERE league_season_id=f.s;
  PERFORM public.expire_waiver_wire_logs();
  UPDATE waiver_priorities SET priority=CASE member_id WHEN f.m[1] THEN 9 WHEN f.m[2] THEN 8 ELSE 7 END WHERE league_season_id=f.s;
  SELECT new_season_id INTO next_id FROM public.advance_season_atomic(f.l);
  PERFORM pg_temp.check_that((SELECT count(*)=3 AND min(balance)=37 AND max(balance)=37 FROM faab_balances WHERE league_season_id=next_id),'rollover resets FAAB to configured starting budget');
  PERFORM pg_temp.check_that((SELECT balance=7 FROM faab_balances WHERE member_id=f.m[1] AND league_season_id=f.s),'rollover preserves prior balance history');
  SELECT array_agg(id ORDER BY id) INTO old_order FROM league_members WHERE league_id=f.l;
  PERFORM pg_temp.check_that((SELECT array_agg(member_id ORDER BY priority)=old_order FROM waiver_priorities WHERE league_season_id=next_id),'rollover rebuilds order from tied standings and member id');
  PERFORM public.commissioner_adjust_faab_balance_atomic(f.l,f.m[1],6);
  PERFORM private.ensure_faab_balance(f.l,next_id,member_id) FROM unnest(f.m) member_id;
  PERFORM pg_temp.check_that((SELECT balance=6 FROM faab_balances WHERE member_id=f.m[1] AND league_season_id=next_id),'rollover budget applied once');
  PERFORM pg_temp.expect_error(format('SELECT advance_season_atomic(%L)',f.l),'P0001','before advancing season');
  RAISE NOTICE 'PASS drop timing, future processing, pending rollover guard, balance reset/history/idempotence, priority reset';
END $$;
ROLLBACK;
