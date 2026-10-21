import assert from'node:assert/strict'
import test from'node:test'
import{mkdtemp,readFile,rm}from'node:fs/promises'
import{tmpdir}from'node:os'
import path from'node:path'
import{fakeExpoRecorder}from'./push-origin.mjs'

test('fake Expo records recipient, event, business time, real dedupe key and durable receipts',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'season-sim-expo-'))
  try{
    const record=await fakeExpoRecorder(dir,()=>0,async()=>[{dedupe_key:'key'}])
    const response=await record('/push',[{to:'ExponentPushToken[season-sim-owner]',data:{notificationEvent:'draft_on_clock',pickId:'pick'}}])
    const restarted=await fakeExpoRecorder(dir,()=>60000,async()=>[])
    assert.equal((await restarted('/receipts',{ids:[response.data[0].id]})).data[response.data[0].id].status,'ok')
    const rows=(await readFile(path.join(dir,'expo-transport.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line))
    assert.equal(rows[0].dedupeKey,'key');assert.equal(rows[0].eventType,'draft_on_clock');assert.equal(rows[0].businessAt,'1970-01-01T00:00:00.000Z')
    await assert.rejects(record('/push',{to:'ExponentPushToken[real-person]',data:{}}))
    await assert.rejects(record('/receipts',{ids:['unknown']}))
  }finally{await rm(dir,{recursive:true,force:true})}
})

test('Expo correlation uses the outbox id added by the real delivery worker',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'season-sim-expo-correlation-'))
  try{
    const record=await fakeExpoRecorder(dir,()=>0,async(_token,_data,outboxId)=>{assert.equal(outboxId,'outbox');return[{dedupe_key:'key'}]})
    await record('/push',{to:'ExponentPushToken[season-sim-owner]',data:{outboxId:'outbox',notificationEvent:'draft_on_clock'}})
  }finally{await rm(dir,{recursive:true,force:true})}
})
