BEGIN;
SELECT gen_random_uuid() AS owner_id,gen_random_uuid() AS joiner_id \gset
INSERT INTO auth.users(id,email,raw_user_meta_data)
VALUES(:'owner_id',:'owner_id'||'@example.test','{}'),(:'joiner_id',:'joiner_id'||'@example.test','{}');
SELECT set_config('request.jwt.claim.sub',:'owner_id',true);
SET LOCAL ROLE authenticated;
SELECT public.create_league(p_name=>'Team name checks',p_team_name=>'  Home  ',p_auction_budget=>200) AS created \gset
RESET ROLE;
SELECT (:'created'::jsonb->>'id') AS league_id,(:'created'::jsonb->>'invite_code') AS invite_code \gset
SELECT id AS member_id FROM public.league_members WHERE league_id=:'league_id' AND user_id=:'owner_id' \gset
SELECT set_config('test.hygiene.member',:'member_id',true),set_config('test.hygiene.invite',:'invite_code',true);
DO $$ BEGIN
  IF (SELECT team_name FROM public.league_members WHERE id=current_setting('test.hygiene.member')::uuid)<>'Home' THEN
    RAISE EXCEPTION 'Create does not trim a valid team name';
  END IF;
END $$;
CREATE FUNCTION pg_temp.expect_invalid_name(p_sql text,p_state text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE=p_state THEN RETURN; END IF;
    RAISE;
  END;
  RAISE EXCEPTION 'Invalid team name succeeded: %',p_sql;
END $$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  invalid_name text;
  member uuid:=current_setting('test.hygiene.member');
BEGIN
  FOREACH invalid_name IN ARRAY ARRAY[NULL,'','   ',E'\t\n',repeat('a',41)] LOOP
    PERFORM pg_temp.expect_invalid_name(
      format('UPDATE public.league_members SET team_name=%L WHERE id=%L',invalid_name,member),'23514');
    PERFORM pg_temp.expect_invalid_name(
      format('SELECT public.create_league(p_name=>%L,p_team_name=>%L,p_auction_budget=>200)','Invalid name',invalid_name),'P0001');
  END LOOP;
  UPDATE public.league_members SET team_name=repeat('界',40) WHERE id=member;
  IF NOT FOUND THEN RAISE EXCEPTION 'Valid forty-character name cannot be saved'; END IF;
END $$;
SELECT public.create_league(p_name=>'Maximum team name',p_team_name=>repeat('界',40),p_auction_budget=>200);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub',:'joiner_id',true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  invalid_name text;
BEGIN
  FOREACH invalid_name IN ARRAY ARRAY[NULL,'','   ',E'\t\n',repeat('a',41)] LOOP
    PERFORM pg_temp.expect_invalid_name(
      format('SELECT public.join_league_by_invite_code(p_invite_code=>%L,p_team_name=>%L)',current_setting('test.hygiene.invite'),invalid_name),'P0001');
  END LOOP;
END $$;
SELECT public.join_league_by_invite_code(p_invite_code=>:'invite_code',p_team_name=>E'\t Away \n');
RESET ROLE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.league_members WHERE league_id=(SELECT league_id
      FROM public.league_members WHERE id=current_setting('test.hygiene.member')::uuid)
    AND user_id=auth.uid() AND team_name='Away') THEN
    RAISE EXCEPTION 'Join does not trim a valid team name';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.league_members'::regclass
    AND conname='league_members_team_name_valid' AND convalidated) THEN
    RAISE EXCEPTION 'Team name constraint is not validated';
  END IF;
END $$;
ROLLBACK;
