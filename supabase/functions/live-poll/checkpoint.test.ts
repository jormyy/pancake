import assert from 'node:assert/strict'
import { createCheckpointPoller, CHECKPOINT_INTERVAL_MS } from './checkpoint.ts'
import type { CheckpointGame, LiveTick } from './checkpoint.ts'

const start=Date.parse('2026-10-31T23:00:00Z')
const date='2026-10-31'
const row=(id='game'):CheckpointGame=>({id,nba_game_id:`002-${id}`,game_date:date,status:'InProgress',game_time:null,
  home_team:'BOS',away_team:'NYK',checkpoint_at:new Date(start).toISOString(),checked_at:null,home_score:0,away_score:0,needs_final_check:false} as CheckpointGame)
const result=(id='game'):LiveTick=>({lines:24,keepRunning:true,worked:true,failures:[],scoreRetries:0,tickRetries:0,importedGameIds:[id]})
const snapshot=(now:number,status='InProgress',mode='public')=>({version:1,mode,date,capturedAt:now,
  games:mode==='database'?[]:[{id:'002-game',nbaId:'002-game',espnId:null,status,updatedAt:now,
    home:{team:'BOS',score:0,players:[]},away:{team:'NYK',score:0,players:[]}}]})

Deno.test('shared ticks write only at the thirty-minute checkpoint',async()=>{
  let now=start,writes=0,records=0
  const game=row()
  const tick=createCheckpointPoller({now:()=>now,load:async()=>[game],snapshot:async()=>snapshot(now),
    ingest:async(_holder,ids,checkpointOnly)=>{assert.deepEqual([...ids!],['game']);assert.equal(checkpointOnly,true);writes++;return result()},
    record:async()=>{records++;game.checkpoint_at=new Date(now).toISOString()}})
  assert.equal(CHECKPOINT_INTERVAL_MS,1800000)
  for(let elapsed=0;elapsed<CHECKPOINT_INTERVAL_MS;elapsed+=30000){now=start+elapsed;await tick('holder')}
  assert.equal(writes,0)
  now=start+CHECKPOINT_INTERVAL_MS;await tick('holder')
  assert.equal(writes,1);assert.equal(records,1)
})

Deno.test('a public early start records its receipt before selected direct ingestion',async()=>{
  const game={...row(),status:'Scheduled',game_time:new Date(start+3600000).toISOString(),checkpoint_at:null}
  const calls:string[]=[]
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[game],snapshot:async()=>snapshot(start),
    attempt:async(_holder,id)=>{assert.equal(id,game.id);calls.push('attempt')},
    start:async()=>{calls.push('start')},
    ingest:async(_holder,ids)=>{assert.deepEqual([...ids!],[game.id]);calls.push('import');return {...result(),importedGameIds:[]}},
    record:async()=>assert.fail('A missing direct import cannot advance a checkpoint')})
  await tick('holder');assert.deepEqual(calls,['attempt','start','import'])
})

Deno.test('the off switch restores unfiltered database ingestion',async()=>{
  let writes=0
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[row()],snapshot:async()=>snapshot(start,'InProgress','database'),
    ingest:async(_holder,ids)=>{assert.equal(ids,undefined);writes++;return result()},record:async()=>assert.fail()})
  await tick('holder');await tick('holder');assert.equal(writes,2)
})

Deno.test('each failed import is isolated and never advances its checkpoint',async()=>{
  const games=[{...row('first'),checkpoint_at:null},{...row('second'),checkpoint_at:null}]
  const records:string[]=[]
  const tick=createCheckpointPoller({now:()=>start,load:async()=>games,snapshot:async()=>{throw new Error('503')},
    ingest:async(_holder,ids)=>ids!.has('first')?{...result('first'),failures:['unavailable']}:result('second'),
    record:async(_holder,ids)=>{records.push(...ids)}})
  const output=await tick('holder')
  assert.deepEqual(records,['second']);assert.deepEqual(output.failures,['unavailable'])
})

Deno.test('route failure does not block due finals or overdue checkpoints',async()=>{
  const calls:string[]=[]
  const games=[row(),{...row('overdue'),checkpoint_at:null},{...row('final'),status:'Final',needs_final_check:true}]
  const tick=createCheckpointPoller({now:()=>start,load:async()=>games,snapshot:async()=>{throw new Error('503')},
    ingest:async(_holder,ids)=>{const id=[...ids!][0];calls.push(id);return result(id)},record:async()=>{}})
  await tick('holder');assert.deepEqual(calls,['overdue','final'])
})

for(const stale of [false,true])Deno.test(`scheduled work recovers after tipoff with a ${stale?'stale':'scheduled'} public row`,async()=>{
  let imports=0
  const game={...row(),status:'Scheduled',game_time:new Date(start-3600000).toISOString(),checkpoint_at:null}
  const body=snapshot(start,'Scheduled');if(stale)body.games[0].updatedAt-=180000
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[game],snapshot:async()=>body,
    ingest:async()=>{imports++;return result()},record:async()=>{}})
  await tick('holder');assert.equal(imports,1)
})

Deno.test('ESPN completion keeps requesting authoritative final checks',async()=>{
  let imports=0
  const body={...snapshot(start),games:snapshot(start).games.map(game=>({...game,completionPending:true}))}
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[row()],snapshot:async()=>body,
    ingest:async()=>{imports++;return result()},record:async()=>{}})
  await tick('holder');await tick('holder');assert.equal(imports,2)
})

Deno.test('future scheduled work stays idle without a verified start',async()=>{
  let imports=0
  const game={...row(),status:'Scheduled',game_time:new Date(start+3600000).toISOString(),checkpoint_at:null}
  const tick=createCheckpointPoller({now:()=>start,load:async()=>[game],snapshot:async()=>snapshot(start,'Scheduled'),
    ingest:async()=>{imports++;return result()},record:async()=>{}})
  assert.equal((await tick('holder')).keepRunning,false);assert.equal(imports,0)
})

Deno.test('expired provider work retains fair order through the real work context',async()=>{
  const {withWorkContext,workFetch}=await import('../_shared/workContext.ts')
  const original=globalThis.fetch
  let now=start,healthy=0,controller=new AbortController()
  const attempted=new Map<string,number>()
  const games=Array.from({length:6},(_,index)=>({...row(`game-${index}`),checkpoint_at:null}))
  globalThis.fetch=()=>Promise.resolve(Response.json({ok:true}))
  const attempt=async(_holder:string,id:string)=>{await workFetch('http://database.invalid/attempt');attempted.set(id,now)}
  const dependencies={now:()=>now,load:async()=>[...games].sort((a,b)=>(attempted.get(a.id)??0)-(attempted.get(b.id)??0)),
    snapshot:async()=>{throw new Error('503')},attempt,
    ingest:async(_holder:string,ids?:ReadonlySet<string>)=>{
      const id=[...ids!][0]
      if(id!=='game-5'){now+=18000;controller.abort();throw new Error('Provider deadline')}
      healthy++;return result(id)
    },record:async()=>{}}
  try {
    for(let worker=0;worker<3;worker++) {
      const tick=createCheckpointPoller(dependencies)
      for(let number=0;number<4;number++) {
        controller=new AbortController()
        await withWorkContext({signal:controller.signal},()=>tick('holder'))
        now+=30000
      }
    }
    assert.ok(healthy>0)
    assert.ok(attempted.size===6)
  }finally {globalThis.fetch=original}
})
