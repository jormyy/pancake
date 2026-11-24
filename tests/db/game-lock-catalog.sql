BEGIN;
DO $$
DECLARE writers text[]; guarded boolean;
BEGIN
  SELECT array_agg(format('%I.%I', namespace.nspname, procedure.proname) ORDER BY procedure.proname) INTO writers
  FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
  WHERE procedure.prosecdef AND namespace.nspname IN ('public', 'private')
    AND procedure.prosrc ~* 'UPDATE\s+(public\.)?roster_players(\s+(AS\s+)?\w+)?\s+SET[^;]*is_on_(ir|taxi)\s*=';
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger trigger JOIN pg_proc procedure ON procedure.oid = trigger.tgfoid
    WHERE trigger.tgrelid = 'public.roster_players'::regclass AND NOT trigger.tgisinternal
      AND trigger.tgtype & 2 = 2 AND trigger.tgtype & 16 = 16
      AND procedure.prosrc LIKE '%roster_status_game_started%'
  ) INTO guarded;
  IF NOT guarded THEN
    RAISE EXCEPTION '% SECURITY DEFINER functions write roster_players IR/taxi columns with no game-lock trigger (%). Add a BEFORE UPDATE trigger on roster_players that calls private.roster_status_game_started; the DB owns game locks.',
      coalesce(cardinality(writers), 0), coalesce(array_to_string(writers, ', '), 'none found');
  END IF;
  RAISE NOTICE 'game-lock trigger guards % IR/taxi writers', coalesce(cardinality(writers), 0);
END;
$$;

INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('00000000-0000-0000-0000-00005a091001','authenticated','authenticated','s09@example.test','x',now(),'{}','{}',now(),now()),
       ('00000000-0000-0000-0000-00005a091002','authenticated','authenticated','s09b@example.test','x',now(),'{}','{}',now(),now());
INSERT INTO profiles(id,username) VALUES ('00000000-0000-0000-0000-00005a091001','s09_owner'),('00000000-0000-0000-0000-00005a091002','s09_rival')
ON CONFLICT(id) DO NOTHING;
INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,taxi_slots,allow_inactive_trades)
VALUES ('00000000-0000-0000-0000-00005a091101','S09 Locks','s09-locks','00000000-0000-0000-0000-00005a091001','active',10,3,2,true);
INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES
('00000000-0000-0000-0000-00005a091201','00000000-0000-0000-0000-00005a091101','00000000-0000-0000-0000-00005a091001','commissioner','S09 Owner'),
('00000000-0000-0000-0000-00005a091202','00000000-0000-0000-0000-00005a091101','00000000-0000-0000-0000-00005a091002','manager','S09 Rival');
INSERT INTO league_seasons(id,league_id,season_year,is_current)
VALUES ('00000000-0000-0000-0000-00005a091301','00000000-0000-0000-0000-00005a091101',2105,true);
INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions,injury_status,years_exp) VALUES
('00000000-0000-0000-0000-00005a091401','Tipped','Starter','QLK','PG',ARRAY['PG'],'Out',3),
('00000000-0000-0000-0000-00005a091402','Traded','Today','QOT','SG',ARRAY['SG'],'Out',3),
('00000000-0000-0000-0000-00005a091403','Traded','Away','QLK','SF',ARRAY['SF'],'Out',3);
INSERT INTO nba_games(id,week_number,season_year,game_date,home_team,away_team,status,game_time)
SELECT id::uuid,1,2105,(now() AT TIME ZONE 'America/New_York')::date,home,away,status,now()+tip
FROM (VALUES
  ('00000000-0000-0000-0000-00005a091501','QLK','QY1','InProgress',interval '-1 hour'),
  ('00000000-0000-0000-0000-00005a091502','QOT','QY2','InProgress',interval '-1 hour'),
  ('00000000-0000-0000-0000-00005a091503','QNT','QY3','Scheduled',interval '3 hours')
) AS fixture(id,home,away,status,tip);
INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,points)
VALUES ('00000000-0000-0000-0000-00005a091402','00000000-0000-0000-0000-00005a091503',2105,1,0);
INSERT INTO roster_players(id,league_id,league_season_id,member_id,player_id,is_on_ir,acquired_via) VALUES
('00000000-0000-0000-0000-00005a091601','00000000-0000-0000-0000-00005a091101','00000000-0000-0000-0000-00005a091301','00000000-0000-0000-0000-00005a091201','00000000-0000-0000-0000-00005a091401',false,'draft'),
('00000000-0000-0000-0000-00005a091602','00000000-0000-0000-0000-00005a091101','00000000-0000-0000-0000-00005a091301','00000000-0000-0000-0000-00005a091201','00000000-0000-0000-0000-00005a091402',false,'draft'),
('00000000-0000-0000-0000-00005a091603','00000000-0000-0000-0000-00005a091101','00000000-0000-0000-0000-00005a091301','00000000-0000-0000-0000-00005a091201','00000000-0000-0000-0000-00005a091403',false,'draft');

DO $$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    UPDATE roster_players SET is_on_ir = true WHERE id = '00000000-0000-0000-0000-00005a091601';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE '%game has already started%' THEN RAISE; END IF;
    rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'A direct roster_players IR write skipped the game lock. The game-lock trigger on roster_players must reject it.';
  END IF;
  UPDATE roster_players SET is_on_ir = true WHERE id = '00000000-0000-0000-0000-00005a091602';
  UPDATE roster_players SET member_id = '00000000-0000-0000-0000-00005a091202', is_on_ir = true
  WHERE id = '00000000-0000-0000-0000-00005a091603';
END;
$$;

DO $$
DECLARE c record; failures text[] := '{}'; today date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions,years_exp)
  SELECT fixture.player_id, 'Slate', fixture.team, fixture.team, 'PG', ARRAY['PG'], 3
  FROM (VALUES
    ('00000000-0000-0000-0000-00005a091701'::uuid,'QW1'),('00000000-0000-0000-0000-00005a091702'::uuid,'QW2'),
    ('00000000-0000-0000-0000-00005a091703'::uuid,'QW3'),('00000000-0000-0000-0000-00005a091704'::uuid,'QW4'),
    ('00000000-0000-0000-0000-00005a091705'::uuid,'QW5'),('00000000-0000-0000-0000-00005a091706'::uuid,'QW6')
  ) AS fixture(player_id, team);
  CREATE TEMP TABLE slate_case(label text, player_id uuid, team text, game_date date, status text, tip interval, locked boolean) ON COMMIT DROP;
  INSERT INTO slate_case VALUES
    ('yesterday''s late game still in progress','00000000-0000-0000-0000-00005a091701','QW1',today-1,'InProgress',NULL,true),
    ('yesterday''s late game final 2.5 hours after tip-off','00000000-0000-0000-0000-00005a091702','QW2',today-1,'Final',interval '-150 minutes',true),
    ('yesterday''s game final 12.5 hours after tip-off','00000000-0000-0000-0000-00005a091703','QW3',today-1,'Final',interval '-750 minutes',false),
    ('today''s game final','00000000-0000-0000-0000-00005a091704','QW4',today,'Final',NULL,true),
    ('today''s game tips off later','00000000-0000-0000-0000-00005a091705','QW5',today,'Scheduled',interval '5 hours',false),
    ('yesterday''s late game past tip-off with no status poll','00000000-0000-0000-0000-00005a091706','QW6',today-1,'Scheduled',interval '-150 minutes',true);
  INSERT INTO nba_games(id,week_number,season_year,game_date,home_team,away_team,status,game_time)
  SELECT gen_random_uuid(),1,2105,game_date,team,'QZ'||right(team,1),status,now()+tip FROM slate_case;
  FOR c IN SELECT * FROM slate_case ORDER BY label LOOP
    IF private.roster_status_game_started(c.player_id) IS DISTINCT FROM c.locked THEN
      failures := failures || format('%s: expected locked=%s', c.label, c.locked);
    END IF;
  END LOOP;
  IF cardinality(failures) > 0 THEN
    RAISE EXCEPTION 'Roster slate lock is wrong: %', array_to_string(failures, '; ');
  END IF;
END;
$$;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00005a091001',true);
SELECT set_config('request.jwt.claims',json_build_object('sub','00000000-0000-0000-0000-00005a091001','role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE locked_flags jsonb;
BEGIN
  SELECT jsonb_object_agg(r.id, public.locked_until_slate_end(r)) INTO locked_flags
  FROM roster_players r WHERE r.member_id = '00000000-0000-0000-0000-00005a091201';
  IF locked_flags IS DISTINCT FROM jsonb_build_object(
    '00000000-0000-0000-0000-00005a091601', true,
    '00000000-0000-0000-0000-00005a091602', false) THEN
    RAISE EXCEPTION 'locked_until_slate_end must follow the server game lock for the owner''s visible rows: %', locked_flags;
  END IF;
END;
$$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.locked_until_slate_end(public.roster_players)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not read roster game locks';
  END IF;
END;
$$;
RESET ROLE;
ROLLBACK;
