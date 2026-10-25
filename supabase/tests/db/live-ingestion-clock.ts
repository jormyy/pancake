import { strict as assert } from 'node:assert'
import { liveIngestionProvider } from './live-ingestion-provider.ts'

const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
assert.ok(['127.0.0.1','localhost'].includes(new URL(api).hostname))
assert.ok(['127.0.0.1','localhost'].includes(new URL(db).hostname))
const token = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')!
assert.ok(token)
const useEdge = Deno.env.get('LIVE_POLL_USE_EDGE') === '1'
const nativeServe = Deno.serve
const provider = useEdge ? null : nativeServe({ hostname: '127.0.0.1', port: 0, onListen() {} }, liveIngestionProvider())
const providerUrl = useEdge ? Deno.env.get('LIVE_POLL_PROVIDER_URL')! : `http://127.0.0.1:${provider!.addr.port}`
assert.ok(['127.0.0.1','localhost'].includes(new URL(providerUrl).hostname))
Deno.env.set('NBA_CDN_BASE_URL', `${providerUrl}/static/json`)
let worker: Deno.HttpServer<Deno.NetAddr> | undefined
if (!useEdge) {
  const descriptor = Object.getOwnPropertyDescriptor(Deno,'serve')!
  Object.defineProperty(Deno,'serve',{ value: (handler: Deno.ServeHandler) => {
    worker = nativeServe({ hostname:'127.0.0.1',port:0,onListen() {} },handler)
    return worker
  } })
  try { await import('../../functions/live-poll/index.ts') } finally { Object.defineProperty(Deno,'serve',descriptor) }
}
const endpoint = useEdge ? `${api}/functions/v1/live-poll` : `http://127.0.0.1:${worker!.addr.port}/live-poll`
const { supabase } = await import('../../functions/_shared/supabase.ts')
const id = crypto.randomUUID().replaceAll('-','')
const league = crypto.randomUUID(), season = crypto.randomUUID()
const members = [crypto.randomUUID(),crypto.randomUUID()]
const players = [crypto.randomUUID(),crypto.randomUUID()]
const game = crypto.randomUUID()
const users: string[] = []
const gameId = `002${String(crypto.getRandomValues(new Uint32Array(1))[0] % 100000000).padStart(8,'0')}`
const personIds = [String(900000000+crypto.getRandomValues(new Uint32Array(1))[0]),String(900000000+crypto.getRandomValues(new Uint32Array(1))[0])]
const today = new Date().toLocaleDateString('en-CA',{ timeZone:'America/New_York' })
const date = new Date(Date.parse(`${today}T12:00:00Z`)-86400000).toISOString().slice(0,10)
let year = 0
let crash: Deno.ChildProcess | null = null
const ownedHolders = new Set<string>()
const pendingRequests = new Set<Promise<Response>>()
async function query<T>(operation: PromiseLike<{ data:T; error:{ message:string } | null }>): Promise<T> {
  const { data,error }=await operation
  if(error) throw new Error(error.message)
  return data
}
async function sql(command:string) {
  const result=await new Deno.Command('psql',{ args:[db,'-XqAt','--set','ON_ERROR_STOP=1','-c',command],stdout:'piped',stderr:'piped' }).output()
  assert.equal(result.code,0,new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
async function waitFor<T>(read:()=>Promise<T>,ready:(value:T)=>boolean,timeout=15000):Promise<T> {
  const until=Date.now()+timeout
  while(Date.now()<until){ const value=await read();if(ready(value))return value;await new Promise(resolve=>setTimeout(resolve,250)) }
  throw new Error('Local ingestion observation timed out')
}
async function control(mode:string,reset=false) {
  const response=await fetch(`${providerUrl}/control${reset?'?reset=1':''}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gameId,homePersonId:Number(personIds[0]),awayPersonId:Number(personIds[1]),mode})})
  assert.equal(response.status,200);await response.text()
}
type ProviderState={requests:{kind:string;at:number;mode:string;counter:number}[]}
async function providerState():Promise<ProviderState>{return await(await fetch(`${providerUrl}/state`)).json()}
function poll(){
  const pending=fetch(endpoint,{method:'POST',headers:{'x-internal-function-token':token},signal:AbortSignal.timeout(145000)})
  pendingRequests.add(pending)
  pending.then(()=>pendingRequests.delete(pending),()=>pendingRequests.delete(pending))
  return pending
}
async function homePoints(){const rows=await query(supabase.from('matchups').select('home_points').eq('league_season_id',season));return Number(rows?.[0]?.home_points??0)}
try {
  assert.equal(await sql('SELECT count(*) FROM live_poll_leases WHERE lock_key=779001'),'0','no preexisting live worker')
  for(let attempt=0;attempt<50;attempt++){
    const candidate=10000+crypto.getRandomValues(new Uint32Array(1))[0]%100000
    if(!(await query(supabase.from('season_weeks').select('id').eq('season_year',candidate)))?.length){year=candidate;break}
  }
  assert.ok(year)
  for(let side=0;side<2;side++){
    const {data,error}=await supabase.auth.admin.createUser({email:`live-clock-${id}-${side}@example.test`,password:`Synthetic-${crypto.randomUUID()}!`,email_confirm:true,user_metadata:{username:`live_${id.slice(0,16)}_${side}`}})
    if(error)throw error;assert.ok(data.user);users.push(data.user.id)
  }
  await query(supabase.from('leagues').insert({id:league,slug:`live-${id}`,name:'Owned live clock',commissioner_id:users[0],status:'active'}))
  await query(supabase.from('league_seasons').insert({id:season,league_id:league,season_year:year,is_current:true}))
  await query(supabase.from('league_members').insert(users.map((user_id,side)=>({id:members[side],league_id:league,user_id,team_name:`Live ${side}`,role:side?'manager' as const:'commissioner' as const}))))
  await query(supabase.from('season_weeks').insert({season_year:year,week_number:1,week_start:date,week_end:date}))
  await query(supabase.from('players').insert(players.map((id,side)=>({id,nba_id:personIds[side],first_name:'Live',last_name:side?'Away':'Home',position:'PG' as const,eligible_positions:['PG'],nba_team:side?'MIA':'BOS'}))))
  await query(supabase.from('roster_players').insert(players.map((player_id,side)=>({league_id:league,league_season_id:season,member_id:members[side],player_id,acquired_via:'draft'}))))
  await query(supabase.from('nba_games').insert({id:game,nba_game_id:gameId,season_year:year,week_number:1,game_date:date,home_team:'BOS',away_team:'MIA',status:'Scheduled',game_time:new Date(Date.now()+3600000).toISOString()}))
  await query(supabase.from('weekly_lineups').insert(players.map((player_id,side)=>({league_id:league,member_id:members[side],league_season_id:season,player_id,week_number:1,game_date:date,slot_type:'PG' as const,is_auto_set:false}))))
  await query(supabase.from('matchups').insert({league_id:league,league_season_id:season,week_number:1,home_member_id:members[0],away_member_id:members[1],matchup_type:'regular_season'}))
  await query(supabase.from('nba_games').update({status:'InProgress',game_time:new Date(Date.now()-3600000).toISOString()}).eq('id',game))
  await control('active',true)
  const first=poll()
  await waitFor(homePoints,value=>value>=11)
  ownedHolders.add(await sql('SELECT holder_id FROM live_poll_leases WHERE lock_key=779001'))
  const duplicate=await poll();assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).action,'lease-skip')
  const response=await first;assert.equal(response.status,200)
  const result=await response.json()
  assert.equal(result.ticks,6)
  assert.ok(result.elapsedMs>=99000 && result.elapsedMs<130000,JSON.stringify(result))
  assert.equal(result.statLines,12)
  const state=await providerState()
  const ticks=state.requests.filter(row=>row.kind==='scoreboard')
  assert.equal(ticks.length,6)
  for(let index=1;index<ticks.length;index++)assert.ok(ticks[index].at-ticks[index-1].at>=18000 && ticks[index].at-ticks[index-1].at<=24000)
  assert.equal(state.requests.filter(row=>row.kind==='boxscore').length,6)
  assert.equal(await homePoints(),16)
  assert.equal((await query(supabase.from('matchups').select('is_finalized').eq('league_season_id',season).single()))?.is_finalized,false)
  assert.equal((await sql(`SELECT count(*) FROM live_poll_leases WHERE lock_key=779001`)),'0')
  console.log(JSON.stringify({case:'real 20-second ingestion',runtime:useEdge?'Supabase Edge':'Deno HTTP + local Supabase',result,gapsMs:ticks.slice(1).map((row,index)=>row.at-ticks[index].at),homePoints:await homePoints()}))

  const prior=(await providerState()).requests.length
  crash=new Deno.Command('deno',{args:['run','--no-lock','--allow-env','--allow-read','--allow-net=127.0.0.1,localhost','supabase/tests/db/live-ingestion-crash-worker.ts'],env:{NBA_CDN_BASE_URL:`${providerUrl}/static/json`},stdout:'null',stderr:'piped'}).spawn()
  await waitFor(providerState,state=>state.requests.length>=prior+2)
  ownedHolders.add(await sql('SELECT holder_id FROM live_poll_leases WHERE lock_key=779001'))
  const expires=await sql('SELECT expires_at FROM live_poll_leases WHERE lock_key=779001')
  assert.ok(expires)
  crash.kill('SIGTERM');const crashed=await crash.status;assert.notEqual(crashed.code,0);crash=null
  const blocked=await poll();assert.equal((await blocked.json()).action,'lease-skip')
  const waiting=Date.now()
  await waitFor(async()=>Date.now(),now=>now>Date.parse(expires)+100,100000)
  assert.ok(Date.now()-waiting>=80000,'production 90-second TTL expires on the wall clock')
  await control('final')
  const recovered=await poll();assert.equal(recovered.status,200)
  const recoveredBody=await recovered.json();assert.equal(recoveredBody.ticks,1)
  const final=await query(supabase.from('matchups').select('is_finalized,winner_member_id,home_points,away_points').eq('league_season_id',season).single())
  assert.equal(final?.is_finalized,true);assert.equal(final?.winner_member_id,members[0])
  const standing=await query(supabase.from('standings').select('wins,losses,ties').eq('league_season_id',season).eq('member_id',members[0]).eq('week_number',1).single())
  assert.equal(standing?.wins,1);assert.equal(standing?.ties,0)
  console.log(JSON.stringify({case:'killed worker expires naturally then finalizes',crashExit:crashed.code,waitedMs:Date.now()-waiting,recovered:recoveredBody,final,standing}))

  await control('active',true)
  await query(supabase.from('nba_games').update({status:'InProgress',stats_synced_at:null}).eq('id',game))
  const lost=poll()
  await waitFor(providerState,state=>state.requests.some(row=>row.kind==='boxscore'))
  const lostHolder=await sql('SELECT holder_id FROM live_poll_leases WHERE lock_key=779001')
  ownedHolders.add(lostHolder)
  const replacement=await sql(`UPDATE live_poll_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE lock_key=779001 AND holder_id='${lostHolder}'; SELECT try_live_poll_lease(779001,90)`)
  assert.match(replacement,/^[0-9a-f-]{36}$/)
  ownedHolders.add(replacement)
  const beforeLoss=await query(supabase.from('player_game_stats').select('player_id,points,updated_at').eq('game_id',game).order('player_id'))
  const lostResponse=await lost
  assert.equal(lostResponse.status,500)
  const lostBody=await lostResponse.json()
  assert.match(lostBody.failures.join(';'),/lease/i)
  assert.deepEqual(await query(supabase.from('player_game_stats').select('player_id,points,updated_at').eq('game_id',game).order('player_id')),beforeLoss)
  assert.equal((await(await poll()).json()).action,'lease-skip')
  await sql(`SELECT release_live_poll_lease(779001,'${replacement}')`)
  console.log(JSON.stringify({case:'replaced live holder stops without stale writes',lostBody}))

  await query(supabase.from('nba_games').update({status:'Final',stats_synced_at:null}).eq('id',game))
  await sql(`DELETE FROM private.live_poll_game_state WHERE game_id='${game}'`)
  await control('box-stall',true)
  const stalledAt=Date.now()
  const stalled=await poll()
  assert.equal(stalled.status,500)
  const stalledBody=await stalled.json()
  const stalledMs=Date.now()-stalledAt
  assert.ok(stalledMs>=17500 && stalledMs<25000,JSON.stringify({stalledMs,stalledBody}))
  assert.equal((await providerState()).requests.filter(row=>row.kind==='boxscore').length,1)
  console.log(JSON.stringify({case:'stalled provider body obeys real eighteen-second tick deadline',stalledMs,stalledBody}))

  await control('box-fail',true)
  await query(supabase.from('nba_games').update({stats_synced_at:null}).eq('id',game))
  await sql(`DELETE FROM private.live_poll_game_state WHERE game_id='${game}'`)
  const failure=await poll();assert.equal(failure.status,500);const failedBody=await failure.json()
  const failedState=await providerState()
  assert.equal(failedState.requests.filter(row=>row.kind==='boxscore').length,2)
  const idle=await poll();assert.equal(idle.status,200);assert.equal((await idle.json()).ticks,0)
  assert.equal((await providerState()).requests.length,failedState.requests.length)
  assert.equal((await query(supabase.from('standings').select('ties').eq('league_season_id',season).eq('member_id',members[0]).eq('week_number',1).single()))?.ties,0)
  console.log(JSON.stringify({case:'real final failure backs off without another box-score request',failedBody,requests:failedState.requests.length}))
} finally {
  if(crash){crash.kill('SIGTERM');await crash.status}
  await Promise.allSettled([...pendingRequests])
  if(worker)await worker.shutdown()
  if(provider)await provider.shutdown()
  for(const holder of ownedHolders){
    assert.match(holder,/^[0-9a-f-]{36}$/)
    await sql(`DELETE FROM public.live_poll_leases WHERE lock_key=779001 AND holder_id='${holder}'` )
  }
  await query(supabase.from('player_game_stats').delete().eq('game_id',game))
  await query(supabase.from('nba_games').delete().eq('id',game))
  await query(supabase.from('leagues').delete().eq('id',league))
  await query(supabase.from('season_weeks').delete().eq('season_year',year))
  await query(supabase.from('players').delete().in('id',players))
  for(const user of users){const {error}=await supabase.auth.admin.deleteUser(user);if(error)throw error}
  console.log(JSON.stringify({cleanup:'owned live-ingestion fixture removed'}))
}
