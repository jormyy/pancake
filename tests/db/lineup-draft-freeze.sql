CREATE TEMP SEQUENCE action_ids;
GRANT USAGE,SELECT ON SEQUENCE action_ids TO PUBLIC;
CREATE OR REPLACE FUNCTION pg_catalog.gen_random_uuid() RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT md5('lineup-draft-'||nextval('pg_temp.action_ids'))::uuid $$;
CREATE OR REPLACE FUNCTION pg_catalog.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT now() $$;
CREATE TEMP TABLE action_writes(table_name text,operation text);
CREATE FUNCTION pg_temp.action_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN INSERT INTO action_writes VALUES(format('%I.%I',TG_TABLE_SCHEMA,TG_TABLE_NAME),TG_OP); RETURN NULL; END;
$$;
CREATE FUNCTION pg_temp.action_snapshot() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t text; value jsonb; result jsonb:='{}';
BEGIN
FOR t IN SELECT DISTINCT table_name FROM action_writes ORDER BY table_name LOOP
EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]'') FROM %s r',t) INTO value;
result:=result||jsonb_build_object(t,value);
END LOOP;
RETURN result;
END;
$$;
