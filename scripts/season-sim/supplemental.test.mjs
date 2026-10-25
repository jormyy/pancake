import assert from'node:assert/strict'
import test from'node:test'
import{homedir}from'node:os'
import{config}from'./common.mjs'
import path from'node:path'
import{assertSupplemental,checkSkippedDraft,checkUnstartedBackstop,runAncillary}from'./supplemental.mjs'

test('supplemental writes refuse the running stack even with a matching task prefix',()=>{
  const own={...config,root:path.join(homedir(),'pancake-t_4ba51e0d/lanes/sim-supp'),project:'pt4basimx',prefix:'581'}
  assert.doesNotThrow(()=>assertSupplemental(own))
  for(const value of [{...own,root:own.root.replace('sim-supp','sim')},{...own,project:'pt4basim'},{...own,prefix:'572'}])assert.throws(()=>assertSupplemental(value))
})

test('skip expiry requires one skipped first pick, seven selected picks and no remaining timer',()=>{
  const picks=Array.from({length:8},(_,index)=>index?{picked_at:'at',player_id:'p',skipped_at:null,timer_expires_at:null}:{picked_at:null,player_id:null,skipped_at:'at',timer_expires_at:null})
  assert.ok(checkSkippedDraft(picks,'completed').passed)
  for(const changed of [[...picks.slice(1)],picks.map((p,i)=>i? p:{...p,player_id:'p'}),picks.map((p,i)=>i===7?{...p,timer_expires_at:'later'}:p)])assert.throws(()=>checkSkippedDraft(changed,'completed'))
})

test('the unstarted backstop requires all twelve real selections and the supported timer',()=>{
  const draft={status:'completed',pick_timer_seconds:60},picks=Array.from({length:12},()=>({player_id:'p',picked_at:'at',skipped_at:null,timer_expires_at:null}))
  assert.ok(checkUnstartedBackstop(draft,picks).passed)
  assert.throws(()=>checkUnstartedBackstop({...draft,pick_timer_seconds:30},picks))
  assert.throws(()=>checkUnstartedBackstop(draft,picks.slice(1)))
  assert.throws(()=>checkUnstartedBackstop(draft,picks.map((row,i)=>i?row:{...row,player_id:null})))
})


test('VACUUM smoke runs outside a transaction and changed primary data fails the check',async()=>{
  const catalog=['league-inventory-hint-drain','mock-room-expiry','pg-net-response-vacuum','retention-prune'].map(jobname=>({jobname,command:jobname==='pg-net-response-vacuum'?'VACUUM net._http_response':'SELECT 1'})),calls=[]
  const result=await runAncillary(catalog,{execute:async statement=>{calls.push(statement);return''},fingerprint:async()=>({rows:1})})
  assert.equal(result.length,4)
  assert.match(calls[calls.indexOf('VACUUM net._http_response')-1],/^SET statement_timeout/)
  let reads=0
  await assert.rejects(()=>runAncillary(catalog,{execute:async()=>'',fingerprint:async()=>({rows:reads++})}))
})
