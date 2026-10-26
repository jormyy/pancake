BEGIN;
\ir rules-support.sql
DO $$
DECLARE
 f record;
 players uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid()];
 newer uuid;
 older uuid;
 processed uuid;
BEGIN
 SELECT * INTO f FROM pg_temp.rules_fixture(2, 9510);
 UPDATE leagues SET waiver_mode='rolling' WHERE id=f.league_id;
 INSERT INTO players(id,first_name,last_name) SELECT id,'Backlog',id::text FROM unnest(players) id;
 INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at)
 SELECT f.league_id,f.season_id,id,timestamptz '1899-12-29 12:00+00' FROM unnest(players) id;
 newer:=create_waiver_claim_atomic(f.league_id,f.member_ids[1],players[1],NULL,f.user_ids[1]);
 older:=create_waiver_claim_atomic(f.league_id,f.member_ids[2],players[2],NULL,f.user_ids[2]);
 UPDATE waiver_claims SET process_date='1900-01-04' WHERE id=newer;
 UPDATE waiver_claims SET process_date='1900-01-03' WHERE id=older;
 SELECT claim_id INTO processed FROM process_next_waiver_claim_atomic('1900-01-04');
 PERFORM pg_temp.check_rules(processed=older,'a due older run precedes a newer higher-priority claim in the same league');
 PERFORM pg_temp.check_rules((SELECT status='pending' FROM waiver_claims WHERE id=newer),'the newer claim waits for the older run');
 SELECT claim_id INTO processed FROM process_next_waiver_claim_atomic('1900-01-04');
 PERFORM pg_temp.check_rules(processed=newer,'the following run processes the newer claim');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
