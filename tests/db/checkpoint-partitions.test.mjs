import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { connectionEnvironment } from '../../scripts/db-health/index.mjs'
import { partitionSchemaForRestore,restoreSnapshotPartitions } from '../../scripts/season-sim/checkpoints.mjs'
import { sha256 } from '../../scripts/season-sim/common.mjs'

test('a saved child schema restores against an indexed partition parent',{
  skip:process.env.PARTITION_DB_TESTS!=='1',
},async()=>{
  const env=connectionEnvironment(process.env.SUPABASE_DB_URL)
  const parent=`checkpoint_${randomUUID().replaceAll('-','').slice(0,10)}`
  const child=`${parent}_month`
  const table=`private.${child}`
  const directory=await mkdtemp(path.join(tmpdir(),'checkpoint-partition-'))
  const execute=statement=>execFileSync('psql',['-XqAt','--set','ON_ERROR_STOP=1'],{env,input:statement,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim()
  try{
    execute(`CREATE TABLE private.${parent}(id integer NOT NULL,day date NOT NULL,payload text,PRIMARY KEY(id,day)) PARTITION BY RANGE(day);
      CREATE INDEX ON private.${parent}(payload);
      CREATE TABLE ${table} PARTITION OF private.${parent} FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
      ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON ${table} TO service_role;
      INSERT INTO ${table}(id,day,payload) VALUES(1,'2026-01-02','retained');`)
    const data=execute(`SELECT json_build_object('id',id,'day',day,'payload',payload) FROM ${table}`)
    const source=execFileSync('pg_dump',['--schema-only','--no-comments','--table',table],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']})
    execute(`DROP TABLE ${table}`)
    assert.throws(()=>execute(source),/multiple primary keys|already exists/)
    execute(`DROP TABLE IF EXISTS ${table}`)
    const prepared=partitionSchemaForRestore(source,table)
    const file=path.join(directory,'partition-0.sql')
    await writeFile(file,prepared,{mode:0o600})
    await restoreSnapshotPartitions([{table,filename:'partition-0.sql',sha256:sha256(await readFile(file))}],directory,env,async sql=>execute(sql))
    execute(`INSERT INTO private.${parent}(id,day,payload) VALUES(1,'2026-01-02','retained')`)
    assert.equal(execute(`SELECT json_build_object('id',id,'day',day,'payload',payload) FROM ${table}`),data)
    assert.equal(execute(`SELECT count(*) FROM pg_index WHERE indrelid='${table}'::regclass`),'2')
    assert.equal(execute(`SELECT relrowsecurity AND has_table_privilege('service_role',oid,'SELECT') FROM pg_class WHERE oid='${table}'::regclass`),'t')
  }finally{
    execute(`DROP TABLE IF EXISTS private.${parent} CASCADE`)
    await rm(directory,{recursive:true,force:true})
  }
})
