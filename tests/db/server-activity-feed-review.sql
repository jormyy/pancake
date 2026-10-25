BEGIN;
\ir rules-support.sql
\if :{?activity_case}
\else
  \set activity_case all
\endif
SELECT set_config('test.activity_case', :'activity_case', true);
CREATE TEMP TABLE feed_fixture AS SELECT * FROM pg_temp.rules_fixture(4,9561);
CREATE TEMP TABLE feed_trades(label text PRIMARY KEY, trade_id uuid, activity_id uuid);
CREATE TEMP TABLE feed_players(id uuid, years_exp int, career_regular_season_games int, transaction_id uuid, activity_id uuid);
GRANT SELECT ON feed_fixture,feed_trades,feed_players TO authenticated;
DO $$
DECLARE f record; pending uuid; accepted uuid; completed uuid; multi uuid; event text; idx int; sample record;
BEGIN
  SELECT * INTO f FROM feed_fixture;
  UPDATE leagues SET trade_veto_mode='commissioner',trade_veto_window_hours=24 WHERE id=f.league_id;
  pending:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'{}','{}','{}','{}',NULL,NULL,1,1);
  FOREACH event IN ARRAY ARRAY['trade_countered','trade_edited','trade_expired'] LOOP
    PERFORM private.log_league_activity(f.league_id,f.season_id,event,'Private offer',NULL,f.member_ids[1],f.member_ids[2],NULL,pending);
  END LOOP;
  accepted:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'{}','{}','{}','{}',NULL,NULL,2,2);
  PERFORM public.accept_trade_atomic(accepted,f.member_ids[2]);
  completed:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'{}','{}','{}','{}',NULL,NULL,3,3);
  PERFORM public.accept_trade_atomic(completed,f.member_ids[2]);
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=completed;
  PERFORM public.complete_accepted_trade_atomic(completed);
  multi:=public.propose_multi_team_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids,
    (SELECT jsonb_agg(jsonb_build_object('fromMemberId',f.member_ids[n],'toMemberId',f.member_ids[n%4+1],'faabAmount',1)) FROM generate_series(1,4) n));
  FOR idx IN 2..4 LOOP PERFORM public.accept_trade_atomic(multi,f.member_ids[idx]); END LOOP;
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=multi;
  PERFORM public.complete_accepted_trade_atomic(multi);
  INSERT INTO feed_trades(label,trade_id,activity_id)
    SELECT 'two',completed,id FROM league_activity WHERE related_trade_id=completed AND event_type='trade_completed'
    UNION ALL SELECT 'four',multi,id FROM league_activity WHERE related_trade_id=multi AND event_type='trade_completed';
  INSERT INTO feed_trades(label,activity_id) VALUES('legacy',private.log_league_activity(f.league_id,f.season_id,
    'trade_completed','Legacy completed trade',NULL,f.member_ids[1],f.member_ids[2]));
  PERFORM private.log_league_activity(f.league_id,f.season_id,'trade_block_updated','Hidden listing',NULL,f.member_ids[1]);
  UPDATE league_activity SET created_at=now()+interval '1 hour'
    WHERE league_id=f.league_id AND event_type IN ('trade_offered','trade_countered','trade_edited','trade_expired','trade_block_updated');
  FOR sample IN SELECT * FROM (VALUES(0,NULL::int),(1,64),(2,65),(1,NULL::int),(NULL::int,12)) AS samples(experience,games) LOOP
    INSERT INTO feed_players VALUES(gen_random_uuid(),sample.experience,sample.games,gen_random_uuid(),gen_random_uuid());
  END LOOP;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games)
    SELECT id,'Feed',id::text,'PG',ARRAY['PG'],years_exp,career_regular_season_games FROM feed_players;
  INSERT INTO roster_transactions(id,league_id,league_season_id,member_id,player_id,transaction_type)
    SELECT transaction_id,f.league_id,f.season_id,f.member_ids[1],id,'fa_add' FROM feed_players;
  INSERT INTO league_activity(id,league_id,league_season_id,actor_member_id,related_player_id,event_type,title)
    SELECT activity_id,f.league_id,f.season_id,f.member_ids[1],id,'player_injured','Player injury' FROM feed_players;
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; idx int;
BEGIN
  IF current_setting('test.activity_case') NOT IN ('all','privacy') THEN RETURN; END IF;
  SELECT * INTO f FROM feed_fixture;
  FOR idx IN 1..4 LOOP
    PERFORM set_config('request.jwt.claim.sub',f.user_ids[idx]::text,true);
    PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.get_league_activity_feed(f.league_id,100,0)
      WHERE transaction_type IN ('trade_offered','trade_countered','trade_edited','trade_expired','trade_block_updated')),
      'feed hides every offer event for member '||idx);
    PERFORM pg_temp.check_rules((SELECT count(*)=3 FROM public.get_league_activity_feed(f.league_id,100,0) WHERE transaction_type='trade_completed'),
      'feed keeps completed trades for member '||idx);
    PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.get_league_activity_feed(f.league_id,1,0)
      WHERE transaction_type NOT IN ('trade_offered','trade_countered','trade_edited','trade_expired','trade_block_updated')),
      'hidden offers do not consume the first page for member '||idx);
  END LOOP;
END;
$$;
DO $$
DECLARE f record; idx int; payload jsonb; sample record; expected jsonb;
BEGIN
  IF current_setting('test.activity_case') NOT IN ('all','teams') THEN RETURN; END IF;
  SELECT * INTO f FROM feed_fixture;
  FOR idx IN 1..4 LOOP
    PERFORM set_config('request.jwt.claim.sub',f.user_ids[idx]::text,true);
    FOR sample IN SELECT * FROM feed_trades LOOP
      SELECT to_jsonb(feed) INTO payload FROM public.get_league_activity_feed(f.league_id,100,0) feed WHERE feed.id=sample.activity_id;
      SELECT jsonb_agg(team_name ORDER BY array_position(f.member_ids,id)) INTO expected FROM league_members
        WHERE id=ANY(CASE WHEN sample.label='four' THEN f.member_ids ELSE f.member_ids[1:2] END);
      PERFORM pg_temp.check_rules(payload->'participant_team_names'=expected,
        sample.label||' completed trade includes every team for member '||idx);
    END LOOP;
  END LOOP;
END;
$$;
DO $$
DECLARE f record; sample record; payload jsonb; row_id uuid;
BEGIN
  IF current_setting('test.activity_case') NOT IN ('all','players') THEN RETURN; END IF;
  SELECT * INTO f FROM feed_fixture;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[4]::text,true);
  FOR sample IN SELECT * FROM feed_players LOOP
    FOREACH row_id IN ARRAY ARRAY[sample.transaction_id,sample.activity_id] LOOP
      SELECT to_jsonb(feed) INTO payload FROM public.get_league_activity_feed(f.league_id,100,0) feed WHERE feed.id=row_id;
      PERFORM pg_temp.check_rules(payload @> jsonb_build_object('player_id',sample.id,'years_exp',sample.years_exp,
        'career_regular_season_games',sample.career_regular_season_games),
        'player identity and nullable tag values survive on row '||row_id);
      PERFORM pg_temp.check_rules(payload->'participant_team_names'='[]'::jsonb,'player row has an empty trade team list '||row_id);
    END LOOP;
  END LOOP;
  SELECT to_jsonb(feed) INTO payload FROM public.get_league_activity_feed(f.league_id,100,0) feed
    WHERE feed.id=(SELECT activity_id FROM feed_trades WHERE label='four');
  PERFORM pg_temp.check_rules(payload @> '{"player_id":null,"years_exp":null,"career_regular_season_games":null}'::jsonb,
    'non-player activity never invents player tag values');
END;
$$;
RESET ROLE;
UPDATE players SET years_exp=2,career_regular_season_games=65 WHERE id IN (SELECT id FROM feed_players WHERE career_regular_season_games=64);
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; row_id uuid; payload jsonb;
BEGIN
  IF current_setting('test.activity_case') NOT IN ('all','players') THEN RETURN; END IF;
  SELECT * INTO f FROM feed_fixture;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[4]::text,true);
  SELECT transaction_id INTO row_id FROM feed_players WHERE career_regular_season_games=64;
  SELECT to_jsonb(feed) INTO payload FROM public.get_league_activity_feed(f.league_id,100,0) feed WHERE feed.id=row_id;
  PERFORM pg_temp.check_rules(payload @> '{"years_exp":2,"career_regular_season_games":65}'::jsonb,
    'feed tags read the current authoritative player fields');
END;
$$;
RESET ROLE;
DO $$
DECLARE f record; code text;
BEGIN
  SELECT * INTO f FROM feed_fixture;
  PERFORM pg_temp.check_rules(NOT has_function_privilege('anon','public.get_league_activity_feed(uuid,integer,integer)','EXECUTE')
    AND has_function_privilege('authenticated','public.get_league_activity_feed(uuid,integer,integer)','EXECUTE')
    AND has_function_privilege('service_role','public.get_league_activity_feed(uuid,integer,integer)','EXECUTE'),
    'the replacement feed preserves its RPC grants');
  PERFORM set_config('request.jwt.claim.sub','',true);
  BEGIN PERFORM public.get_league_activity_feed(p_league_id=>f.league_id,p_limit=>50,p_offset=>0);
    EXCEPTION WHEN OTHERS THEN code:=SQLSTATE; END;
  PERFORM pg_temp.check_rules(code='42501','the feed rejects an absent user');
  code:=NULL;
  PERFORM set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  BEGIN PERFORM public.get_league_activity_feed(p_league_id=>f.league_id,p_limit=>50,p_offset=>0);
    EXCEPTION WHEN OTHERS THEN code:=SQLSTATE; END;
  PERFORM pg_temp.check_rules(code='42501','the feed rejects a non-member');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
