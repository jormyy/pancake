import assert from 'node:assert/strict'
Deno.env.set('SUPABASE_URL','http://database.invalid')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY','fixture-key')
const {discoverPublicGames}=await import('./discovery.ts')

Deno.test('a final discovered outside selected work records a start without certifying final stats',async()=>{
  const original=globalThis.fetch
  const writes:Record<string,unknown>[]=[]
  globalThis.fetch=async(input,init)=>{
    const request=new Request(input,init),url=new URL(request.url)
    assert.equal(url.hostname,'database.invalid')
    if(url.pathname.endsWith('/nba_games'))return Response.json([{id:'early',nba_game_id:'0022',home_team:'BOS',away_team:'NYK',status:'Scheduled'}])
    assert.ok(url.pathname.endsWith('/save_live_scoreboard_atomic'))
    writes.push(await request.json());return Response.json(0)
  }
  try {
    await discoverPublicGames({version:1,mode:'public',date:'2026-11-01',capturedAt:Date.now(),games:[{
      id:'0022',nbaId:'0022',espnId:null,source:'nba',status:'Final',updatedAt:Date.now(),
      home:{team:'BOS',score:110,players:[]},away:{team:'NYK',score:100,players:[]},
    }]})
    assert.equal(writes.length,1)
    assert.equal(writes[0].p_status,'InProgress')
  } finally {globalThis.fetch=original}
})

Deno.test('ESPN-only discovery records an immediate lock without requiring player stats',async()=>{
  const original=globalThis.fetch
  let starts=0
  globalThis.fetch=async(input,init)=>{
    const request=new Request(input,init),url=new URL(request.url)
    if(url.pathname.endsWith('/nba_games'))return Response.json([{id:'early',nba_game_id:'0022',home_team:'BOS',away_team:'NYK',status:'Scheduled'}])
    if(url.pathname.endsWith('/save_live_feed_snapshot_atomic'))return Response.json({code:'22023',message:'ESPN stats required'},{status:400})
    assert.ok(url.pathname.endsWith('/save_live_scoreboard_atomic'))
    assert.equal((await request.json()).p_status,'InProgress');starts++;return Response.json(true)
  }
  try {
    await discoverPublicGames({version:1,mode:'public',date:'2026-11-01',capturedAt:Date.now(),games:[{
      id:'espn:401',nbaId:null,espnId:'401',source:'espn',status:'InProgress',updatedAt:Date.now(),period:1,clock:'PT11M00S',
      home:{team:'BOS',score:2,players:[]},away:{team:'NYK',score:0,players:[]},
    }]})
    assert.equal(starts,1)
  } finally {globalThis.fetch=original}
})
