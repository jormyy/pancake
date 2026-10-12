import { strict as assert } from 'node:assert'
const api = Deno.env.get('SUPABASE_URL')
assert.ok(api && ['localhost', '127.0.0.1'].includes(new URL(api).hostname))
const token = crypto.randomUUID().replaceAll('-', '')
const playerIds = [crypto.randomUUID(), crypto.randomUUID()]
const nbaIds = [1,2].map((n) => 700000000 + crypto.getRandomValues(new Uint32Array(1))[0] % 100000000 + n)
const gameId = crypto.randomUUID()
let year = 0, gameKey = '', ownsSeason = false
const jobsOwned: string[] = []
let mode: 'valid' | 'partial' | 'empty-team' | 'missing-stat' | 'provider-failure' = 'valid'
let corrected = false
const numeric = ['assists','blocks','fieldGoalsAttempted','fieldGoalsMade','foulsPersonal','freeThrowsAttempted','freeThrowsMade','plusMinusPoints','points','reboundsDefensive','reboundsOffensive','reboundsTotal','steals','threePointersAttempted','threePointersMade','turnovers']
const payload = () => {
  const players = playerIds.map((_, i) => ({ personId: nbaIds[i], name: `Synthetic ${token} ${i}`, played: '1', statistics: mode === 'partial' ? {minutes:'PT30M00.00S'} : {...Object.fromEntries(numeric.map(k=>[k,0])),minutes:'PT30M00.00S',points:corrected?30+i:20+i} }))
  if(mode === 'missing-stat') delete (players[1].statistics as any).reboundsTotal
  return {game:{gameId:gameKey,gameStatus:3,gameEt:`${year-1}-10-15T19:00:00`,homeTeam:{teamTricode:'XCH',players:[players[0]]},awayTeam:{teamTricode:'XCA',players:mode==='empty-team'?[]:[players[1]]}}}
}
const provider = Deno.serve({hostname:'127.0.0.1',port:0,onListen(){}},request=>{
  const pathname = new URL(request.url).pathname
  if (pathname !== `/liveData/boxscore/boxscore_${gameKey}.json`) {
    const expectedPrefix = `/liveData/boxscore/boxscore_${gameKey.slice(0,-4)}`
    assert.ok(pathname.startsWith(expectedPrefix))
    const candidate = Number(pathname.slice(expectedPrefix.length, -5))
    assert.ok(candidate >= 2 && candidate <= 27, 'Stop after the verified 26-candidate missing tail')
    return new Response('No such synthetic candidate', {status:404})
  }
  return mode==='provider-failure'?new Response('Synthetic provider failure',{status:503}):Response.json(payload())
})
const origin=`http://127.0.0.1:${provider.addr.port}`
Deno.env.set('NBA_CDN_BASE_URL',origin)
const nativeFetch=globalThis.fetch.bind(globalThis)
const writes:string[]=[]
globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url)
  assert.ok([api,origin].includes(url.origin),'Only isolated local services allowed')
  const result=await nativeFetch(input,init)
  if(result.ok && init && 'body' in init && typeof init.body==='string'){
    const body=JSON.parse(init.body),method='method' in init?init.method:null
    if(url.pathname==='/rest/v1/rpc/save_game_stats_atomic'&&method==='POST'&&body.p_is_final)writes.push('atomic-stats-and-marker')
    if(url.pathname==='/rest/v1/player_game_stats'&&method==='POST')writes.push('stats')
    if(url.pathname==='/rest/v1/nba_games'&&method==='PATCH'&&body.stats_synced_at)writes.push('marker')
    if(url.pathname==='/rest/v1/backfill_game_attempts'&&body.status==='completed')writes.push('completed-ledger')
  }
  return result
}
try{
 const {supabase}=await import('../../functions/_shared/supabase.ts')
 const jobs=await import('../../functions/_shared/backfillJobs.ts')
 const {runCDNChunk,runCDNEnumChunk}=await import('../../functions/_shared/cdnBackfill.ts')
 const {syncStatsGame}=await import('../../functions/_shared/syncStats.ts')
 const q=async(query:any):Promise<any>=>{const {data,error}=await query;if(error)throw Error(error.message);return data}
 try{
  for(let n=0;n<99;n++){
   const candidate=2002+n
   const [games,weeks,seasons,existingJobs]=await Promise.all([
    q(supabase.from('nba_games').select('id').eq('season_year',candidate)),
    q(supabase.from('season_weeks').select('id').eq('season_year',candidate)),
    q(supabase.from('league_seasons').select('id').eq('season_year',candidate)),
    q(supabase.from('sync_jobs').select('id').in('job_type',[`backfill_cdn_${candidate}`,`backfill_cdn-enum_${candidate}`]))])
   if(!games.length&&!weeks.length&&!seasons.length&&!existingJobs.length){year=candidate;break}
  }
  assert.ok(year,'Unused synthetic season required');ownsSeason=true
  gameKey=`002${String(year-2001).padStart(2,'0')}00001`
  await q(supabase.from('players').insert(playerIds.map((id,i)=>({id,nba_id:String(nbaIds[i]),first_name:'Synthetic',last_name:`${token} ${i}`,position:'PG' as const,eligible_positions:['PG'],nba_team:'XCH'}))))
  await q(supabase.from('nba_games').insert({id:gameId,nba_game_id:gameKey,season_year:year,week_number:1,game_date:`${year-1}-10-15`,home_team:'XCH',away_team:'XCA',status:'Final'}))
  // This box-score test owns a complete one-game fixture schedule.
  // Discovery without an authoritative calendar is covered separately.
  await q(supabase.rpc('publish_nba_schedule_atomic', {
   p_season_year:year,p_games:[],
   p_weeks:[{season_year:year,week_number:1,week_start:`${year-1}-10-15`,week_end:`${year-1}-10-15`}],
  }))
  await syncStatsGame({id:gameId,nba_game_id:gameKey,season_year:year,week_number:1,status:'Final'})
  const read=async()=>({stats:await q(supabase.from('player_game_stats').select('*').eq('game_id',gameId).order('player_id')),game:await q(supabase.from('nba_games').select('stats_synced_at').eq('id',gameId).single())})
  const initial=await read();assert.equal(initial.stats.length,2);assert.ok(initial.game.stats_synced_at)
  for(const source of ['cdn','cdn-enum'] as const){
   const jobId=await jobs.createBackfillJob(source,year);jobsOwned.push(jobId)
   const run=async(retry:boolean)=>{
    const {job,claimToken}=await jobs.claimBackfillJob(jobId,null)
    const admitted={...jobs.backfillJobAuthority(job,{}),jobId,claimToken}
    try{
     if(retry)admitted.retryBefore=await jobs.beginBackfillRetry(admitted,job.metadata)
     assert.equal(await(source==='cdn'?runCDNChunk(admitted,0):runCDNEnumChunk(admitted,0)),false)
     if(admitted.retryBefore)await jobs.endBackfillRetry(admitted)
    }finally{await jobs.releaseBackfillJob(jobId,claimToken)}
   }
   if(source==='cdn-enum')await jobs.markBackfillGameFailed(jobId,source,year,gameKey,'Synthetic retry fixture',gameId)
   for(const [index,failureMode] of (['partial','empty-team','missing-stat','provider-failure'] as const).entries()){
    const before=await read();mode=failureMode;writes.length=0
    await run(source==='cdn-enum'||index>0)
    const after=await read(),ledger=await q(supabase.from('backfill_game_attempts').select('status,last_error').eq('job_id',jobId).eq('game_key',gameKey).single())
    console.log(JSON.stringify({source,mode,pointsBefore:before.stats.map((r:any)=>r.points),pointsAfter:after.stats.map((r:any)=>r.points),markerUnchanged:before.game.stats_synced_at===after.game.stats_synced_at,ledger,writes}))
    assert.deepEqual(after.stats,before.stats,'Incomplete Final must preserve complete stored stats')
    assert.deepEqual(after.game,before.game,'Incomplete Final must preserve exact completion evidence')
    assert.equal(ledger.status,'failed');assert.deepEqual(writes,[])
   }
   // A verified complete refresh also restores the completion stamp on an incomplete prior import.
   await q(supabase.from('nba_games').update({stats_synced_at:null}).eq('id',gameId))
   mode='valid';corrected=true;writes.length=0;await run(true)
   const valid=await read();assert.deepEqual(valid.stats.map((r:any)=>r.points).sort(),[30,31]);assert.ok(valid.game.stats_synced_at)
   assert.deepEqual(writes,['atomic-stats-and-marker','completed-ledger'])
   const ledger=await q(supabase.from('backfill_game_attempts').select('status').eq('job_id',jobId).eq('game_key',gameKey).single());assert.equal(ledger.status,'completed')
   console.log(JSON.stringify({source,control:'valid-retry',points:[30,31],marker:true,writes}))
  }
 }finally{
  for(const id of jobsOwned){await q(supabase.from('backfill_game_attempts').delete().eq('job_id',id));await q(supabase.from('sync_jobs').delete().eq('id',id))}
  await q(supabase.from('player_game_stats').delete().eq('game_id',gameId));await q(supabase.from('nba_games').delete().eq('id',gameId));await q(supabase.from('players').delete().in('id',playerIds));if(ownsSeason)await q(supabase.from('season_weeks').delete().eq('season_year',year));console.log(JSON.stringify({cleanup:'complete'}))
 }
}finally{globalThis.fetch=nativeFetch;await provider.shutdown();Deno.env.delete('NBA_CDN_BASE_URL')}
