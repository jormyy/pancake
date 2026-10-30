import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function persistentFixture({sql,fixture,anchor,directory,performance}) {
  const namespace='lineup_draft_sql_lab'
  const recovery=path.resolve(directory,'../restore-sql.sql')
  const present=()=>sql(`SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='${namespace}');`).trim()==='t'
  const recover=()=>{
    if(present()) sql(`SELECT ${namespace}.undo(0);`)
    sql(readFileSync(recovery,'utf8')+`\nDROP SCHEMA IF EXISTS ${namespace} CASCADE;`)
    rmSync(recovery)
  }
  if(existsSync(recovery)) recover()
  const definitions=JSON.parse(sql("SELECT jsonb_build_object('now',pg_get_functiondef('pg_catalog.now()'::regprocedure),'clock',pg_get_functiondef('pg_catalog.clock_timestamp()'::regprocedure),'uuid',pg_get_functiondef('pg_catalog.gen_random_uuid()'::regprocedure),'pid',pg_get_functiondef('pg_catalog.pg_backend_pid()'::regprocedure));"))
  const events=JSON.parse(sql("SELECT jsonb_agg(jsonb_build_object('name',evtname,'enabled',evtenabled)) FROM pg_event_trigger WHERE evtname IN('pgrst_ddl_watch','pgrst_drop_watch');"))
  const restore=Object.values(definitions).map(source=>source.trimEnd()+';').join('\n')+'\n'+events.map(row=>`ALTER EVENT TRIGGER ${row.name} ${row.enabled==='D'?'DISABLE':'ENABLE'};`).join('\n')
  writeFileSync(recovery,restore)
  try {
    sql(events.map(row=>`ALTER EVENT TRIGGER ${row.name} DISABLE;`).join('\n'))
    const audit=readFileSync('tests/db/lineup-draft-http.sql','utf8').replaceAll('lineup_draft_http_lab',namespace).replaceAll('http-lineup-draft-','lineup-draft-')
    const output=sql(`BEGIN; ${audit} CREATE OR REPLACE FUNCTION pg_catalog.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${anchor}'::timestamptz $$; ${fixture}\nSELECT jsonb_agg(to_jsonb(c) ORDER BY name,manager) FROM action_cases c; COMMIT;`)
    const cases=JSON.parse(output.trim().split('\n').filter(line=>line.startsWith('[')).at(-1))
    if(performance) sql(`SELECT ${namespace}.auditing(false);`)
    return {cases,close:recover}
  } catch(error) {
    try { recover() } catch { }
    throw error
  }
}
