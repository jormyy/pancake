\set ON_ERROR_STOP on
\getenv excellence_port PANCAKE_TEST_DB_PORT
\if :{?excellence_port}
\else
  \set excellence_port 57422
\endif
SELECT :'HOST'='127.0.0.1' AND :'PORT'=:'excellence_port' AS correct_target \gset
\if :correct_target
\else
  DO $$ BEGIN RAISE EXCEPTION 'Use the assigned private database.'; END $$;
\endif
BEGIN;
\ir excellence-fixture.sql
CREATE TEMP TABLE excellence_results(
  member_id uuid, function_name text, result_hash text, result_bytes integer,
  plan jsonb, error_code text, error_message text, expected_empty boolean
);
GRANT SELECT,INSERT ON excellence_results TO authenticated;
CREATE TEMP TABLE excellence_members AS
  SELECT member.id,member.league_id,member.user_id,
    (SELECT roster.player_id FROM public.roster_players roster WHERE roster.member_id=member.id ORDER BY roster.id LIMIT 1) AS player_id,
    (SELECT trade.id FROM public.trades trade WHERE trade.league_id=member.league_id
      AND (trade.status='accepted' OR trade.proposer_member_id=member.id OR trade.recipient_member_id=member.id
        OR EXISTS(SELECT 1 FROM public.trade_participants participant WHERE participant.trade_id=trade.id AND participant.member_id=member.id))
      ORDER BY trade.id LIMIT 1) AS trade_id,
    (SELECT draft.id FROM public.drafts draft WHERE draft.league_id=member.league_id ORDER BY draft.id LIMIT 1) AS draft_id
  FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id
  WHERE league.deleted_at IS NULL
  ORDER BY (member.user_id=league.commissioner_id) DESC,member.id LIMIT 2;
SET LOCAL statement_timeout='120s';
SET LOCAL lock_timeout='500ms';
SET LOCAL pg_stat_statements.track='all';
SET LOCAL log_min_messages='notice';
DO $$
DECLARE member record; target record; params jsonb; command text; payload jsonb; measured_plan jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM excellence_members) THEN
    RAISE EXCEPTION 'The backup has no screen members.';
  END IF;
  FOR member IN SELECT id,league_id,user_id,player_id,trade_id,draft_id FROM excellence_members LOOP
    params:=jsonb_build_object('playerId',member.player_id,'tradeId',member.trade_id,'draftId',member.draft_id,
      'date','2026-10-27','limit',20);
    PERFORM set_config('request.jwt.claim.sub',member.user_id::text,true);
    FOR target IN SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'view_%' AND p.provolatile='s'
        AND p.proargtypes='2950 2950 3802'::oidvector ORDER BY p.proname LOOP
      command:=format('SELECT public.%I(%L::uuid,%L::uuid,%L::jsonb)',target.proname,member.league_id,member.id,params);
      BEGIN
        SET LOCAL ROLE authenticated;
        EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '||command INTO measured_plan;
        EXECUTE command INTO payload;
        INSERT INTO excellence_results VALUES(member.id,target.proname,md5(payload::text),octet_length(payload::text),measured_plan,NULL,NULL,false);
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO excellence_results VALUES(member.id,target.proname,NULL,NULL,NULL,SQLSTATE,SQLERRM,
          target.proname='view_trade_preview' AND member.trade_id IS NULL AND SQLSTATE='42501');
      END;
      RESET ROLE;
    END LOOP;
    BEGIN
      SET LOCAL ROLE authenticated;
      command:=format('SELECT public.view_team_timeline(%L::uuid,%L::uuid,NULL,30)',member.league_id,member.id);
      EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '||command INTO measured_plan;
      EXECUTE command INTO payload;
      INSERT INTO excellence_results VALUES(member.id,'view_team_timeline',md5(payload::text),octet_length(payload::text),measured_plan,NULL,NULL,false);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO excellence_results VALUES(member.id,'view_team_timeline',NULL,NULL,NULL,SQLSTATE,SQLERRM,false);
    END;
    RESET ROLE;
    BEGIN
      SET LOCAL ROLE authenticated;
      command:=format('SELECT coalesce(jsonb_agg(to_jsonb(found)),''[]''::jsonb) FROM public.view_player_search(p_league_id=>%L::uuid,p_limit=>20) found',member.league_id);
      EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '||command INTO measured_plan;
      EXECUTE command INTO payload;
      INSERT INTO excellence_results VALUES(member.id,'view_player_search',md5(payload::text),octet_length(payload::text),measured_plan,NULL,NULL,false);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO excellence_results VALUES(member.id,'view_player_search',NULL,NULL,NULL,SQLSTATE,SQLERRM,false);
    END;
    RESET ROLE;
  END LOOP;
END;
$$;
SELECT jsonb_build_object('capturedAt',now(),'results',
  (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.function_name,r.member_id) FROM excellence_results r),
  'failures',(SELECT count(*) FROM excellence_results WHERE error_code IS NOT NULL AND NOT expected_empty));
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM excellence_results WHERE error_code IS NOT NULL AND NOT expected_empty) THEN
    RAISE EXCEPTION 'The screen walk has failed calls.';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'view_%' AND p.provolatile='s'
      AND NOT EXISTS(SELECT 1 FROM excellence_results result WHERE result.function_name=p.proname)) THEN
    RAISE EXCEPTION 'The screen walk misses a stable view function.';
  END IF;
END;
$$;
ROLLBACK;
