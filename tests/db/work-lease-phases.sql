BEGIN;
\ir rules-support.sql
DELETE FROM private.work_items;
DO $$
DECLARE kind text; item private.work_items%ROWTYPE; v_key uuid;
BEGIN
  FOREACH kind IN ARRAY ARRAY['process-trades','refresh-views','league-inventory-hint-drain'] LOOP
    PERFORM private.work_enqueue(kind,'phase-lease-'||kind);
  END LOOP;
  FOR item IN SELECT * FROM private.work_claim() LOOP
    PERFORM pg_temp.check_rules(item.lease_until>=clock_timestamp()+interval '299 seconds',item.kind||' starts with five minutes of phase headroom');
    v_key:=gen_random_uuid();
    UPDATE private.work_items SET invocation_key=v_key,lease_until=clock_timestamp()+interval '1 second' WHERE id=item.id;
    PERFORM pg_temp.check_rules(public.renew_work_lease(v_key),item.kind||' renews before the next phase');
    PERFORM pg_temp.check_rules((SELECT lease_until>=clock_timestamp()+interval '299 seconds' FROM private.work_items WHERE id=item.id),item.kind||' renewal restores phase headroom');
    UPDATE private.work_items SET lease_until=clock_timestamp()-interval '1 second' WHERE id=item.id;
    PERFORM pg_temp.check_rules(NOT public.renew_work_lease(v_key),item.kind||' expired lease cannot revive');
    PERFORM pg_temp.check_rules(NOT private.work_finish(item.id,item.lease_token),item.kind||' expired worker cannot complete');
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
