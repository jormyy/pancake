CREATE SCHEMA lineup_draft_http_lab;
CREATE SEQUENCE lineup_draft_http_lab.ids;
GRANT USAGE ON SCHEMA lineup_draft_http_lab TO PUBLIC;
GRANT USAGE,SELECT ON SEQUENCE lineup_draft_http_lab.ids TO PUBLIC;
CREATE TABLE lineup_draft_http_lab.audit(n bigint GENERATED ALWAYS AS IDENTITY,table_name text,operation text,old_row jsonb,new_row jsonb);
CREATE FUNCTION lineup_draft_http_lab.record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
INSERT INTO lineup_draft_http_lab.audit(table_name,operation,old_row,new_row)
VALUES(format('%I.%I',TG_TABLE_SCHEMA,TG_TABLE_NAME),TG_OP,to_jsonb(OLD),to_jsonb(NEW));
RETURN NULL;
END;
$$;
DO $$ DECLARE t record; BEGIN
FOR t IN SELECT c.oid::regclass AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('public','private','auth','net') AND c.relkind IN ('r','p') AND NOT c.relispartition
LOOP EXECUTE format('CREATE TRIGGER action_http_audit AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION lineup_draft_http_lab.record()',t.name); END LOOP;
END;
$$;
CREATE FUNCTION lineup_draft_http_lab.snapshot(p_after bigint) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t text; value jsonb; result jsonb:='{}';
BEGIN
FOR t IN SELECT DISTINCT table_name FROM lineup_draft_http_lab.audit WHERE n>p_after ORDER BY table_name LOOP
EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]'') FROM %s r',t) INTO value;
result:=result||jsonb_build_object(t,value);
END LOOP;
RETURN result;
END;
$$;
CREATE FUNCTION lineup_draft_http_lab.undo(p_after bigint, p_keep boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE change record; columns text; predicate text;
BEGIN
PERFORM set_config('session_replication_role','replica',true);
FOR change IN SELECT * FROM lineup_draft_http_lab.audit WHERE n>p_after ORDER BY n DESC LOOP
SELECT string_agg(format('r.%1$I IS NOT DISTINCT FROM j.%1$I',a.attname),' AND ') INTO predicate
FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
WHERE i.indrelid=change.table_name::regclass AND i.indisprimary;
IF predicate IS NULL THEN
EXECUTE format('DELETE FROM %s r WHERE to_jsonb(r)=$1 OR to_jsonb(r)=$2',change.table_name) USING change.new_row,change.old_row;
ELSE
EXECUTE format('DELETE FROM %1$s r WHERE EXISTS(SELECT 1 FROM jsonb_populate_record(NULL::%1$s,$1) j WHERE %2$s) OR EXISTS(SELECT 1 FROM jsonb_populate_record(NULL::%1$s,$2) j WHERE %2$s)',change.table_name,predicate) USING change.new_row,change.old_row;
END IF;
IF change.old_row IS NOT NULL THEN
SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO columns FROM pg_attribute
WHERE attrelid=change.table_name::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='';
EXECUTE format('INSERT INTO %s(%s) OVERRIDING SYSTEM VALUE SELECT %s FROM jsonb_populate_record(NULL::%s,$1)',change.table_name,columns,columns,change.table_name) USING change.old_row;
END IF;
END LOOP;
IF NOT p_keep THEN DELETE FROM lineup_draft_http_lab.audit WHERE n>p_after; END IF;
END;
$$;
CREATE OR REPLACE FUNCTION pg_catalog.gen_random_uuid() RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT md5('http-lineup-draft-'||nextval('lineup_draft_http_lab.ids'))::uuid $$;
CREATE OR REPLACE FUNCTION pg_catalog.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT now() $$;
CREATE OR REPLACE FUNCTION pg_catalog.pg_backend_pid() RETURNS int LANGUAGE sql STABLE AS $$ SELECT 64500 $$;
CREATE FUNCTION lineup_draft_http_lab.auditing(p_enabled boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t regclass;
BEGIN
FOR t IN SELECT tgrelid::regclass FROM pg_trigger WHERE tgname='action_http_audit' LOOP
EXECUTE format('ALTER TABLE %s %s TRIGGER action_http_audit',t,CASE WHEN p_enabled THEN 'ENABLE' ELSE 'DISABLE' END);
END LOOP;
END;
$$;
