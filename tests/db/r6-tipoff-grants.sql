\set ON_ERROR_STOP on
DO $$
DECLARE
  sig text;
  sigs text[] := ARRAY[
    'public.claim_lineup_tipoff_dispatch(timestamptz,uuid,text)',
    'public.renew_lineup_tipoff_dispatch(timestamptz,uuid,text)',
    'public.finish_lineup_tipoff_dispatch(timestamptz,uuid,text,text)',
    'public.get_pending_tipoff_members(timestamptz,uuid,uuid[],integer,text)',
    'public.get_pending_auto_ir_members(date,timestamptz,uuid,uuid[],integer,boolean,text)',
    'public.mark_tipoff_ir_member_done(timestamptz,uuid,uuid,uuid,uuid,text)',
    'public.record_pre_tipoff_lineup_failure(timestamptz,uuid,uuid,uuid,uuid,text,text)',
    'public.apply_pre_tipoff_lineup(timestamptz,uuid,uuid,uuid,uuid,jsonb,text)',
    'public.auto_manage_ir_tipoff_service(timestamptz,uuid,uuid,uuid,uuid,text)'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    IF has_function_privilege('anon', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can execute %', sig;
    END IF;
    IF has_function_privilege('authenticated', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated can execute %', sig;
    END IF;
    IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute %', sig;
    END IF;
  END LOOP;
END;
$$;
SELECT 'PASS r6-tipoff-grants' AS result;
