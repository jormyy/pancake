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
    ingest:async(_holder,ids,checkpointOnly)=>{assert.deepEqual([...ids!],['game']);assert.equal(checkpointOnly,true);writes++;return result()},
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
    ingest:async(_holder,_ids,checkpointOnly)=>{assert.equal(checkpointOnly,false);writes++;game.status=status;return result()},record:async()=>{game.checkpoint_at=new Date(now).toISOString()} })
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

Deno.test('stale public data uses direct ingestion for an overdue checkpoint', async () => {
  const game=row();game.checkpoint_at=null
  let writes=0
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[game],snapshot:async()=>snapshot(start-120001),
    ingest:async()=>{writes++;return result()},record:async()=>{} })
  await tick('holder');assert.equal(writes,1)
})

Deno.test('an unavailable game does not block a healthy final or advance its checkpoint', async () => {
  const missing=row(), healthy={...row(),id:'healthy',nba_game_id:'0022'}
  const calls:string[][]=[], records:string[][]=[]
  const body=snapshot(start,'Final');body.games[0].nbaId='0022'
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[missing,healthy],snapshot:async()=>body,
    ingest:async(_holder,ids)=>{calls.push([...ids!]);return result()},record:async(_holder,ids)=>{records.push(ids)} })
  await tick('holder');await tick('holder')
  assert.equal(calls.filter(ids=>ids.includes('healthy')).length,2)
  assert.ok(records.every(ids=>!ids.includes('game')))
})

Deno.test('each import retries independently and records only its own successful checkpoint', async () => {
  const first=row(),second={...row(),id:'healthy',nba_game_id:'0022'}
  first.checkpoint_at=null;second.checkpoint_at=null
  const body=snapshot(start);body.games.push({...body.games[0],id:'0022',nbaId:'0022'})
  const records:string[][]=[]
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[first,second],snapshot:async()=>body,
    ingest:async(_holder,ids)=>ids!.has('game')?{...result(),failures:['first unavailable']}:result(),
    record:async(_holder,ids)=>{records.push(ids)} })
  await tick('holder')
  assert.deepEqual(records,[['healthy']])
})

Deno.test('route failures leave due final checks independent and healthy checkpoints bounded', async () => {
  const final={...row(),id:'final',status:'Final',needs_final_check:true}
  const calls:string[][]=[]
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[row(),final],snapshot:async()=>{throw new Error('503')},
    ingest:async(_holder,ids)=>{calls.push([...ids!]);return result()},record:async()=>{} })
  await tick('holder');assert.deepEqual(calls,[['final']])
})

Deno.test('a shared scheduled regression cannot hide stored live progress', async () => {
  let writes=0
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[row()],snapshot:async()=>snapshot(start,'Scheduled'),
    ingest:async()=>{writes++;return result()},record:async()=>{} })
  await tick('holder');assert.equal(writes,1)
})

Deno.test('public discovery includes early starts outside selected work before importing', async () => {
  let discovered=false, imports=0
  const early={...row(),id:'early',nba_game_id:'0022',checkpoint_at:null}
  const body=snapshot(start);body.games.push({...body.games[0],id:'0022',nbaId:'0022'})
  const tick=createCheckpointPoller({now:()=>start,load:async()=>discovered?[row(),early]:[row()],snapshot:async()=>body,
    ...{discover:async(value:import('../_shared/liveSnapshot.ts').LiveSnapshot)=>{assert.ok(value.games.some(game=>game.nbaId==='0022'));discovered=true}},
    ingest:async(_holder,ids)=>{assert.ok(ids!.has('early'));imports++;return result()},record:async()=>{} })
  await tick('holder');assert.equal(discovered,true);assert.equal(imports,1)
})

Deno.test('an ESPN completion signal repeats authoritative checks until official handoff', async () => {
  let writes=0
  const body={...snapshot(start),games:[{...snapshot(start).games[0],completionPending:true}]}
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[row()],snapshot:async()=>body,
    ingest:async(_holder,_ids,checkpointOnly)=>{assert.equal(checkpointOnly,false);writes++;return result()},record:async()=>{} })
  await tick('holder');await tick('holder');assert.equal(writes,2)
})

Deno.test('a successful request with no imported game cannot advance a checkpoint',async()=>{
  const game=row();game.checkpoint_at=null
  let records=0
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[game],snapshot:async()=>snapshot(start),
    ingest:async()=>({...result(),importedGameIds:[]}),record:async()=>{records++} })
  await tick('holder');assert.equal(records,0)
})

Deno.test('a public start locks a known scheduled work row before an empty direct import', async()=>{
  const game={...row(),status:'Scheduled',game_time:null,checkpoint_at:null}
  const calls:string[]=[]
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[game],snapshot:async()=>snapshot(start),
    discover:async body=>{assert.equal(body.games[0].nbaId,game.nba_game_id);calls.push('start');game.status='InProgress'},
    ingest:async()=>{calls.push('import');return {...result(),importedGameIds:[]}},
    record:async()=>assert.fail('An empty import cannot advance the checkpoint')})
  await tick('holder')
  assert.deepEqual(calls,['start','import'])
  assert.equal(game.status,'InProgress')
})

Deno.test('a public scheduled status cannot postpone overdue recovery after tipoff',async()=>{
  const game={...row(),status:'Scheduled',game_time:new Date(start-3600000).toISOString(),checkpoint_at:null}
  let writes=0
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[game],snapshot:async()=>snapshot(start,'Scheduled'),
    ingest:async()=>{writes++;return {...result(),importedGameIds:[]}},record:async()=>{}})
  await tick('holder');await tick('holder')
  assert.equal(writes,2)
})

for(const status of ['Scheduled','InProgress','Final']) Deno.test(`a stale ${status} game inside a fresh envelope cannot postpone overdue recovery`,async()=>{
  const game={...row(),status:'Scheduled',game_time:new Date(start-3600000).toISOString(),checkpoint_at:null}
  const body=snapshot(start,status);body.games[0].updatedAt=start-180000
  let writes=0
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[game],snapshot:async()=>body,
    ingest:async()=>{writes++;return result()},record:async()=>{}})
  await tick('holder')
  assert.equal(writes,1)
})

Deno.test('slow failed games rotate before later recovery work on the next tick',async()=>{
  let now=start,deadline=now+18000,healthy=0
  const games=Array.from({length:5},(_,index)=>({...row(),id:`game-${index}`,nba_game_id:`002${index}`,checkpoint_at:null}))
  const records:string[]=[]
  const tick=createCheckpointPoller({now:()=>now,load:async()=>games,snapshot:async()=>{throw new Error('503')},
    ingest:async(_holder,ids)=>{
      if(now>=deadline)throw new Error('Tick expired')
      const id=[...ids!][0]
      if(id!=='game-4'){now+=5000;throw new Error('Slow source failure')}
      healthy++;return result()
    },record:async(_holder,ids)=>{records.push(...ids)}})
  await tick('holder')
  deadline=now+18000
  await tick('holder')
  assert.equal(healthy,1)
  assert.deepEqual(records,['game-4'])
})
