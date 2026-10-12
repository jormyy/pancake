BEGIN;
INSERT INTO players(id,first_name,last_name,nba_id,espn_id,position,eligible_positions)
VALUES('00000000-0000-4000-8000-0000f6d42901','Canonical','Before','f6d4-metadata-nba','f6d4-metadata-espn','PG',ARRAY['PG']);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
 BEGIN
  PERFORM update_existing_player_metadata('[]');
  RAISE EXCEPTION 'Authenticated client gained metadata write access';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE service_role;
DO $$
DECLARE v_count int;
BEGIN
 SELECT update_existing_player_metadata('[
 {"id":"00000000-0000-4000-8000-0000f6d42901","first_name":"Canonical","last_name":"Updated","position":"SG","eligible_positions":["SG"],"nba_team":"XMU","status":"Active","injury_status":null,"years_exp":4,"updated_at":"2026-10-11T00:00:00Z","nba_id":"must-not-replace"},
 {"id":"00000000-0000-4000-8000-0000f6d42902","first_name":"Deleted","last_name":"Identity","position":"PG","eligible_positions":["PG"],"updated_at":"2026-10-11T00:00:00Z"}
 ]') INTO v_count;
 IF v_count <> 1 THEN RAISE EXCEPTION 'Updated count must exclude missing identities'; END IF;
 IF EXISTS(SELECT FROM players WHERE id='00000000-0000-4000-8000-0000f6d42902') THEN RAISE EXCEPTION 'Update recreated a deleted player'; END IF;
 IF NOT EXISTS(SELECT FROM players WHERE id='00000000-0000-4000-8000-0000f6d42901' AND last_name='Updated' AND position='SG' AND years_exp=4 AND nba_id='f6d4-metadata-nba' AND espn_id='f6d4-metadata-espn') THEN RAISE EXCEPTION 'Known player metadata or provider identity changed incorrectly'; END IF;
 BEGIN
  PERFORM update_existing_player_metadata('[{"id":"00000000-0000-4000-8000-0000f6d42901"},{"id":"00000000-0000-4000-8000-0000f6d42901"}]');
  RAISE EXCEPTION 'Duplicate updates accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;
ROLLBACK;
