import assert from 'node:assert/strict'
import { createCheckpointPoller, CHECKPOINT_INTERVAL_MS } from './checkpoint.ts'
import type { CheckpointGame, LiveTick } from './checkpoint.ts'

const start = Date.parse('2026-10-31T23:00:00Z')
const date = '2026-10-31'
const row = (): CheckpointGame => ({ id:'game',nba_game_id:'0021',game_date:date,status:'InProgress',game_time:null,
  home_team:'BOS',away_team:'NYK',checkpoint_at:new Date(start).toISOString(),needs_final_check:false })
const result = (): LiveTick => ({ lines:24,keepRunning:true,worked:true,failures:[],scoreRetries:0,tickRetries:0 })
const snapshot = (now: number, status='InProgress', mode='public') => ({ version:1,mode,date,capturedAt:now,
  games:mode==='database' ? [] : [{ id:'0021',nbaId:'0021',espnId:null,status,updatedAt:now,
    home:{team:'BOS',score:0,players:[]},away:{team:'NYK',score:0,players:[]} }] })

Deno.test('shared ticks avoid database work between thirty-minute checkpoints', async () => {
  let now=start, loads=0, writes=0, records=0
  const game=row()
  const tick=createCheckpointPoller({ now:()=>now,load:async()=>{loads++;return [game]},snapshot:async()=>snapshot(now),
    ingest:async(_holder,ids)=>{assert.deepEqual([...ids!],['game']);writes++;return result()},
    record:async()=>{records++;game.checkpoint_at=new Date(now).toISOString()} })
  assert.equal(CHECKPOINT_INTERVAL_MS,1800000)
  for(let elapsed=0;elapsed<CHECKPOINT_INTERVAL_MS;elapsed+=30000) { now=start+elapsed; assert.equal((await tick('holder')).keepRunning,true) }
  assert.equal(loads,1)
  assert.equal(writes,0)
  now=start+CHECKPOINT_INTERVAL_MS
  await tick('holder')
  assert.equal(writes,1)
  assert.equal(records,1)
  assert.equal(loads,2)
})

Deno.test('tipoffs and finals save immediately without waiting for a checkpoint', async () => {
  let now=start, status='Scheduled', writes=0
  const game=row();game.status='Scheduled'
  const tick=createCheckpointPoller({now:()=>now,load:async()=>game.status==='Final'?[]:[game],snapshot:async()=>snapshot(now,status),
    ingest:async()=>{writes++;game.status=status;return result()},record:async()=>{game.checkpoint_at=new Date(now).toISOString()} })
  await tick('holder');assert.equal(writes,0)
  status='InProgress';now+=30000;await tick('holder');assert.equal(writes,1)
  status='Final';now+=30000;assert.equal((await tick('holder')).keepRunning,false);assert.equal(writes,2)
})

Deno.test('the server off switch restores unfiltered legacy ingestion', async () => {
  let writes=0
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[row()],snapshot:async()=>snapshot(start,'InProgress','database'),
    ingest:async(_holder,ids)=>{assert.equal(ids,undefined);writes++;return result()},record:async()=>assert.fail('No checkpoint in legacy mode') })
  await tick('holder');await tick('holder');assert.equal(writes,2)
})

Deno.test('a failed save never advances the recovery checkpoint', async () => {
  const game=row();game.checkpoint_at=null
  let writes=0
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[game],snapshot:async()=>snapshot(start),
    ingest:async()=>{writes++;return {...result(),failures:['save failed']}},record:async()=>assert.fail('Failed save must retry') })
  assert.deepEqual((await tick('holder')).failures,['save failed'])
  await tick('holder');assert.equal(writes,2)
})

Deno.test('stale public data fails before any official write', async () => {
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[row()],snapshot:async()=>snapshot(start-120001),
    ingest:async()=>{assert.fail('No write from stale data')},record:async()=>{} })
  await assert.rejects(()=>tick('holder'),/stale or invalid/)
})
