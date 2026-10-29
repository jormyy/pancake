\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE role record;
BEGIN
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN('anon','authenticated','service_role','authenticator'))<>4 THEN
    RAISE EXCEPTION 'An application role is missing';
  END IF;
  FOR role IN SELECT rolname,coalesce(rolconfig,'{}') AS rolconfig FROM pg_roles WHERE rolname IN('anon','authenticated','service_role','authenticator') LOOP
    IF NOT 'idle_in_transaction_session_timeout=60s'=ANY(role.rolconfig)
      OR NOT ('statement_timeout='||CASE WHEN role.rolname IN('anon','service_role') THEN '3s' ELSE '8s' END)=ANY(role.rolconfig)
      OR NOT ('lock_timeout='||CASE WHEN role.rolname='service_role' THEN '250ms' ELSE '500ms' END)=ANY(role.rolconfig) THEN
      RAISE EXCEPTION 'Application role limits are missing: %',role.rolname;
    END IF;
  END LOOP;
END;
$$;
ROLLBACK;
