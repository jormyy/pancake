CREATE TEMP TABLE action_random(counter bigint);
INSERT INTO action_random VALUES(0);
GRANT ALL ON action_random TO postgres,authenticated,service_role;
CREATE OR REPLACE FUNCTION pg_temp.action_uuid() RETURNS uuid LANGUAGE plpgsql VOLATILE AS $$
DECLARE value bigint;
BEGIN
  UPDATE pg_temp.action_random SET counter=counter+1 RETURNING counter INTO value;
  RETURN md5('league-actions-'||value::text)::uuid;
END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.action_bytes(integer) RETURNS bytea LANGUAGE sql VOLATILE AS $$ SELECT substring(decode(repeat(replace(pg_temp.action_uuid()::text,'-',''),greatest(1,($1+15)/16)),'hex') FROM 1 FOR $1) $$;
CREATE OR REPLACE FUNCTION pg_temp.action_clock() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT transaction_timestamp() $$;
DO $instrument$
DECLARE item record; definition text;
BEGIN
  FOR item IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('public','private','analytics') AND p.prokind='f'
      AND p.prosrc ~ '(gen_random_uuid|gen_random_bytes|clock_timestamp)[(]' LOOP
    definition:=pg_get_functiondef(item.oid);
    definition:=regexp_replace(definition,'(?:(?:pg_catalog|extensions)[.])?gen_random_uuid[(]','pg_temp.action_uuid(','g');
    definition:=regexp_replace(definition,'(?:extensions[.])?gen_random_bytes[(]','pg_temp.action_bytes(','g');
    definition:=regexp_replace(definition,'(?:pg_catalog[.])?clock_timestamp[(]','pg_temp.action_clock(','g');
    EXECUTE definition;
  END LOOP;
  FOR item IN SELECT c.oid::regclass AS relation,a.attname,pg_get_expr(d.adbin,d.adrelid) AS expression
    FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
    JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private','analytics','auth','storage','net')
      AND pg_get_expr(d.adbin,d.adrelid) ~ '(gen_random_uuid|gen_random_bytes|clock_timestamp)[(]' LOOP
    definition:=regexp_replace(item.expression,'(?:(?:pg_catalog|extensions)[.])?gen_random_uuid[(]','pg_temp.action_uuid(','g');
    definition:=regexp_replace(definition,'(?:extensions[.])?gen_random_bytes[(]','pg_temp.action_bytes(','g');
    definition:=regexp_replace(definition,'(?:pg_catalog[.])?clock_timestamp[(]','pg_temp.action_clock(','g');
    EXECUTE format('ALTER TABLE %s ALTER COLUMN %I SET DEFAULT %s',item.relation,item.attname,definition);
  END LOOP;
END;
$instrument$;
CREATE TEMP TABLE action_sequences(name text,value bigint,called boolean);
DO $$
DECLARE item record; saved record;
BEGIN
  FOR item IN SELECT c.oid::regclass AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname IN ('public','private','analytics','net','auth','storage','cron','realtime') LOOP
    EXECUTE format('SELECT last_value,is_called FROM %s',item.name) INTO saved;
    INSERT INTO action_sequences VALUES(item.name,saved.last_value,saved.is_called);
  END LOOP;
END;
$$;
CREATE TEMP TABLE action_touched(name text PRIMARY KEY);
CREATE OR REPLACE FUNCTION pg_temp.action_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO pg_temp.action_touched VALUES(format('%I.%I',TG_TABLE_SCHEMA,TG_TABLE_NAME)) ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT c.oid::regclass AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND n.nspname IN ('public','private','analytics','net','auth','storage','cron','realtime') LOOP
    EXECUTE format('CREATE TRIGGER league_actions_audit AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION pg_temp.action_audit()',item.name);
  END LOOP;
END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.action_snapshot() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE item record; rows jsonb; result jsonb:='{}';
BEGIN
  FOR item IN SELECT name FROM pg_temp.action_touched ORDER BY name LOOP
    EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text),''[]''::jsonb) FROM %s row',item.name) INTO rows;
    result:=result||jsonb_build_object(item.name,rows);
  END LOOP;
  RETURN result;
END;
$$;
