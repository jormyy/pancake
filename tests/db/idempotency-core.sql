\ir idempotency-support.sql
DO $$
DECLARE f record; id uuid := gen_random_uuid(); failed uuid := gen_random_uuid(); rejected boolean; expression text; old_id uuid := gen_random_uuid(); boundary_id uuid := gen_random_uuid(); recent_id uuid := gen_random_uuid(); result jsonb;
BEGIN
  SELECT * INTO f FROM idempotency_fixture;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',f.user_ids[1],'role','authenticated')::text,true);
  PERFORM set_config('request.headers','{"authorization":"test"}',true);
  rejected := false;
  BEGIN
    PERFORM public.update_league_settings_atomic(f.league_id,'{}');
  EXCEPTION WHEN invalid_parameter_value THEN rejected := true;
  END;
  PERFORM pg_temp.check_rules(rejected,'client writes require a request ID');
  expression := format('public.update_league_settings_atomic(%L,%L::jsonb)', f.league_id,'{"trade_veto_window_hours":12}');
  BEGIN
    PERFORM idempotency_test.apply(failed,f.user_ids[1],format('public.update_league_settings_atomic(%L,%L::jsonb)',f.league_id,'{"taxi_max_seasons":3}'));
    RAISE EXCEPTION 'Invalid settings accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.request_receipts WHERE request_id=failed), 'failed write leaves no receipt');
  PERFORM idempotency_test.apply(id,f.user_ids[1],expression);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.request_receipts WHERE request_id=id), 'corrected write with new ID succeeds');
  rejected := false;
  BEGIN
    PERFORM idempotency_test.apply(id,f.user_ids[2],expression);
  EXCEPTION WHEN invalid_parameter_value THEN rejected := true;
  END;
  PERFORM pg_temp.check_rules(rejected, 'another actor cannot replay a receipt');
  rejected := false;
  BEGIN
    PERFORM idempotency_test.apply(id,f.user_ids[1],format('public.update_league_configuration_atomic(%L,%L::jsonb)',f.league_id,'{}'));
  EXCEPTION WHEN invalid_parameter_value THEN rejected := true;
  END;
  PERFORM pg_temp.check_rules(rejected, 'another function cannot reuse an ID');
  rejected := false;
  BEGIN
    PERFORM idempotency_test.apply(id,f.user_ids[1],format('public.update_league_settings_atomic(%L,%L::jsonb)',f.league_id,'{"trade_veto_window_hours":13}'));
  EXCEPTION WHEN invalid_parameter_value THEN rejected := true;
  END;
  PERFORM pg_temp.check_rules(rejected, 'different input cannot reuse an ID');
  INSERT INTO private.request_receipts(request_id,actor,function,result,input_hash,created_at)
  VALUES(old_id,f.user_ids[1],'retention-test','null','test',now()-interval '8 days'),
    (boundary_id,f.user_ids[1],'retention-test','null','test',now()-interval '7 days'),
    (recent_id,f.user_ids[1],'retention-test','null','test',now()-interval '1 day');
  result := public.prune_unbounded_history();
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.request_receipts WHERE request_id=old_id), 'retention removes receipts older than seven days');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM private.request_receipts WHERE request_id IN(boundary_id,recent_id)), 'retention keeps boundary and recent receipts');
  PERFORM pg_temp.check_rules((result->>'request_receipts')::int>=1, 'existing retention job reports receipt pruning');
  PERFORM pg_temp.check_rules(NOT has_table_privilege('authenticated','private.request_receipts','SELECT,INSERT,UPDATE,DELETE'), 'clients cannot read or write receipts');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','private.claim_request(uuid,uuid)','EXECUTE'), 'clients cannot claim receipts directly');
END;
$$;
\ir idempotency-cleanup.sql
