import assert from 'node:assert/strict'

Deno.env.set('SUPABASE_URL', 'http://database.invalid')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'fixture-key')
Deno.env.set('NBA_CDN_BASE_URL', 'http://nba.invalid')
Deno.env.set('ESPN_LIVE_BASE_URL', 'http://espn.invalid')
const { ingestTick, runLivePoll } = await import('./runner.ts')

const lockTimeout = { code: '55P03', message: 'canceling statement due to lock timeout' }
const holder = '00000000-0000-4000-8000-000000000001'

async function withDatabase(run: (calls: string[]) => Promise<void>, respond: (name: string, count: number) => Response) {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const name = url.pathname.split('/').at(-1)!
    calls.push(name)
    assert.ok(['database.invalid', 'nba.invalid', 'espn.invalid'].includes(url.hostname))
    if (url.hostname === 'espn.invalid') return Promise.resolve(Response.json({ events: [] }))
    if (name === 'try_live_poll_lease') return Promise.resolve(Response.json(holder))
    if (name === 'release_live_poll_lease') return Promise.resolve(Response.json(null))
    if (name === 'sync_runs') return Promise.resolve(Response.json({ id: holder }))
    return Promise.resolve(respond(name, calls.filter(value => value === name).length))
  }
  try { await run(calls) } finally { globalThis.fetch = original }
}

Deno.test('the live loop recovers a lock timeout without retaining a failed tick', async () => {
  await withDatabase(async calls => {
    const response = await runLivePoll(new Request('http://function.invalid'))
    const result = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(result.failures, [])
    assert.equal(result.tickRetries, 1)
    assert.equal(calls.filter(name => name === 'get_live_poll_work').length, 2)
  }, (name, count) => {
    assert.equal(name, 'get_live_poll_work')
    return count === 1 ? Response.json(lockTimeout, { status: 500 }) : Response.json([])
  })
})

Deno.test('a permanent tick error receives no retry', async () => {
  await withDatabase(async calls => {
    await assert.rejects(() => ingestTick(holder), error => (error as { code: string }).code === '23514')
    assert.equal(calls.length, 1)
  }, () => Response.json({ code: '23514', message: 'invalid game' }, { status: 500 }))
})

Deno.test('persistent tick contention remains a failure after five attempts', async () => {
  let retries = 0
  await withDatabase(async calls => {
    await assert.rejects(() => ingestTick(holder, () => { retries++ }), error => (error as { code: string }).code === '55P03')
    assert.equal(calls.length, 5)
    assert.equal(retries, 4)
  }, () => Response.json(lockTimeout, { status: 500 }))
})

Deno.test('scoreboard writes retry without fetching the provider again', async () => {
  await withDatabase(async calls => {
    const result = await ingestTick(holder)
    assert.deepEqual(result.failures, [])
    assert.equal(result.tickRetries, 1)
    assert.equal(calls.filter(name => name === 'todaysScoreboard_00.json').length, 1)
    assert.equal(calls.filter(name => name === 'save_live_scoreboard_atomic').length, 2)
  }, (name, count) => {
    if (name === 'get_live_poll_work') return Response.json(count === 1 ? [{
      id: holder, nba_game_id: '0022600001', status: 'InProgress', needs_scoreboard: true, needs_stats: false,
      home_score: 0, away_score: 0, game_status_text: 'Q1',
    }] : [])
    if (name === 'record_live_poll_attempts') return Response.json(null)
    if (name === 'todaysScoreboard_00.json') return Response.json({ scoreboard: { games: [{
      gameId: '0022600001', gameStatus: 2, gameStatusText: 'Q1', period: 1, gameClock: 'PT06M00.00S',
      homeTeam: { score: 10 }, awayTeam: { score: 8 },
    }] } })
    assert.equal(name, 'save_live_scoreboard_atomic')
    return count === 1 ? Response.json(lockTimeout, { status: 500 }) : Response.json(true)
  })
})

Deno.test('ESPN starts a scheduled game even when both NBA endpoints fail', async () => {
  const original = globalThis.fetch
  const board = JSON.parse(await Deno.readTextFile('tests/fixtures/live-espn/2026-10-30T01-00-49.445Z-scoreboard.json')).payload
  board.events = board.events.filter((event: { id: string }) => event.id === '401909893')
  const summary = JSON.parse(await Deno.readTextFile('tests/fixtures/live-espn/2026-10-30T01-00-49.554Z-summary-401909893.json')).payload
  const athleteIds: string[] = summary.boxscore.players.flatMap((team: { statistics: { athletes: { athlete: { id: string }; didNotPlay: boolean }[] }[] }) => team.statistics[0].athletes.map(row => row.athlete.id))
  let scoreboardCalls = 0, summaryCalls = 0, writes = 0, starts = 0
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    assert.ok(['database.invalid', 'nba.invalid', 'espn.invalid'].includes(url.hostname))
    const name = url.pathname.split('/').at(-1)
    if (url.hostname === 'espn.invalid') {
      if (name === 'scoreboard') { scoreboardCalls++; return Response.json(board) }
      summaryCalls++
      return Response.json(summary)
    }
    if (url.hostname === 'nba.invalid') return Response.json({}, { status: 403 })
    if (name === 'sync_runs') return Response.json({ id: holder })
    if (name === 'get_live_poll_work') return Response.json([{
      id: holder, nba_game_id: '0022600144', status: 'Scheduled', game_date: '2026-10-29', home_team: 'ATL', away_team: 'CLE', season_year: 2027, week_number: 2,
      needs_scoreboard: true, needs_stats: false,
    }])
    if (name === 'record_live_poll_attempts' || name === 'assert_nba_game_unambiguous') return Response.json(null)
    if (name === 'players') return Response.json(athleteIds.map((id, index) => ({ id: `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`, espn_id: id, nba_id: String(index + 100) })))
    if (name === 'league_seasons') return Response.json([])
    if (name === 'save_live_scoreboard_atomic') {
      assert.equal((await request.json()).p_status,'InProgress')
      starts++;return Response.json(true)
    }
    assert.equal(name, 'save_live_feed_snapshot_atomic')
    const body = await request.json()
    assert.equal(body.p_snapshot.source, 'espn')
    assert.equal(body.p_snapshot.status, 'InProgress')
    assert.equal(body.p_provider_game_id, '0022600144')
    writes++
    return Response.json(athleteIds.length)
  }
  try {
    const tick = await ingestTick(holder)
    assert.deepEqual(tick.failures, [])
    assert.equal(tick.lines, athleteIds.length)
    assert.equal(writes, 1)
    assert.equal(starts, 1)
    assert.equal(scoreboardCalls, 1)
    assert.equal(summaryCalls, 1)
  } finally { globalThis.fetch = original }
})

Deno.test('a final stat write retries its captured game after the attempt stamp', async () => {
  await withDatabase(async calls => {
    const result = await ingestTick(holder)
    assert.deepEqual(result.failures, [])
    assert.equal(result.lines, 2)
    assert.equal(result.tickRetries, 1)
    assert.equal(result.keepRunning, false)
    assert.equal(calls.filter(name => name === 'record_live_poll_attempts').length, 1)
    assert.equal(calls.filter(name => name === 'get_live_poll_work').length, 1)
    assert.equal(calls.filter(name => name === 'save_game_stats_atomic').length, 2)
  }, (name, count) => {
    if (name === 'get_live_poll_work') return Response.json([{
      id: holder, nba_game_id: '0022600001', status: 'Final', needs_scoreboard: false, needs_stats: true, home_score:10,away_score:10,game_status_text:'Final',
      season_year: 2027, week_number: 1,
    }])
    if (name === 'record_live_poll_attempts' || name === 'assert_nba_game_unambiguous') return Response.json(null)
    if (name === 'league_seasons') return Response.json([])
    if (name === 'boxscore_0022600001.json') {
      const statistics = Object.fromEntries([
        'assists', 'blocks', 'fieldGoalsAttempted', 'fieldGoalsMade', 'foulsPersonal',
        'freeThrowsAttempted', 'freeThrowsMade', 'plusMinusPoints', 'points',
        'reboundsDefensive', 'reboundsOffensive', 'reboundsTotal', 'steals',
        'threePointersAttempted', 'threePointersMade', 'turnovers',
      ].map(key => [key, 0]))
      const team = (personId: number) => ({ score:10, players: [{ personId, name: 'Player ' + personId,
        statistics: { ...statistics, points: 10, minutes: 'PT06M00.00S' } }] })
      return Response.json({ game: { gameStatus: 3, homeTeam: team(1), awayTeam: team(2) } })
    }
    if (name === 'resolve_player_imports_atomic') return Response.json({ stale_draft_numbers_cleared: 0,
      results: [1, 2].map((id, index) => ({ index, player_id: 'player-' + id, action: 'updated' })) })
    assert.equal(name, 'save_game_stats_atomic')
    return count === 1 ? Response.json(lockTimeout, { status: 500 }) : Response.json(2)
  })
})

Deno.test('a scheduled game with a Final NBA scoreboard still requests its box after the scoreboard attempt', async () => {
  await withDatabase(async calls => {
    const result = await ingestTick(holder)
    assert.equal(calls.filter(name => name === 'boxscore_0022600001.json').length, 1)
    assert.equal(calls.filter(name => name === 'save_live_scoreboard_atomic').length, 0)
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0], /0022600001.*403/)
  }, (name, count) => {
    if (name === 'get_live_poll_work') return Response.json(count === 1 ? [{
      id: holder, nba_game_id: '0022600001', status: 'Scheduled', needs_scoreboard: true, needs_stats: false,
      game_date: '2026-10-29', season_year: 2027, home_team: 'ATL', away_team: 'CLE',
    }] : [])
    if (name === 'record_live_poll_attempts') return Response.json(null)
    if (name === 'todaysScoreboard_00.json') return Response.json({ scoreboard: { games: [{
      gameId: '0022600001', gameStatus: 3, gameStatusText: 'Final',
      homeTeam: { score: 100 }, awayTeam: { score: 98 },
    }] } })
    if (name === 'boxscore_0022600001.json') return Response.json({}, { status: 403 })
    assert.equal(name, 'league_seasons')
    return Response.json([])
  })
})

Deno.test('checkpoint reads request only the selected games and retain retries', async () => {
  const original=globalThis.fetch
  const requests: { name: string; body: unknown }[]=[]
  globalThis.fetch=async(input,init)=>{
    const request=new Request(input,init)
    const name=new URL(request.url).pathname.split('/').at(-1)!
    requests.push({name,body:await request.json()})
    assert.equal(name,'get_live_checkpoint_inputs')
    return requests.length===1 ? Response.json(lockTimeout,{status:500}) : Response.json([])
  }
  try {
    const result=await ingestTick(holder,undefined,new Set([holder]))
    assert.equal(result.worked,false)
    assert.equal(result.tickRetries,1)
    assert.deepEqual(requests.map(row=>row.body),[{p_game_ids:[holder]},{p_game_ids:[holder]}])
  }finally {globalThis.fetch=original}
})

Deno.test('an unrelated malformed scoreboard still permits selected box recovery',async()=>{
  await withDatabase(async calls=>{
    const result=await ingestTick(holder,undefined,new Set([holder]))
    assert.equal(calls.filter(name=>name==='boxscore_0022600001.json').length,1)
    assert.equal(result.failures.length,1)
    assert.ok(result.failures.some(failure=>/0022600001.*403/.test(failure)))
  },name=>{
    if(name==='get_live_checkpoint_inputs')return Response.json([{
      id:holder,nba_game_id:'0022600001',status:'InProgress',needs_scoreboard:true,needs_stats:true,
      game_date:'2026-10-29',season_year:2027,home_team:'ATL',away_team:'CLE',
    }])
    if(name==='record_live_poll_attempts')return Response.json(null)
    if(name==='todaysScoreboard_00.json')return Response.json({scoreboard:{games:[{
      gameId:'0022600002',gameStatus:2,gameStatusText:'Q1',period:1,gameClock:'broken',
      homeTeam:{teamTricode:'BOS',score:2},awayTeam:{teamTricode:'NYK',score:0},
    }]}})
    if(name==='nba_games')return Response.json([{id:'other',nba_game_id:'0022600002',status:'Scheduled',home_score:0,away_score:0,game_status_text:'Scheduled'}])
    if(name==='boxscore_0022600001.json')return Response.json({},{status:403})
    assert.equal(name,'league_seasons');return Response.json([])
  })
})

Deno.test('a selected official import never expands to an unrelated ESPN game',async()=>{
  const original=globalThis.fetch
  const board=JSON.parse(await Deno.readTextFile('tests/fixtures/live-espn/2026-10-30T01-00-49.445Z-scoreboard.json')).payload
  board.events=board.events.filter((event:{id:string})=>event.id==='401909893')
  const selected={id:holder,nba_game_id:'0022600001',status:'InProgress',needs_scoreboard:true,needs_stats:true,
    game_date:'2026-10-29',season_year:2027,week_number:2,home_team:'BOS',away_team:'NYK'}
  let unrelated=0
  const starts:string[]=[]
  globalThis.fetch=async(input,init)=>{
    const request=new Request(input,init);const url=new URL(request.url);const name=url.pathname.split('/').at(-1)!
    if(url.hostname==='espn.invalid')return url.pathname.endsWith('scoreboard')?Response.json(board):Response.json({},{status:503})
    if(name==='todaysScoreboard_00.json')return Response.json({scoreboard:{games:[{gameId:'0022600144',gameStatus:1,gameStatusText:'Scheduled',period:0,gameClock:'PT00M00S',homeTeam:{teamTricode:'ATL',score:0},awayTeam:{teamTricode:'CLE',score:0}}]}})
    if(name==='boxscore_0022600144.json'){unrelated++;return Response.json({},{status:403})}
    if(name==='boxscore_0022600001.json') {
      const statistics=Object.fromEntries(['assists','blocks','fieldGoalsAttempted','fieldGoalsMade','foulsPersonal','freeThrowsAttempted','freeThrowsMade','plusMinusPoints','points','reboundsDefensive','reboundsOffensive','reboundsTotal','steals','threePointersAttempted','threePointersMade','turnovers'].map(key=>[key,0]))
      const side=(personId:number,teamTricode:string)=>({teamTricode,score:0,players:[{personId,name:'Fixture',played:0,statistics:{...statistics,minutes:'PT0M00S'}}]})
      return Response.json({meta:{time:'2026-10-30T01:00:00Z'},game:{gameId:selected.nba_game_id,gameStatus:3,homeTeam:side(1,'BOS'),awayTeam:side(2,'NYK')}})
    }
    if(name==='get_live_checkpoint_inputs')return Response.json([selected])
    if(name==='nba_games')return Response.json([{...selected,id:'unrelated',nba_game_id:'0022600144',status:'Scheduled',home_team:'ATL',away_team:'CLE'}])
    if(name==='resolve_player_imports_atomic')return Response.json({stale_draft_numbers_cleared:0,results:[1,2].map((value,index)=>({index,player_id:`player-${value}`,action:'updated'}))})
    if(name==='league_seasons')return Response.json([])
    if(name==='save_live_scoreboard_atomic')starts.push((await request.json()).p_game_id)
    return Response.json(name==='save_final_game_snapshot_atomic'?2:null)
  }
  try {
    const result=await ingestTick(holder,undefined,new Set([holder]))
    assert.equal(unrelated,0)
    assert.deepEqual(starts,['unrelated'])
    assert.deepEqual(result.importedGameIds,[holder])
    assert.deepEqual(result.failures,[])
  }finally {globalThis.fetch=original}
})

Deno.test('selected recovery records every NBA start before filtering imports',async()=>{
  const original=globalThis.fetch
  const writes:string[]=[]
  let loads=0
  globalThis.fetch=async(input,init)=>{
    const request=new Request(input,init)
    const url=new URL(request.url),name=url.pathname.split('/').at(-1)
    if(url.hostname==='espn.invalid')return Response.json({events:[]})
    if(url.hostname==='nba.invalid')return Response.json({scoreboard:{games:['0022600001','0022600002'].map(gameId=>({
      gameId,gameStatus:2,gameStatusText:'Q1',period:1,gameClock:'PT10M00S',
      homeTeam:{teamTricode:'BOS',score:0},awayTeam:{teamTricode:'NYK',score:0},
    }))}})
    if(name==='get_live_checkpoint_inputs')return Response.json(++loads===1?[{
      id:holder,nba_game_id:'0022600001',status:'InProgress',needs_scoreboard:true,needs_stats:false,
      home_score:0,away_score:0,game_status_text:'Q1',game_date:'2026-10-29',season_year:2027,
    }]:[])
    if(name==='record_live_poll_attempts')return Response.json(null)
    if(name==='nba_games')return Response.json([{id:'early',nba_game_id:'0022600002',status:'Scheduled',home_score:0,away_score:0,game_status_text:'Scheduled'}])
    if(name==='save_live_scoreboard_atomic'){writes.push((await request.json()).p_game_id);return Response.json(true)}
    throw new Error(`Unexpected ${url}`)
  }
  try {
    const tick=await ingestTick(holder,undefined,new Set([holder]))
    assert.deepEqual(tick.failures,[])
    assert.deepEqual(writes,['early'])
  }finally {globalThis.fetch=original}
})

Deno.test('NBA start receipts survive an unrelated ESPN discovery failure',async()=>{
  const original=globalThis.fetch
  const board=JSON.parse(await Deno.readTextFile('tests/fixtures/live-espn/2026-10-30T01-00-49.445Z-scoreboard.json')).payload
  board.events=board.events.filter((event:{id:string})=>event.id==='401909893')
  const writes:string[]=[]
  let loads=0
  globalThis.fetch=async(input,init)=>{
    const request=new Request(input,init);const url=new URL(request.url),name=url.pathname.split('/').at(-1)
    if(url.hostname==='espn.invalid')return Response.json(board)
    if(url.hostname==='nba.invalid')return Response.json({scoreboard:{games:[{gameId:'0022600002',gameStatus:2,gameStatusText:'Q1',period:1,gameClock:'PT10M00S',homeTeam:{teamTricode:'BOS',score:0},awayTeam:{teamTricode:'NYK',score:0}}]}})
    if(name==='get_live_checkpoint_inputs')return Response.json(++loads===1?[{id:holder,nba_game_id:'0022600001',status:'InProgress',needs_scoreboard:true,needs_stats:false,game_date:'2026-10-29',home_team:'UTA',away_team:'LAC'}]:[])
    if(name==='record_live_poll_attempts')return Response.json(null)
    if(name==='nba_games')return url.searchParams.has('game_date')?Response.json({message:'Discovery unavailable'},{status:503}):Response.json([{id:'early',nba_game_id:'0022600002',status:'Scheduled',home_score:0,away_score:0,game_status_text:'Scheduled'}])
    if(name==='save_live_scoreboard_atomic'){writes.push((await request.json()).p_game_id);return Response.json(true)}
    throw new Error(`Unexpected ${url}`)
  }
  try {await ingestTick(holder,undefined,new Set([holder]));assert.deepEqual(writes,['early'])}
  finally {globalThis.fetch=original}
})

Deno.test('start receipts have independent deadlines, bounded concurrency and rotating retries',async()=>{
  const {withWorkContext}=await import('../_shared/workContext.ts')
  const original=globalThis.fetch
  const orders:string[][]=[]
  let active=0,maximum=0,loads=0
  globalThis.fetch=async(input,init)=>{
    const request=new Request(input,init),url=new URL(request.url),name=url.pathname.split('/').at(-1)
    if(url.hostname==='espn.invalid')return Response.json({events:[]})
    if(url.hostname==='nba.invalid')return Response.json({scoreboard:{games:[1,2,3].map(n=>({gameId:`002260000${n}`,gameStatus:2,gameStatusText:'Q1',period:1,gameClock:'PT10M00S',homeTeam:{score:0},awayTeam:{score:0}}))}})
    if(name==='get_live_checkpoint_inputs')return Response.json(++loads%2?[{id:holder,nba_game_id:'0022600099',status:'InProgress',needs_scoreboard:true,needs_stats:false,game_date:'2026-10-29'}]:[])
    if(name==='nba_games')return Response.json([1,2,3].map(n=>({id:`early-${n}`,nba_game_id:`002260000${n}`,status:'Scheduled'})))
    if(name==='record_live_poll_attempts')return Response.json(null)
    if(name==='save_live_scoreboard_atomic'){
      const id=(await request.json()).p_game_id
      orders.at(-1)!.push(id);active++;maximum=Math.max(maximum,active)
      try {
        if(id!=='early-3')await new Promise<void>((resolve,reject)=>{
          if(request.signal.aborted){reject(request.signal.reason);return}
          request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true})
        })
        return Response.json(true)
      }finally{active--}
    }
    throw new Error(`Unexpected ${url}`)
  }
  try {
    for(let tick=0;tick<2;tick++){
      orders.push([])
      await withWorkContext({signal:AbortSignal.timeout(10000)},()=>ingestTick(holder,undefined,new Set([holder])))
      assert.ok(orders[tick].includes('early-3'),'A slow receipt must not starve a healthy game')
      assert.equal(orders[tick].length,3)
    }
    assert.equal(maximum,2)
    assert.notEqual(orders[0][0],orders[1][0])
  }finally{globalThis.fetch=original}
})

Deno.test('unrelated start errors do not prevent a selected import checkpoint',async()=>{
  const original=globalThis.fetch
  const board=JSON.parse(await Deno.readTextFile('tests/fixtures/live-espn/2026-10-30T01-00-49.445Z-scoreboard.json')).payload
  board.events=[]
  const selected={id:holder,nba_game_id:'0022600001',status:'InProgress',needs_scoreboard:true,needs_stats:true,
    game_date:'2026-10-29',season_year:2027,week_number:2,home_team:'BOS',away_team:'NYK'}
  let unrelated=0
  const starts:string[]=[]
  globalThis.fetch=async(input,init)=>{
    const request=new Request(input,init);const url=new URL(request.url);const name=url.pathname.split('/').at(-1)!
    if(url.hostname==='espn.invalid')return url.pathname.endsWith('scoreboard')?Response.json(board):Response.json({},{status:503})
    if(name==='todaysScoreboard_00.json')return Response.json({scoreboard:{games:[{gameId:'0022600144',gameStatus:2,gameStatusText:'Q1',period:1,gameClock:'broken',homeTeam:{teamTricode:'ATL',score:0},awayTeam:{teamTricode:'CLE',score:0}}]}})
    if(name==='boxscore_0022600144.json'){unrelated++;return Response.json({},{status:403})}
    if(name==='boxscore_0022600001.json') {
      const statistics=Object.fromEntries(['assists','blocks','fieldGoalsAttempted','fieldGoalsMade','foulsPersonal','freeThrowsAttempted','freeThrowsMade','plusMinusPoints','points','reboundsDefensive','reboundsOffensive','reboundsTotal','steals','threePointersAttempted','threePointersMade','turnovers'].map(key=>[key,0]))
      const side=(personId:number,teamTricode:string)=>({teamTricode,score:0,players:[{personId,name:'Fixture',played:0,statistics:{...statistics,minutes:'PT0M00S'}}]})
      return Response.json({meta:{time:'2026-10-30T01:00:00Z'},game:{gameId:selected.nba_game_id,gameStatus:3,homeTeam:side(1,'BOS'),awayTeam:side(2,'NYK')}})
    }
    if(name==='get_live_checkpoint_inputs')return Response.json([selected])
    if(name==='nba_games')return Response.json([{...selected,id:'unrelated',nba_game_id:'0022600144',status:'Scheduled',home_team:'ATL',away_team:'CLE'}])
    if(name==='resolve_player_imports_atomic')return Response.json({stale_draft_numbers_cleared:0,results:[1,2].map((value,index)=>({index,player_id:`player-${value}`,action:'updated'}))})
    if(name==='league_seasons')return Response.json([])
    if(name==='save_live_scoreboard_atomic')starts.push((await request.json()).p_game_id)
    return Response.json(name==='save_final_game_snapshot_atomic'?2:null)
  }
  try {
    const {createCheckpointPoller}=await import('./checkpoint.ts')
    let records=0
    const game={...selected,checkpoint_at:null,checked_at:null,needs_final_check:false,game_time:null,home_score:0,away_score:0}
    const tick=createCheckpointPoller({load:async()=>[game],snapshot:async()=>null,ingest:(_holder,ids)=>ingestTick(_holder,undefined,ids),
      record:async()=>{records++;Object.assign(game,{checkpoint_at:new Date().toISOString()})}})
    await tick(holder);await tick(holder)
    assert.equal(unrelated,0)
    assert.deepEqual(starts,[])
    assert.equal(records,1)
  }finally {globalThis.fetch=original}
})

Deno.test('unchanged live ticks do not read finished games for start receipts',async()=>{
  await withDatabase(async calls=>{
    for(let tick=0;tick<3;tick++){
      const result=await ingestTick(holder)
      assert.deepEqual(result.failures,[])
    }
    assert.equal(calls.filter(name=>name==='nba_games').length,0)
    assert.equal(calls.filter(name=>name==='save_live_scoreboard_atomic').length,0)
  },name=>{
    if(name==='get_live_poll_work')return Response.json([{id:holder,nba_game_id:'0022600001',status:'InProgress',needs_scoreboard:true,needs_stats:false,
      home_score:10,away_score:8,game_status_text:'Q1',game_date:'2026-10-29'}])
    if(name==='todaysScoreboard_00.json')return Response.json({scoreboard:{games:[
      {gameId:'0022600001',gameStatus:2,gameStatusText:'Q1',period:1,gameClock:'PT06M00S',homeTeam:{score:10},awayTeam:{score:8}},
      {gameId:'0022600002',gameStatus:3,gameStatusText:'Final',period:4,gameClock:'PT00M00S',homeTeam:{score:100},awayTeam:{score:98}},
    ]}})
    if(name==='nba_games')return Response.json([])
    assert.fail(`Unexpected ${name}`)
  })
})

Deno.test('selected recovery does not restart an exhausted receipt budget',async()=>{
  await withDatabase(async calls=>{
    const tick=await ingestTick(holder,undefined,new Set([holder]),AbortSignal.abort())
    assert.deepEqual(tick.failures,[])
    assert.equal(calls.filter(name=>name==='nba_games').length,0)
  },(name,count)=>{
    if(name==='get_live_checkpoint_inputs')return Response.json(count===1?[{id:holder,nba_game_id:'0022600001',status:'InProgress',needs_scoreboard:true,needs_stats:false,
      home_score:0,away_score:0,game_status_text:'Q1',game_date:'2026-10-29'}]:[])
    if(name==='todaysScoreboard_00.json')return Response.json({scoreboard:{games:[{gameId:'0022600002',gameStatus:2,gameStatusText:'Q1',period:1,
      gameClock:'PT10M00S',homeTeam:{score:0},awayTeam:{score:0}}]}})
    if(name==='nba_games')return Response.json([])
    assert.fail(`Unexpected ${name}`)
  })
})
