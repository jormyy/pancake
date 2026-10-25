\getenv notif_test_db SUPABASE_DB_URL
\getenv notif_test_port PANCAKE_TEST_DB_PORT
\if :{?notif_test_db}
\else
  \echo SUPABASE_DB_URL is required
  \quit 3
\endif
\if :{?notif_test_port}
\else
  \set notif_test_port 54322
\endif
SELECT set_config('notif.test_db', :'notif_test_db',false) \gset
SELECT set_config('notif.test_port', :'notif_test_port',false) \gset
DO $$ BEGIN
  IF current_setting('notif.test_port') !~ '^[0-9]+$' OR current_setting('notif.test_db') !~
    format('^postgres(ql)?://[^/@]+@(127[.]0[.]0[.]1|localhost):%s/[^?]+([?].*)?$',current_setting('notif.test_port')) THEN
    RAISE EXCEPTION 'Only the expected loopback database port is allowed';
  END IF;
END $$;
BEGIN;
CREATE TEMP TABLE notif_fixture AS SELECT gen_random_uuid() AS league,gen_random_uuid() AS other_league,
  gen_random_uuid() AS season,gen_random_uuid() AS prior_season,
  gen_random_uuid() AS owner,gen_random_uuid() AS opponent,gen_random_uuid() AS outsider,
  gen_random_uuid() AS member,gen_random_uuid() AS other_member,gen_random_uuid() AS foreign_member,
  gen_random_uuid() AS same_user_foreign_member;
INSERT INTO auth.users(id,email,raw_user_meta_data)
SELECT id,id::text || '@example.test',jsonb_build_object('username',id::text)
FROM notif_fixture f CROSS JOIN LATERAL unnest(ARRAY[f.owner,f.opponent,f.outsider]) id;
INSERT INTO leagues(id,name,slug,commissioner_id,status,weekly_add_limit)
SELECT league,'Notification fixture',league::text,owner,'offseason'::league_status,2 FROM notif_fixture
UNION ALL SELECT other_league,'Other fixture',other_league::text,outsider,'offseason'::league_status,2 FROM notif_fixture;
INSERT INTO league_members(id,league_id,user_id,role,team_name)
SELECT member,league,owner,'commissioner'::league_member_role,'Owner' FROM notif_fixture
UNION ALL SELECT other_member,league,opponent,'manager','Opponent' FROM notif_fixture
UNION ALL SELECT foreign_member,other_league,outsider,'commissioner','Outside' FROM notif_fixture
UNION ALL SELECT same_user_foreign_member,other_league,owner,'manager','Same user, other league' FROM notif_fixture;
INSERT INTO league_seasons(id,league_id,season_year,is_current)
SELECT prior_season,league,20025,false FROM notif_fixture
UNION ALL SELECT season,league,20026,true FROM notif_fixture;
INSERT INTO notification_preferences(user_id,event_settings)
SELECT owner,(SELECT jsonb_object_agg(event_type,true) FROM notif_event_catalog) FROM notif_fixture
UNION ALL SELECT opponent,(SELECT jsonb_object_agg(event_type,true) FROM notif_event_catalog) FROM notif_fixture;
CREATE TEMP TABLE expected_notifications(id uuid PRIMARY KEY);
CREATE FUNCTION pg_temp.expect_event(event text, recipients uuid[], filter_key text, filter_value text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual uuid[]; n int;
BEGIN
  SELECT array_agg(member_id ORDER BY member_id),count(*) INTO actual,n FROM notification_outbox
    WHERE event_type=event AND data->>filter_key=filter_value;
  IF n <> cardinality(recipients) OR actual IS DISTINCT FROM (SELECT array_agg(id ORDER BY id) FROM unnest(recipients) id) THEN
    RAISE EXCEPTION 'event % recipients %, expected %',event,actual,recipients;
  END IF;
  INSERT INTO expected_notifications SELECT id FROM notification_outbox WHERE event_type=event AND data->>filter_key=filter_value;
END $$;
UPDATE notification_preferences SET event_settings = (SELECT jsonb_object_agg(event_type,NOT :'notif_disabled'::boolean) FROM notif_event_catalog)
WHERE user_id IN (SELECT owner FROM notif_fixture UNION ALL SELECT opponent FROM notif_fixture);
DO $$
DECLARE f record; trade_id uuid; player uuid:=gen_random_uuid(); claim uuid; matchup uuid:=gen_random_uuid();
  final_match record; token jsonb; payload jsonb; next_season uuid; t timestamptz:='2026-10-21 16:00:00+00';
BEGIN
  SELECT * INTO f FROM notif_fixture;
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
  SELECT 20026,w,date '2026-10-20'+(w-1)*7,date '2026-10-26'+(w-1)*7 FROM generate_series(1,4) w;
  UPDATE leagues SET status='active',trade_veto_mode='disabled',waiver_mode='faab',roster_size=20,weekly_add_limit=NULL,
    playoff_start_week=2,playoff_entrants=2,playoff_round_lengths=ARRAY[1],trade_deadline='20027-02-15' WHERE id=f.league;
  INSERT INTO waiver_priorities(league_id,league_season_id,member_id,priority)
    VALUES(f.league,f.season,f.member,1),(f.league,f.season,f.other_member,2);
  INSERT INTO faab_balances(league_id,league_season_id,member_id,balance)
  SELECT f.league,f.season,m,100 FROM unnest(ARRAY[f.member,f.other_member]) m
  ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;
  trade_id := propose_trade_atomic(f.league,f.season,f.member,f.other_member,
    ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],'Synthetic offer',now()+interval '1 day',1,1);
  PERFORM pg_temp.expect_event('trade_offered',ARRAY[f.other_member],'tradeId',trade_id::text);
  PERFORM accept_trade_atomic(trade_id,f.other_member);
  PERFORM pg_temp.expect_event('trade_accepted',ARRAY[f.member],'tradeId',trade_id::text);
  trade_id := propose_trade_atomic(f.league,f.season,f.member,f.other_member,
    ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],'Synthetic reject',now()+interval '1 day',1,1);
  PERFORM reject_trade_atomic(trade_id,f.other_member,f.opponent);
  PERFORM pg_temp.expect_event('trade_rejected',ARRAY[f.member],'tradeId',trade_id::text);
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team)
    VALUES(player,'Synthetic','Settlement','PG',ARRAY['PG'],'Active','BOS');
  INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at,clears_at)
    VALUES(f.league,f.season,player,now()-interval '1 hour',now()+interval '47 hours');
  PERFORM create_waiver_claim_atomic(f.league,f.member,player,NULL,f.owner,5,1);
  PERFORM create_waiver_claim_atomic(f.league,f.other_member,player,NULL,f.opponent,3,1);
  UPDATE waiver_wire_log SET clears_at=now()-interval '1 minute' WHERE league_id=f.league;
  UPDATE waiver_claims SET process_date=current_date-1 WHERE league_id=f.league;
  PERFORM * FROM process_due_waiver_claims_atomic(current_date,100);
  SELECT id INTO claim FROM waiver_claims WHERE member_id=f.member AND player_id=player AND status='succeeded';
  IF claim IS NULL THEN RAISE EXCEPTION 'real waiver settlement did not select the higher bid'; END IF;
  PERFORM pg_temp.expect_event('waiver_claim_won',ARRAY[f.member],'claimId',claim::text);
  SELECT id INTO claim FROM waiver_claims WHERE member_id=f.other_member AND player_id=player AND status='failed_priority';
  IF claim IS NULL THEN RAISE EXCEPTION 'real waiver settlement did not reject the lower bid'; END IF;
  PERFORM pg_temp.expect_event('waiver_claim_lost',ARRAY[f.other_member],'claimId',claim::text);
  PERFORM * FROM process_due_waiver_claims_atomic(current_date,100);
  UPDATE players SET injury_status='Out' WHERE id=player;
  PERFORM pg_temp.expect_event('owned_player_ruled_out',ARRAY[f.member],'playerId',player::text);
  UPDATE players SET injury_status='Out' WHERE id=player;
  PERFORM pg_temp.expect_event('owned_player_status',ARRAY[f.member],'playerId',player::text);
  INSERT INTO matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(matchup,f.league,f.season,1,f.member,f.other_member);
  PERFORM notif_scan_due_atomic(t);
  PERFORM notif_scan_due_atomic(t);
  PERFORM pg_temp.expect_event('matchup_started',ARRAY[f.member,f.other_member],'matchupId',matchup::text);
  token := capture_score_inputs(f.season,1);
  payload := jsonb_build_array(jsonb_build_object('id',matchup,'input_token',token,'home_points',10,'away_points',5,'winner_member_id',f.member));
  PERFORM finalize_score_week_atomic(f.league,f.season,1,payload,'[]');
  payload := jsonb_set(payload,'{0,input_token}',capture_score_inputs(f.season,1));
  PERFORM finalize_score_week_atomic(f.league,f.season,1,payload,'[]');
  PERFORM pg_temp.expect_event('matchup_final',ARRAY[f.member,f.other_member],'matchupId',matchup::text);
  PERFORM generate_playoff_bracket_atomic(f.league);
  PERFORM generate_playoff_bracket_atomic(f.league);
  PERFORM pg_temp.expect_event('playoff_seeding',ARRAY[f.member,f.other_member],'leagueSeasonId',f.season::text);
  SELECT * INTO final_match FROM matchups WHERE league_season_id=f.season AND matchup_type='playoff_final';
  IF final_match.id IS NULL THEN RAISE EXCEPTION 'bracket did not produce final'; END IF;
  token := capture_score_inputs(f.season,final_match.week_number);
  payload := jsonb_build_array(jsonb_build_object('id',final_match.id,'input_token',token,'home_points',10,'away_points',5,'winner_member_id',final_match.home_member_id));
  PERFORM finalize_score_week_atomic(f.league,f.season,final_match.week_number,payload,'[]');
  payload := jsonb_set(payload,'{0,input_token}',capture_score_inputs(f.season,final_match.week_number));
  PERFORM finalize_score_week_atomic(f.league,f.season,final_match.week_number,payload,'[]');
  PERFORM pg_temp.expect_event('playoff_eliminated',ARRAY[final_match.away_member_id],'matchupId',final_match.id::text);
  PERFORM pg_temp.expect_event('champion',ARRAY[f.member,f.other_member],'matchupId',final_match.id::text);
  DELETE FROM notification_outbox WHERE event_type='league_settings_changed' AND member_id IN (f.member,f.other_member);
  PERFORM set_config('request.jwt.claim.sub',f.owner::text,true);
  PERFORM update_league_settings_atomic(f.league,'{"allow_inactive_trades":true}');
  PERFORM pg_temp.expect_event('league_settings_changed',ARRAY[f.member,f.other_member],'leagueId',f.league::text);
  PERFORM update_league_settings_atomic(f.league,'{"allow_inactive_trades":true}');
  PERFORM notif_scan_due_atomic('20026-02-12 16:00:00+00');
  PERFORM notif_scan_due_atomic('20026-02-12 16:00:00+00');
  PERFORM pg_temp.expect_event('trade_deadline_approaching',ARRAY[f.member,f.other_member],'leagueSeasonId',f.season::text);
  UPDATE leagues SET status='playoffs' WHERE id=f.league;
  SELECT new_season_id INTO next_season FROM advance_season_atomic(f.league);
  PERFORM pg_temp.expect_event('season_rollover',ARRAY[f.member,f.other_member],'leagueSeasonId',next_season::text);
END $$;
DO $$
DECLARE f record; r record; before_count int; disabled boolean;
BEGIN
  SELECT * INTO f FROM notif_fixture;
  SELECT NOT (event_settings->>'trade_offered')::boolean INTO disabled FROM notification_preferences WHERE user_id=f.owner;
  SELECT count(*) INTO before_count FROM expected_notifications;
  IF before_count < 20 THEN RAISE EXCEPTION 'producer coverage missing: %',before_count; END IF;
  IF EXISTS (SELECT 1 FROM notification_outbox WHERE member_id IN (f.foreign_member,f.same_user_foreign_member)) THEN
    RAISE EXCEPTION 'producer disclosed another league to a multi-league user';
  END IF;
  FOR r IN SELECT * FROM claim_notification_outbox_atomic(200,60) LOOP
    IF NOT notif_admit_delivery_atomic(r.id,r.claim_token) THEN RAISE EXCEPTION 'valid producer unexpectedly suppressed'; END IF;
    PERFORM fail_notification_outbox_atomic(r.id,r.claim_token,'Synthetic retry');
  END LOOP;
  UPDATE notification_outbox SET available_at=now(),claimed_at=NULL,claim_token=NULL WHERE member_id IN (f.member,f.other_member);
  FOR r IN SELECT * FROM claim_notification_outbox_atomic(200,60) LOOP
    IF NOT complete_notification_outbox_atomic(r.id,r.claim_token) THEN RAISE EXCEPTION 'retry failed to complete'; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM expected_notifications e JOIN notification_outbox o USING(id)
    WHERE (disabled AND (o.suppressed_at IS NULL OR o.suppression_reason <> 'preferences_disabled' OR o.delivered_at IS NOT NULL))
       OR (NOT disabled AND o.delivered_at IS NULL)) THEN RAISE EXCEPTION 'producer delivery or suppression evidence missing'; END IF;
  UPDATE notification_preferences SET event_settings=(SELECT jsonb_object_agg(event_type,true) FROM notif_event_catalog) WHERE user_id IN (f.owner,f.opponent);
  IF EXISTS (SELECT 1 FROM claim_notification_outbox_atomic(200,60) c JOIN expected_notifications e USING(id)) THEN
    RAISE EXCEPTION 'producer duplicated a delivered or suppressed occurrence';
  END IF;
  RAISE NOTICE '% actual-producer notifications verified; disabled=%; retries and multi-league recipients pass',before_count,disabled;
END $$;
ROLLBACK;
