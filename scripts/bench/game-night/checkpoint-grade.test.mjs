import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readJson} from './common.mjs'
import {stateAt} from './fixture.mjs'
import {checkpointGrade} from './checkpoint-grade.mjs'

const slate=await readJson(new URL('./training.json',import.meta.url))
function fixture() {
  const started=1000000,ended=started+slate.windowSeconds*1000
  const rows=(seconds,at)=>stateAt(slate,seconds).map(game=>({id:game.id,status:game.gameStatus===3?'Final':'InProgress',checkpoint_at:new Date(at).toISOString()}))
  return {slate,started,ended,intervalMs:1800000,before:rows(0,started-1600000),after:rows(slate.windowSeconds,started+200000),
    work:{saved:10,workerStarts:2,liveTicks:1,observedScoreChanges:1},origins:9,phonePolls:90}
}
test('checkpoint work accepts approved writes and rejects a disabled ingestion path',()=>{
  const data=fixture()
  assert.equal(checkpointGrade(data).passed,true)
  assert.equal(checkpointGrade({...data,work:{...data.work,saved:0}}).passed,false)
})
test('a missing recovery checkpoint or missing final status fails',()=>{
  const checkpoint=fixture()
  checkpoint.after[3].checkpoint_at=checkpoint.before[3].checkpoint_at
  assert.equal(checkpointGrade(checkpoint).passed,false)
  const final=fixture()
  final.after[2].status='InProgress'
  assert.equal(checkpointGrade(final).passed,false)
})
