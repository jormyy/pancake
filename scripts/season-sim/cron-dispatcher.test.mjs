import assert from 'node:assert/strict'
import test from 'node:test'
import { canAdvanceWorkers,cronDispatcher } from './cron-dispatcher.mjs'

test('finished HTTP calls awaiting pg_net collection do not block other sleeping workers', () => {
  const rows = [{ worker_status: 'failed' }, { worker_status: 'running' }, { worker_status: 'running' }]
  const state = { active: 2, sleeping: 2, fetches: 0, nextAt: 376 }
  assert.ok(canAdvanceWorkers(rows, state, 347))
  assert.ok(!canAdvanceWorkers([...rows, { worker_status: 'pending' }], state, 347))
  assert.ok(!canAdvanceWorkers(rows, { ...state, fetches: 1 }, 347))
  assert.ok(!canAdvanceWorkers(rows, { ...state, sleeping: 1 }, 347))
  assert.ok(!canAdvanceWorkers(rows, state, 376))
})

test('completed workers do not wait for delayed HTTP response collection', () => {
  const idle = { active: 0, sleeping: 0, fetches: 0, nextAt: null }
  assert.ok(canAdvanceWorkers([{ worker_status: 'success' }], idle, 347))
  assert.ok(canAdvanceWorkers([{ worker_status: 'failed' }], idle, 347))
  assert.ok(!canAdvanceWorkers([{ worker_status: 'pending' }], idle, 347))
  assert.ok(!canAdvanceWorkers([{ worker_status: 'running' }], idle, 347))
})

test('a pg_net request still queued behind a sleeping batch does not freeze its business clock',()=>{
  const rows=[{worker_status:'running',queue_pending:false},{worker_status:null,queue_pending:true}]
  const sleeping={active:1,sleeping:1,fetches:0,nextAt:20000}
  assert.ok(canAdvanceWorkers(rows,sleeping,10000))
  assert.ok(!canAdvanceWorkers(rows,{...sleeping,fetches:1},10000))
  assert.ok(!canAdvanceWorkers(rows,{...sleeping,sleeping:0},10000))
  assert.ok(!canAdvanceWorkers(rows,{...sleeping,active:0,sleeping:0},10000))
  assert.ok(!canAdvanceWorkers(rows.map(row=>({...row,queue_pending:false})),sleeping,10000))
})

test('diagnostics leave real dispatch failures fatal',async()=>{
  const rows=[]
  let closed=false
  const probe={watch(){},finish(){},check:async()=>{},close:async()=>{closed=true}}
  const driver=cronDispatcher(row=>assert.equal(row.status_code,200,'real HTTP failure'),{
    enqueueWork:async()=>[{id:1,statement:'production gate'}],
    query:async()=>[{id:1,function_name:'live-poll',worker_status:'failed',status_code:503}],
    health:async()=>({active:0}),probe,recordOutcome:async row=>{rows.push(row)},
  })
  await driver.enqueue('production gate')
  await assert.rejects(driver.settle(0),/real HTTP failure/)
  assert.equal(rows[0].status_code,503)
  assert.equal(closed,true)
})
