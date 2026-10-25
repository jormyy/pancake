BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE activation_lock_log (
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  first_key integer,
  second_key integer,
  draft_row_locked boolean
);
CREATE FUNCTION public.pg_advisory_xact_lock(p_first integer, p_second integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pg_temp.activation_lock_log(first_key,second_key,draft_row_locked)
  VALUES(p_first,p_second,EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid()
    AND relation='public.drafts'::regclass AND mode='RowShareLock' AND granted));
  PERFORM pg_catalog.pg_advisory_xact_lock(p_first,p_second);
END;
$$;
ALTER FUNCTION private.lock_roster_activation(uuid,text,uuid) SET search_path=public,pg_catalog;
DO $$
DECLARE
  fixture record;
  draft_id uuid := gen_random_uuid();
  reserve_id uuid := gen_random_uuid();
  active_id uuid := gen_random_uuid();
  reserve_player uuid := gen_random_uuid();
  active_player uuid := gen_random_uuid();
BEGIN
  SELECT * INTO fixture FROM pg_temp.rules_fixture(2,9530,'drafting');
  INSERT INTO public.players(id,first_name,last_name,years_exp,injury_status)
  VALUES(reserve_player,'Reserve','Player',3,'Out'),(active_player,'Active','Player',3,NULL);
  INSERT INTO public.drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
  VALUES(draft_id,fixture.league_id,fixture.season_id,'snake','completed',false,1);
  INSERT INTO public.roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir)
  VALUES(reserve_id,fixture.league_id,fixture.season_id,fixture.member_ids[1],reserve_player,'draft',true),
    (active_id,fixture.league_id,fixture.season_id,fixture.member_ids[1],active_player,'draft',false);
  PERFORM set_config('request.jwt.claim.sub',fixture.user_ids[1]::text,true);
  TRUNCATE pg_temp.activation_lock_log;
  PERFORM private.lock_roster_activation(reserve_id,'ir',active_id);
  PERFORM pg_temp.check_rules((SELECT first_key=hashtext(draft_id::text) AND second_key=0
    FROM pg_temp.activation_lock_log ORDER BY sequence LIMIT 1), 'activation locks the rookie draft before the team');
  PERFORM pg_temp.check_rules((SELECT draft_row_locked FROM pg_temp.activation_lock_log
    WHERE first_key=hashtext(fixture.league_id::text) AND second_key=hashtext(fixture.member_ids[1]::text)),
    'activation locks the draft row before the team');
  PERFORM pg_temp.check_rules((SELECT array_agg(second_key ORDER BY sequence)=ARRAY[
    0,hashtext(fixture.member_ids[1]::text),
    hashtext(LEAST(reserve_player,active_player)::text),hashtext(GREATEST(reserve_player,active_player)::text)]
    FROM pg_temp.activation_lock_log), 'activation takes draft, team, and sorted player locks');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
