import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForDatabaseReady } from './database-readiness.mjs'

test('SQL readiness cannot bypass a starting Docker health check',async()=>{
  const states=['starting','healthy']
  let queries=0,waits=0
  await waitForDatabaseReady(async()=>{queries++},async()=>states.shift(),{wait:async()=>{waits++}})
  assert.equal(queries,1)
  assert.equal(waits,1)
})

test('a healthy container still needs a working database connection',async()=>{
  let queries=0
  await waitForDatabaseReady(async()=>{if(++queries===1)throw new Error('connection refused')},async()=>'healthy',{wait:async()=>{}})
  assert.equal(queries,2)
})

test('unhealthy containers fail at the bounded retry limit',async()=>{
  let checks=0,queries=0,waits=0
  await assert.rejects(()=>waitForDatabaseReady(async()=>{queries++},async()=>{checks++;return 'unhealthy'},{attempts:3,wait:async()=>{waits++}}),/Docker health is unhealthy/)
  assert.equal(checks,3)
  assert.equal(queries,0)
  assert.equal(waits,2)
})
