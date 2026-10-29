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
