import assert from 'node:assert/strict'
import test from 'node:test'
import { retryableWorkFailure,assertRetriedWorkCompleted } from './work-retries.mjs'

test('only failures owned by a live bounded queue item defer acceptance',()=>{
  const row={status_code:500,worker_status:'failed',work_id:1,work_attempts:1,work_status:'failed'}
  assert.equal(retryableWorkFailure(row),true)
  for(const change of [{work_id:null},{work_status:'dead'},{work_attempts:3},{work_attempts:0},{status_code:403}]){
    assert.equal(retryableWorkFailure({...row,...change}),false)
  }
  assert.equal(retryableWorkFailure({...row,status_code:null,timed_out:true,worker_status:'running',work_status:'running'}),true)
})

test('deferred failures still fail acceptance unless every task succeeds',()=>{
  assert.deepEqual(assertRetriedWorkCompleted([1,2],[{id:1,status:'succeeded'},{id:2,status:'succeeded'}]),{checked:2,succeeded:2})
  for(const status of ['failed','dead','pending','running'])assert.throws(()=>assertRetriedWorkCompleted([1],[{id:1,status}]))
  assert.throws(()=>assertRetriedWorkCompleted([1],[]))
})

test('a persistent data error cannot pass by using the retry path',()=>{
  const row={status_code:500,worker_status:'failed',work_id:1,work_attempts:1,work_status:'failed',sync_error:'ambiguous identity'}
  assert.equal(retryableWorkFailure(row),true)
  assert.equal(retryableWorkFailure({...row,work_attempts:3,work_status:'dead'}),false)
  assert.throws(()=>assertRetriedWorkCompleted([1],[{id:1,status:'dead'}]))
})

test('a reconciled stale receipt can wait for its bounded replacement attempt', () => {
  const row = { status_code: 200, worker_status: 'failed', sync_error: 'worker did not finish within 10 minutes', work_id: 111, work_attempts: 2, work_status: 'succeeded' }
  assert.equal(retryableWorkFailure(row), true)
  assert.equal(retryableWorkFailure({ ...row, work_status: 'failed' }), true)
  assert.equal(retryableWorkFailure({ ...row, work_status: 'running' }), true)
  assert.equal(retryableWorkFailure({ ...row, work_status: 'running', work_attempts: 3 }), true)
  assert.equal(retryableWorkFailure({ ...row, work_status: 'failed', work_attempts: 3 }), false)
  assert.throws(() => assertRetriedWorkCompleted([111], [{ id: 111, status: 'running' }]))
  assert.equal(retryableWorkFailure({ ...row, sync_error: 'business rule failed' }), false)
})

test('a refused connection can follow the bounded production retry path', () => {
  const row = { status_code: null, worker_status: null, error_msg: "Couldn't connect to server", work_id: 111, work_attempts: 1, work_status: 'running' }
  assert.equal(retryableWorkFailure(row), true)
  assert.equal(retryableWorkFailure({ ...row, work_attempts: 3 }), true)
  assert.equal(retryableWorkFailure({ ...row, work_id: null }), false)
})

test('a transport timeout stays retryable after its old receipt is reconciled', () => {
  const row = { status_code: null, timed_out: true, worker_status: 'failed', work_id: 111, work_attempts: 2, work_status: 'running' }
  assert.equal(retryableWorkFailure(row), true)
  assert.equal(retryableWorkFailure({ ...row, work_status: 'dead' }), false)
  assert.throws(() => assertRetriedWorkCompleted([111], [{ id: 111, status: 'dead' }]))
})

test('the last production attempt can finish after an older receipt expires', () => {
  const row = { id: 54893, work_id: 4876, work_status: 'running', work_attempts: 3, status_code: 200, worker_status: 'failed', sync_error: 'worker did not finish within 10 minutes' }
  assert.equal(retryableWorkFailure(row), true)
  assert.equal(retryableWorkFailure({ ...row, work_status: 'succeeded' }), true)
  for (const work_status of ['failed', 'dead', 'pending']) assert.equal(retryableWorkFailure({ ...row, work_status }), false)
  for (const work_attempts of [0, 4, 1.5]) assert.equal(retryableWorkFailure({ ...row, work_attempts }), false)
  assert.throws(() => assertRetriedWorkCompleted([4876], [{ id: 4876, status: 'running' }]))
  assert.deepEqual(assertRetriedWorkCompleted([4876], [{ id: 4876, status: 'succeeded' }]), { checked: 1, succeeded: 1 })
})
