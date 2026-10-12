BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data) VALUES('00000000-0000-4000-8000-0000f6d42800','authenticated','authenticated','zero-slot@example.test','{}');
INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES('00000000-0000-4000-8000-0000f6d42801','Zero Slot Regression','zero-slot-regression','00000000-0000-4000-8000-0000f6d42800','setup');
INSERT INTO league_members(id,league_id,user_id,role) VALUES('00000000-0000-4000-8000-0000f6d42802','00000000-0000-4000-8000-0000f6d42801','00000000-0000-4000-8000-0000f6d42800','commissioner');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000f6d42800',true);
SET LOCAL ROLE authenticated;
SELECT update_league_configuration_atomic('00000000-0000-4000-8000-0000f6d42801','{"auction_budget":250}','[{"slot_type":"PG","slot_count":0}]');
DO $$ BEGIN
 IF EXISTS(SELECT FROM lineup_slot_templates WHERE league_id='00000000-0000-4000-8000-0000f6d42801' AND slot_type='PG') THEN RAISE EXCEPTION 'Zero slot remains'; END IF;
 IF (SELECT auction_budget FROM leagues WHERE id='00000000-0000-4000-8000-0000f6d42801')<>250 THEN RAISE EXCEPTION 'Other settings did not save'; END IF;
 BEGIN
  PERFORM update_league_configuration_atomic('00000000-0000-4000-8000-0000f6d42801','{"auction_budget":300}','[{"slot_type":"SG","slot_count":-1}]');
  RAISE EXCEPTION 'Negative slot accepted';
 EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 IF (SELECT auction_budget FROM leagues WHERE id='00000000-0000-4000-8000-0000f6d42801')<>250 THEN RAISE EXCEPTION 'Invalid slots leaked settings update'; END IF;
END $$;
SELECT update_lineup_slots_atomic('00000000-0000-4000-8000-0000f6d42801','[{"slot_type":"PG","slot_count":2}]');
DO $$ BEGIN
 IF (SELECT slot_count FROM lineup_slot_templates WHERE league_id='00000000-0000-4000-8000-0000f6d42801' AND slot_type='PG')<>2 THEN RAISE EXCEPTION 'Positive slot did not return'; END IF;
END $$;
RESET ROLE;
UPDATE leagues SET status='active' WHERE id='00000000-0000-4000-8000-0000f6d42801';
SET LOCAL ROLE authenticated;
DO $$ BEGIN
 BEGIN
  PERFORM update_lineup_slots_atomic('00000000-0000-4000-8000-0000f6d42801','[{"slot_type":"PG","slot_count":0}]');
  RAISE EXCEPTION 'Active league slot deletion accepted';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'Lineup slots can only be modified during setup.' THEN RAISE; END IF;
 END;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000f6d42899',true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
 BEGIN
  PERFORM update_lineup_slots_atomic('00000000-0000-4000-8000-0000f6d42801','[{"slot_type":"PG","slot_count":0}]');
  RAISE EXCEPTION 'Outsider slot deletion accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
ROLLBACK;
