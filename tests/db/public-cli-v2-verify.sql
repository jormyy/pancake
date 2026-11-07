SELECT n.nspname,p.proname,p.prosecdef,p.proconfig,
  has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') AS account_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') AS edge_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE p.oid='public.public_read_v2(uuid,text,jsonb,text)'::regprocedure;
SELECT relrowsecurity FROM pg_class WHERE oid='private.public_api_buckets'::regclass;
SELECT count(*) AS retained_legacy_sharing_function FROM pg_proc
WHERE oid='public.public_share_token(uuid,text)'::regprocedure;
