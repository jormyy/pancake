BEGIN;
DO $$
DECLARE
  v_candidate uuid := gen_random_uuid();
  v_owner uuid := gen_random_uuid();
  v_stale uuid := gen_random_uuid();
  v_identity text := 'claim-test-' || gen_random_uuid()::text;
  v_other_identity text := 'claim-other-' || gen_random_uuid()::text;
  v_rejected boolean := false;
  v_result uuid;
BEGIN
  IF has_function_privilege('anon', 'public.assign_player_nba_id_atomic(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.assign_player_nba_id_atomic(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Player identity assignment is exposed to a client role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.assign_player_nba_id_atomic(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Player identity assignment is unavailable to workers';
  END IF;

  INSERT INTO players(id,first_name,last_name) VALUES(v_candidate,'Claim','Candidate');
  IF assign_player_nba_id_atomic(v_candidate,v_identity) <> v_candidate
     OR assign_player_nba_id_atomic(v_candidate,v_identity) <> v_candidate THEN
    RAISE EXCEPTION 'Identity claim or retry returned the wrong player';
  END IF;
  BEGIN
    PERFORM assign_player_nba_id_atomic(v_candidate,v_other_identity);
  EXCEPTION WHEN check_violation THEN v_rejected := true;
  END;
  IF NOT v_rejected OR (SELECT nba_id FROM players WHERE id=v_candidate) <> v_identity THEN
    RAISE EXCEPTION 'Identity assignment replaced an existing provider identity';
  END IF;

  INSERT INTO players(id,first_name,last_name,nba_id) VALUES(v_owner,'Canonical','Owner',v_other_identity);
  INSERT INTO players(id,first_name,last_name,sleeper_id) VALUES(v_stale,'Unclaimed','Duplicate','claim-sleeper-'||v_stale::text);
  v_result := assign_player_nba_id_atomic(v_stale,v_other_identity);
  IF v_result <> v_owner
     OR EXISTS(SELECT 1 FROM players WHERE id=v_stale)
     OR (SELECT sleeper_id FROM players WHERE id=v_owner) <> 'claim-sleeper-'||v_stale::text THEN
    RAISE EXCEPTION 'Safe duplicate merge did not preserve canonical identity and provider linkage';
  END IF;

  v_rejected := false;
  BEGIN
    PERFORM assign_player_nba_id_atomic(v_candidate,v_other_identity);
  EXCEPTION WHEN check_violation THEN v_rejected := true;
  END;
  IF NOT v_rejected OR (SELECT count(*) FROM players WHERE id IN(v_candidate,v_owner)) <> 2
     OR (SELECT nba_id FROM players WHERE id=v_candidate) <> v_identity THEN
    RAISE EXCEPTION 'A stale duplicate mapping merged a differently claimed player';
  END IF;
END;
$$;
ROLLBACK;
