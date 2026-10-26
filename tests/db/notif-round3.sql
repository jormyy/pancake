\set ON_ERROR_STOP on
\getenv notif_test_db SUPABASE_DB_URL
\getenv notif_test_port PANCAKE_TEST_DB_PORT
\if :{?notif_test_db}
\else
  \echo SUPABASE_DB_URL is required
  DO $$ BEGIN RAISE EXCEPTION 'Database test configuration is missing or invalid.'; END $$;
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
  gen_random_uuid() AS same_user_foreign_member,
  (SELECT candidate FROM generate_series(20026,29999) candidate
   WHERE NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=candidate)
     AND NOT EXISTS(SELECT 1 FROM season_weeks WHERE season_year=candidate)
     AND NOT EXISTS(SELECT 1 FROM league_seasons WHERE season_year=candidate)
   ORDER BY candidate LIMIT 1) AS fixture_year;
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
SELECT prior_season,league,fixture_year-1,false FROM notif_fixture
UNION ALL SELECT season,league,fixture_year,true FROM notif_fixture;
INSERT INTO notification_preferences(user_id,event_settings)
SELECT owner,(SELECT jsonb_object_agg(event_type,true) FROM notif_event_catalog) FROM notif_fixture
UNION ALL SELECT opponent,(SELECT jsonb_object_agg(event_type,true) FROM notif_event_catalog) FROM notif_fixture;
\if :{?notif_case}
\else
\set notif_case all
\endif
\if :{?notif_pref}
\else
\set notif_pref enabled
\endif
CREATE TEMP TABLE notif_resources(players uuid[],games uuid[],calendar jsonb);
SELECT set_config('notif.pref', :'notif_pref', true) \gset
SELECT set_config('notif.case', :'notif_case', true) \gset
DO $$
DECLARE f record; p uuid := gen_random_uuid(); bench uuid := gen_random_uuid(); game uuid := gen_random_uuid(); m uuid := gen_random_uuid(); a uuid; w uuid; tip timestamptz:=now()+interval '2 hours'; r record; mode text; event text; category text;
  today date := (clock_timestamp() AT TIME ZONE 'America/New_York')::date;
BEGIN
  SELECT * INTO f FROM notif_fixture;
  INSERT INTO notif_resources VALUES(ARRAY[p,bench],ARRAY[game],(SELECT to_jsonb(sw) FROM season_weeks sw WHERE season_year=f.fixture_year AND week_number=1));
  UPDATE leagues SET status='active' WHERE id=f.league;
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(f.fixture_year,1,today,today) ON CONFLICT(season_year,week_number) DO UPDATE SET week_start=EXCLUDED.week_start,week_end=EXCLUDED.week_end;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,nba_team,injury_status)
    VALUES(p,'Notify','Inactive','PG',ARRAY['PG'],p::text,'Out'),(bench,'Notify','Bench','SG',ARRAY['SG'],bench::text,NULL);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league,f.season,f.member,p,'draft'),(f.league,f.season,f.member,bench,'draft');
  INSERT INTO nba_games(id,sportsdata_game_id,season_year,game_date,week_number,home_team,away_team,status,game_time)
    VALUES(game,game::text,f.fixture_year,today,1,p::text,bench::text,'Scheduled',tip);
  INSERT INTO weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type)
    VALUES(f.league,f.season,f.member,p,1,today,'PG');
  IF current_setting('notif.case') IN ('all','lineup') THEN
    PERFORM notif_scan_due_atomic(); PERFORM notif_scan_due_atomic();
    IF (SELECT count(*) FROM notification_outbox WHERE member_id=f.member AND event_type='lineup_inactive')<>1 THEN RAISE EXCEPTION 'inactive starter real scanner must enqueue once'; END IF;
    IF (SELECT count(*) FROM notification_outbox WHERE member_id=f.member AND event_type='lineup_empty')<>1 THEN RAISE EXCEPTION 'empty fillable starter real scanner must enqueue once'; END IF;
    IF EXISTS(SELECT 1 FROM notification_outbox WHERE event_type LIKE 'lineup_%' AND member_id IN(f.other_member,f.foreign_member,f.same_user_foreign_member)) THEN RAISE EXCEPTION 'lineup recipient leak'; END IF;
    IF EXISTS(SELECT 1 FROM private.notif_lineup_candidates(tip-interval '2 hours 1 microsecond') WHERE member_id=f.member) THEN RAISE EXCEPTION 'lineup window starts too early'; END IF;
    IF (SELECT count(*) FROM private.notif_lineup_candidates(tip-interval '2 hours') WHERE member_id=f.member)<>2 THEN RAISE EXCEPTION 'two-hour window boundary excluded'; END IF;
    UPDATE players SET injury_status=NULL,status='Active' WHERE id=p;
    IF NOT private.notif_is_stale('lineup_inactive',jsonb_build_object('leagueId',f.league,'memberId',f.member,'playerId',p,'gameDate',today)) THEN RAISE EXCEPTION 'recovered starter is not stale'; END IF;
    UPDATE players SET nba_team='NT0' WHERE id=p;
    IF NOT EXISTS(SELECT 1 FROM private.notif_lineup_candidates() WHERE member_id=f.member AND event_type='lineup_inactive') THEN RAISE EXCEPTION 'starter with no game must alert'; END IF;
    UPDATE players SET injury_status='Out',nba_team=p::text WHERE id=p;
    DELETE FROM lineup_slot_templates WHERE league_id=f.league AND slot_type NOT IN ('PG','SG','BE','IR');
    UPDATE roster_players SET is_on_ir=true WHERE player_id=bench AND league_id=f.league;
    IF EXISTS(SELECT 1 FROM private.notif_lineup_candidates() WHERE member_id=f.member AND event_type='lineup_empty') THEN RAISE EXCEPTION 'IR player fills empty slot'; END IF;
    UPDATE roster_players SET is_on_ir=false WHERE player_id=bench AND league_id=f.league;
    UPDATE players SET eligible_positions=ARRAY['PG'] WHERE id=bench;
    IF EXISTS(SELECT 1 FROM private.notif_lineup_candidates() WHERE member_id=f.member AND event_type='lineup_empty') THEN RAISE EXCEPTION 'ineligible bench player fills SG'; END IF;
    UPDATE players SET eligible_positions=ARRAY['SG'] WHERE id=bench;
    UPDATE nba_games SET game_status_text='Postponed' WHERE id=game;
    IF EXISTS(SELECT 1 FROM private.notif_lineup_candidates() WHERE member_id=f.member) THEN RAISE EXCEPTION 'postponed slate remains fillable'; END IF;
    UPDATE nba_games SET game_status_text=NULL,game_time=clock_timestamp()-interval '1 second' WHERE id=game;
    IF NOT private.notif_is_stale('lineup_empty',jsonb_build_object('leagueId',f.league,'memberId',f.member,'gameDate',today)) THEN RAISE EXCEPTION 'locked replacements must stale empty alert'; END IF;
    IF EXISTS(SELECT 1 FROM private.notif_lineup_candidates() WHERE member_id=f.member) THEN RAISE EXCEPTION 'locked lineup generates alert'; END IF;
    UPDATE nba_games SET game_time=tip WHERE id=game;
    FOR r IN SELECT * FROM notification_outbox WHERE member_id=f.member AND event_type IN ('lineup_inactive','lineup_empty') LOOP
      IF current_setting('notif.pref')='event' THEN UPDATE notification_preferences SET event_settings=event_settings || '{"lineup_inactive":false,"lineup_empty":false,"watched_player_dropped":false,"commissioner_announcement":false}' WHERE user_id IN(f.owner,f.opponent);
      ELSIF current_setting('notif.pref')='category' THEN UPDATE notification_preferences SET category_settings='{"lineup":false,"waiver":false,"league":false}' WHERE user_id IN(f.owner,f.opponent);
      ELSIF current_setting('notif.pref')='master' THEN UPDATE notification_preferences SET master_enabled=false WHERE user_id IN(f.owner,f.opponent); END IF;
      PERFORM * FROM claim_notification_outbox_atomic(200,60);
      IF current_setting('notif.pref')<>'enabled' AND NOT EXISTS(SELECT 1 FROM notification_outbox WHERE id=r.id AND suppression_reason='preferences_disabled' AND suppressed_at IS NOT NULL) THEN RAISE EXCEPTION 'lineup opt-out not durable: %',current_setting('notif.pref'); END IF;
    END LOOP;
  END IF;
  IF current_setting('notif.case') IN ('all','watch') THEN
    PERFORM set_config('request.jwt.claim.sub',f.opponent::text,true);
    PERFORM notif_set_player_watch_atomic(f.league,p,true);
    PERFORM notif_set_player_watch_atomic(f.league,p,true);
    PERFORM set_config('request.jwt.claim.sub',f.owner::text,true);
    PERFORM notif_set_player_watch_atomic(f.league,p,true);
    PERFORM notif_set_player_watch_atomic(f.other_league,p,true);
    PERFORM notif_set_player_watch_atomic(f.other_league,bench,true);
    PERFORM notif_set_player_watch_atomic(f.other_league,bench,false);
    PERFORM set_config('request.jwt.claim.sub',f.outsider::text,true);
    BEGIN PERFORM notif_set_player_watch_atomic(f.league,p,true); RAISE EXCEPTION 'outsider can watch league'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub',f.owner::text,true);
    w:=(SELECT id FROM roster_players WHERE league_id=f.league AND player_id=p);
    PERFORM drop_player_atomic(w,f.season,NULL);
    IF (SELECT count(*) FROM notification_outbox WHERE event_type='watched_player_dropped' AND data->>'playerId'=p::text)<>1 OR
      NOT EXISTS(SELECT 1 FROM notification_outbox WHERE event_type='watched_player_dropped' AND member_id=f.other_member AND data->>'playerId'=p::text) THEN RAISE EXCEPTION 'watch recipients must exclude dropper and other league'; END IF;
    BEGIN PERFORM drop_player_atomic(w,f.season,NULL); RAISE EXCEPTION 'drop retry unexpectedly succeeds'; EXCEPTION WHEN no_data_found THEN NULL; END;
    IF (SELECT count(*) FROM notification_outbox WHERE event_type='watched_player_dropped' AND data->>'playerId'=p::text)<>1 THEN RAISE EXCEPTION 'drop retry duplicates watch event'; END IF;
  END IF;
  IF current_setting('notif.case') IN ('all','announcement') THEN
    PERFORM set_config('request.jwt.claim.sub',f.opponent::text,true);
    BEGIN PERFORM notif_publish_announcement_atomic(f.league,'Denied',gen_random_uuid()); RAISE EXCEPTION 'manager published announcement'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub',f.owner::text,true);
    a:=gen_random_uuid();
    PERFORM notif_publish_announcement_atomic(f.league,'Fixture announcement',a);
    PERFORM notif_publish_announcement_atomic(f.league,'Fixture announcement',a);
    IF (SELECT count(*) FROM notification_outbox WHERE event_type='commissioner_announcement' AND data->>'announcementId'=a::text)<>1 OR
      NOT EXISTS(SELECT 1 FROM notification_outbox WHERE event_type='commissioner_announcement' AND member_id=f.other_member AND data->>'announcementId'=a::text) THEN RAISE EXCEPTION 'announcement must notify each other member once'; END IF;
  END IF;
  FOREACH event IN ARRAY ARRAY['watched_player_dropped','commissioner_announcement'] LOOP
    SELECT c.category INTO category FROM notif_event_catalog c WHERE c.event_type=event;
    IF EXISTS(SELECT 1 FROM notification_outbox WHERE member_id=f.other_member AND event_type=event) THEN
      IF current_setting('notif.pref')='event' THEN UPDATE notification_preferences SET event_settings=event_settings || '{"lineup_inactive":false,"lineup_empty":false,"watched_player_dropped":false,"commissioner_announcement":false}' WHERE user_id IN(f.owner,f.opponent);
      ELSIF current_setting('notif.pref')='category' THEN UPDATE notification_preferences SET category_settings='{"lineup":false,"waiver":false,"league":false}' WHERE user_id IN(f.owner,f.opponent);
      ELSIF current_setting('notif.pref')='master' THEN UPDATE notification_preferences SET master_enabled=false WHERE user_id IN(f.owner,f.opponent); END IF;
      PERFORM * FROM claim_notification_outbox_atomic(200,60);
      IF current_setting('notif.pref')<>'enabled' AND EXISTS(SELECT 1 FROM notification_outbox WHERE member_id=f.other_member AND event_type=event AND (suppressed_at IS NULL OR suppression_reason<>'preferences_disabled')) THEN RAISE EXCEPTION '% opt-out not durable: %',event,current_setting('notif.pref'); END IF;
    END IF;
  END LOOP;
  IF current_setting('notif.pref')<>'enabled' THEN
    UPDATE notification_preferences SET master_enabled=true,category_settings='{}',event_settings=(SELECT jsonb_object_agg(event_type,true) FROM notif_event_catalog) WHERE user_id IN(f.owner,f.opponent);
    UPDATE notification_outbox SET claimed_at=NULL,claim_token=NULL,available_at=clock_timestamp()-interval '1 day' WHERE member_id IN(f.member,f.other_member);
    IF EXISTS(SELECT 1 FROM claim_notification_outbox_atomic(200,60) c JOIN notification_outbox o ON o.id=c.id WHERE o.member_id IN(f.member,f.other_member) AND o.event_type IN('lineup_inactive','lineup_empty','watched_player_dropped','commissioner_announcement')) THEN RAISE EXCEPTION 'opt-out resurrected after resume'; END IF;
  END IF;
  IF current_setting('notif.case') IN ('all','close') THEN
    INSERT INTO matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,home_points,away_points)
      VALUES(m,f.league,f.season,1,f.member,f.other_member,100,101);
    PERFORM notif_scan_due_atomic(); PERFORM notif_scan_due_atomic();
    IF (SELECT count(*) FROM notification_outbox WHERE event_type='matchup_close' AND data->>'matchupId'=m::text)<>2 THEN RAISE EXCEPTION 'close matchup scanner recipients or dedupe failed'; END IF;
    IF private.notif_is_stale('matchup_close',jsonb_build_object('matchupId',m)) THEN RAISE EXCEPTION 'live close matchup falsely stale'; END IF;
    UPDATE matchups SET away_points=500 WHERE id=m;
    IF NOT private.notif_is_stale('matchup_close',jsonb_build_object('matchupId',m)) THEN RAISE EXCEPTION 'no-longer-close matchup escaped freshness'; END IF;
    UPDATE matchups SET away_points=101,winner_member_id=f.member WHERE id=m;
    IF NOT private.notif_is_stale('matchup_close',jsonb_build_object('matchupId',m)) THEN RAISE EXCEPTION 'decided matchup escaped freshness'; END IF;
    UPDATE matchups SET winner_member_id=NULL,is_finalized=true WHERE id=m;
    IF NOT private.notif_is_stale('matchup_close',jsonb_build_object('matchupId',m)) THEN RAISE EXCEPTION 'final matchup close alert must be stale'; END IF;
    PERFORM * FROM claim_notification_outbox_atomic(200,60);
    IF EXISTS(SELECT 1 FROM notification_outbox WHERE event_type='matchup_close' AND data->>'matchupId'=m::text AND (suppressed_at IS NULL OR suppression_reason<>'stale')) THEN RAISE EXCEPTION 'close suppression is not durable'; END IF;
    UPDATE matchups SET is_finalized=false WHERE id=m;
    IF EXISTS(SELECT 1 FROM claim_notification_outbox_atomic(200,60) c WHERE c.data->>'matchupId'=m::text AND c.data->>'notificationEvent'='matchup_close') THEN RAISE EXCEPTION 'stale close alert resurrected'; END IF;
  END IF;
  PERFORM set_config('request.jwt.claim.sub',f.outsider::text,true);
  SET LOCAL ROLE authenticated;
  IF EXISTS(SELECT 1 FROM player_watches WHERE league_id=f.league) THEN RAISE EXCEPTION 'watch RLS leaks other league'; END IF;
  IF EXISTS(SELECT 1 FROM league_announcements WHERE league_id=f.league) THEN RAISE EXCEPTION 'announcement RLS leaks other league'; END IF;
  RESET ROLE;
END $$;
SELECT json_build_object('fixture',row_to_json(f),'resources',row_to_json(r)) FROM notif_fixture f CROSS JOIN notif_resources r;
\if :{?notif_persist}
COMMIT;
\else
ROLLBACK;
\endif

