import assert from 'node:assert/strict'
import test from 'node:test'
import { settlementBudget, settlementCosts } from './settlement.mjs'

const snapshot=(second,wal,sessions,calls)=>({at:new Date(second*1000).toISOString(),
  wal:{wal_bytes:String(wal)},database:{sessions},storage:{databaseBytes:100+second},
  statementInfo:{stats_reset:'fixed'},statements:[{queryid:'1',userid:'1',dbid:'1',toplevel:true,
    query:'select public.get_live_checkpoint_inputs($1)',calls,total_exec_time:calls*100,wal_bytes:'0'}]})

test('successful runs always allow normal settlement and only named negative controls can omit it',()=>{
  assert.equal(settlementBudget({}),180000)
  assert.equal(settlementBudget({publicLive:true}),1920000)
  assert.equal(settlementBudget({ingestionOff:true}),0)
  assert.equal(settlementBudget({skipSettlement:true,fault:'phone-final'}),0)
  assert.throws(()=>settlementBudget({skipSettlement:true}))
  assert.throws(()=>settlementBudget({skipSettlement:true,fault:'phone-final',broken:true}))
})

test('checkpoint settlement is measured separately from the timed snapshot',()=>{
  const start=snapshot(10,100,3,5),end=snapshot(70,300,7,8)
  const original=structuredClone(start)
  const result=settlementCosts(start,end)
  assert.equal(result.seconds,60)
  assert.equal(result.walBytes,200)
  assert.equal(result.newSessions,4)
  assert.equal(result.statements[0].calls,3)
  assert.equal(result.statementExecSecondsPerMinuteByFunction[0].execSecondsPerMinute,.3)
  assert.deepEqual(start,original)
})

test('a reset or backward settlement counter fails instead of producing a cheap run',()=>{
  const start=snapshot(10,100,3,5)
  const end=snapshot(70,300,7,8)
  assert.throws(()=>settlementCosts(start,{...end,statementInfo:{stats_reset:'changed'}}))
  assert.throws(()=>settlementCosts(start,snapshot(70,99,7,8)))
  assert.throws(()=>settlementCosts(start,snapshot(9,300,7,8)))
})
