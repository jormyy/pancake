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
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='slot-measurement';
\ir rules-support.sql
CREATE TEMP TABLE slot_fixture AS SELECT * FROM pg_temp.rules_fixture(2,9591,'setup');
CREATE TEMP TABLE slot_writes(operation text);
CREATE FUNCTION pg_temp.observe_slot_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_temp AS $$
BEGIN
  INSERT INTO slot_writes VALUES(TG_OP);
  RETURN NULL;
END;
$$;
CREATE TRIGGER excellence_observe_slots AFTER INSERT OR UPDATE OR DELETE ON public.lineup_slot_templates
FOR EACH ROW EXECUTE FUNCTION pg_temp.observe_slot_write();
CREATE TEMP TABLE slot_measurement(plan jsonb,identical_writes bigint);
DO $$
DECLARE f record; measured jsonb;
BEGIN
  SELECT league_id,user_ids INTO f FROM slot_fixture;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM public.update_lineup_slots_atomic_unchecked(f.league_id,'[{"slot_type":"PG","slot_count":2}]');
  TRUNCATE slot_writes;
  EXECUTE format('EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) SELECT public.update_lineup_slots_atomic_unchecked(%L::uuid,%L::jsonb)',
    f.league_id,'[{"slot_type":"PG","slot_count":2}]') INTO measured;
  INSERT INTO slot_measurement SELECT measured,count(*) FROM slot_writes;
END;
$$;
SELECT jsonb_build_object('identicalWrites',identical_writes,'plan',plan) FROM slot_measurement;
DO $$
DECLARE f record;
BEGIN
  SELECT league_id,user_ids INTO f FROM slot_fixture;
  PERFORM pg_temp.check_rules((SELECT identical_writes=0 FROM slot_measurement),'identical slot settings write no rows');
  PERFORM pg_temp.check_rules((SELECT slot_count=2 FROM public.lineup_slot_templates WHERE league_id=f.league_id AND slot_type='PG'),'identical settings preserve the result');
  TRUNCATE slot_writes;
  PERFORM public.update_lineup_slots_atomic_unchecked(f.league_id,'[{"slot_type":"PG","slot_count":3}]');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM slot_writes),'changed slot settings still write once');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[2]::text,true);
  PERFORM pg_temp.reject_rules(format('SELECT public.update_lineup_slots_atomic_unchecked(%L,%L)',f.league_id,'[{"slot_type":"PG","slot_count":4}]'),
    'Only the league commissioner can change lineup slots.','slot authorization stays enforced');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
