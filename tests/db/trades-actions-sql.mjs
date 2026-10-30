import { readFileSync } from 'node:fs'

export const quote = value => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`
export const identifier = value => {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw new Error('Invalid SQL identifier')
  return `"${value}"`
}
export const argument = value => value == null ? 'NULL' : Array.isArray(value) ? `${quote(JSON.stringify(value))}::jsonb` : typeof value === 'object' ? `${quote(JSON.stringify(value))}::jsonb` : quote(value)
export const fixedClock = '2026-10-30T12:00:00.000Z'

export const labSetup = `
CREATE SCHEMA IF NOT EXISTS trades_actions_lab;
CREATE OR REPLACE FUNCTION trades_actions_lab.uuid() RETURNS uuid LANGUAGE plpgsql VOLATILE AS $$
DECLARE n bigint:=coalesce(nullif(current_setting('trades_actions_lab.uuid',true),''),'0')::bigint+1;
BEGIN PERFORM set_config('trades_actions_lab.uuid',n::text,true); RETURN ('aaaaaaaa-aaaa-4aaa-8aaa-'||lpad(n::text,12,'0'))::uuid; END $$;
CREATE OR REPLACE FUNCTION trades_actions_lab.xid() RETURNS xid8 LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('trades_actions_lab.xid',true),''),'100')::xid8;
$$;
CREATE OR REPLACE FUNCTION trades_actions_lab.execute(command text,profile boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb; detail text; hint text;
BEGIN
  EXECUTE command INTO result;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN jsonb_build_object('data',result);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS detail=PG_EXCEPTION_DETAIL,hint=PG_EXCEPTION_HINT;
  RETURN jsonb_build_object('error',jsonb_build_object('code',SQLSTATE,'message',SQLERRM,'details',nullif(detail,''),'hint',nullif(hint,'')));
END $$;
CREATE TEMP TABLE trades_actions_touched(relation text PRIMARY KEY);
CREATE OR REPLACE FUNCTION trades_actions_lab.touch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN INSERT INTO pg_temp.trades_actions_touched VALUES(format('%I.%I',TG_TABLE_SCHEMA,TG_TABLE_NAME)) ON CONFLICT DO NOTHING; RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION trades_actions_lab.snapshot() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r record; rows jsonb; result jsonb:='{}';
BEGIN FOR r IN SELECT relation FROM pg_temp.trades_actions_touched ORDER BY relation LOOP
  EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM '||r.relation||' t' INTO rows;
  result:=result||jsonb_build_object(r.relation,rows);
END LOOP; RETURN result; END $$;
DO $$ DECLARE r record; definition text; BEGIN
  FOR r IN SELECT oid FROM pg_proc WHERE pronamespace IN ('public'::regnamespace,'private'::regnamespace) AND prolang IN (SELECT oid FROM pg_language WHERE lanname IN ('sql','plpgsql')) AND prokind='f' LOOP
    definition:=pg_get_functiondef(r.oid);
    definition:=regexp_replace(definition,'(pg_catalog[.])?gen_random_uuid[(][)]','trades_actions_lab.uuid()','g');
    definition:=regexp_replace(definition,'(pg_catalog[.])?(now|clock_timestamp|transaction_timestamp|statement_timestamp)[(][)]',quote_literal('${fixedClock}')||'::timestamptz','g');
    definition:=replace(definition,'pg_current_xact_id()','trades_actions_lab.xid()');
    definition:=replace(definition,'txid_current()','trades_actions_lab.xid()::text::bigint');
    EXECUTE definition;
  END LOOP;
  FOR r IN SELECT c.oid::regclass relation,a.attname,pg_get_expr(d.adbin,d.adrelid) expression
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE c.relnamespace IN ('public'::regnamespace,'private'::regnamespace) AND c.relkind IN ('r','p') AND a.attgenerated='' LOOP
    definition:=regexp_replace(r.expression,'(pg_catalog[.])?gen_random_uuid[(][)]','trades_actions_lab.uuid()','g');
    definition:=regexp_replace(definition,'(pg_catalog[.])?(now|clock_timestamp|transaction_timestamp|statement_timestamp)[(][)]',quote_literal('${fixedClock}')||'::timestamptz','g');
    IF definition<>r.expression THEN EXECUTE format('ALTER TABLE %s ALTER COLUMN %I SET DEFAULT %s',r.relation,r.attname,definition); END IF;
  END LOOP;
END $$;
`

export const fixture = readFileSync(new URL('./rules-support.sql', import.meta.url), 'utf8').replaceAll('gen_random_uuid()', 'trades_actions_lab.uuid()') + `
SELECT set_config('trades_actions_lab.uuid','0',true);
CREATE TEMP TABLE actions_fixture AS SELECT * FROM pg_temp.rules_fixture(10,2027);
UPDATE public.leagues SET roster_size=20,ir_slots=2,taxi_slots=3,allow_inactive_trades=true,
  trade_deadline=NULL,trade_veto_window_hours=24,trade_veto_mode='member_vote'
  WHERE id=(SELECT league_id FROM actions_fixture);
CREATE TEMP TABLE actions_players AS SELECT id,((row_number() OVER(ORDER BY rank,id)-1)/25+1)::int team,((row_number() OVER(ORDER BY rank,id)-1)%25+1)::int slot
  FROM (SELECT p.id,r.source_rank rank FROM public.players p JOIN public.dynasty_rankings r ON r.player_id=p.id AND r.source='onenumberhoops.com' WHERE p.nba_team IS NOT NULL ORDER BY r.source_rank,p.id LIMIT 250) p;
UPDATE public.players SET injury_status='Out',years_exp=0,career_regular_season_games=0 WHERE id IN(SELECT id FROM actions_players WHERE slot>=21);
UPDATE public.players SET nba_team='TST' WHERE id IN(SELECT id FROM actions_players);
SELECT private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[p.team],p.id,'draft',trades_actions_lab.uuid())
  FROM actions_fixture f CROSS JOIN actions_players p WHERE p.slot>=23;
INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir,is_on_taxi)
  SELECT f.league_id,f.season_id,f.member_ids[p.team],p.id,'draft',p.slot BETWEEN 21 AND 22,p.slot>=23
  FROM actions_fixture f CROSS JOIN actions_players p;
INSERT INTO public.draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
  SELECT f.league_id,2028,r,f.member_ids[t],f.member_ids[t] FROM actions_fixture f CROSS JOIN generate_series(1,10)t CROSS JOIN generate_series(1,3)r;
UPDATE public.trades SET status='expired' WHERE status='pending' AND expires_at<='${fixedClock}';
UPDATE public.trades SET veto_window_expires_at='2099-01-01' WHERE status='accepted';
TRUNCATE public.notification_outbox;
SELECT set_config('pancake.trade_write','',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('trades_actions_lab.uuid','100000',true);
`

export const auditSetup = `DO $$ DECLARE r record; BEGIN
FOR r IN SELECT c.oid::regclass relation FROM pg_class c WHERE c.relnamespace IN ('public'::regnamespace,'private'::regnamespace,'analytics'::regnamespace,'net'::regnamespace)
  AND c.relkind IN ('r','p') AND NOT c.relispartition LOOP
  EXECUTE format('CREATE TRIGGER trades_actions_touch AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH STATEMENT EXECUTE FUNCTION trades_actions_lab.touch()',r.relation);
END LOOP; END $$;
TRUNCATE trades_actions_touched;`

export const sequenceReset = `DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT schemaname,sequencename FROM pg_sequences WHERE schemaname IN ('public','private') LOOP
    PERFORM setval(format('%I.%I',r.schemaname,r.sequencename)::regclass,2000000,false);
  END LOOP;
END $$;`

export const writeCounters = `SELECT coalesce(jsonb_object_agg(schemaname||'.'||relname,jsonb_build_object('insert',n_tup_ins,'update',n_tup_upd,'delete',n_tup_del)),'{}') FROM pg_stat_xact_user_tables WHERE schemaname IN ('public','private','analytics','net');`

export const functionCounters = `SELECT coalesce(jsonb_object_agg(name,jsonb_build_object('calls',calls,'total',total,'self',self,'isTrigger',is_trigger)),'{}') FROM (
  SELECT s.schemaname||'.'||s.funcname name,sum(s.calls) calls,sum(s.total_time) total,sum(s.self_time) self,bool_or(p.prorettype='trigger'::regtype) is_trigger
  FROM pg_stat_xact_user_functions s JOIN pg_proc p ON p.oid=s.funcid
  WHERE s.schemaname IN ('public','private') GROUP BY s.schemaname,s.funcname) f;`

export const statementCounters = `WITH s AS (SELECT *,toplevel AND query ~ '^[[:space:]]*SELECT trades_actions_lab[.]execute[(]' root FROM extensions.pg_stat_statements)
  SELECT jsonb_build_object('calls',coalesce(sum(calls) FILTER(WHERE root),0),
    'statements',coalesce(sum(calls) FILTER(WHERE NOT toplevel OR root),0),
    'milliseconds',coalesce(sum(total_exec_time) FILTER(WHERE root),0),
    'hits',coalesce(sum(shared_blks_hit) FILTER(WHERE root),0),'reads',coalesce(sum(shared_blks_read) FILTER(WHERE root),0),
    'wal',coalesce(sum(wal_bytes) FILTER(WHERE root),0)) FROM s;`
