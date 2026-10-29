import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const command=fileURLToPath(new URL('../../scripts/db-health/pancake',import.meta.url))

test('the operator command exports the source audit without a database connection',()=>{
  const result=spawnSync(command,['db-health','--sources'],{encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
  assert.ok(JSON.parse(result.stdout).functions.length>0)
})

test('the operator command rejects unknown commands and foreign databases',()=>{
  assert.equal(spawnSync(command,['unknown'],{encoding:'utf8'}).status,2)
  const result=spawnSync(command,['db-health'],{encoding:'utf8',env:{...process.env,SUPABASE_DB_URL:'postgres://local@192.0.2.1:57422/postgres'}})
  assert.equal(result.status,1)
  assert.match(result.stderr,/assigned loopback/)
})

test('live verification validates its target before loading database tests',()=>{
  const env={...process.env,SUPABASE_DB_URL:'postgres://local@192.0.2.1:57422/postgres'}
  const foreign=spawnSync(command,['db-health','--verify'],{encoding:'utf8',env})
  assert.equal(foreign.status,1)
  assert.match(foreign.stderr,/assigned loopback/)
  const extra=spawnSync(command,['db-health','--verify','extra'],{encoding:'utf8',env})
  assert.equal(extra.status,1)
  assert.match(extra.stderr,/Use --verify/)
})
