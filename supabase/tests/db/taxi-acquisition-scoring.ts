import { strict as assert } from 'node:assert'
const cwd = Deno.cwd(), db = Deno.env.get('SUPABASE_DB_URL'), api = Deno.env.get('SUPABASE_URL')
assert.ok(db && api)
for(const endpoint of [db,api]) assert.ok(['127.0.0.1','localhost'].includes(new URL(endpoint).hostname),'Only an isolated local stack is allowed')
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  assert.equal(url.origin, api)
  return nativeFetch(input, init)
}
const { supabase } = await import(`${cwd}/supabase/functions/_shared/supabase.ts`)
const { calcWeekMaxPossiblePointsByMember } = await import(`${cwd}/supabase/functions/_shared/scoreLineups.ts`)
const process = new Deno.Command('psql',{args:[db,'-X','-qAt','--set','ON_ERROR_STOP=1'],stdin:'piped',stdout:'piped',stderr:'inherit',env:{PGOPTIONS:'-c statement_timeout=45000 -c lock_timeout=3000'}}).spawn()
const writer=process.stdin.getWriter(),reader=process.stdout.getReader(); let buffer=''
const sql=async(statement:string)=>{
  const marker=crypto.randomUUID()
  await writer.write(new TextEncoder().encode(`${statement}; SELECT '${marker}';\n`))
  while(!buffer.includes(marker)){const next=await reader.read();assert.ok(!next.done,'Owned SQL fixture connection closed');buffer+=new TextDecoder().decode(next.value)}
  const output=buffer.slice(0,buffer.indexOf(marker)).trim();buffer=buffer.slice(buffer.indexOf(marker)+marker.length);return output
}
const q=async(operation:any)=>{const {data,error}=await operation;if(error)throw new Error(error.message);return data}
const literal=(v:string)=>`'${v.replaceAll("'","''")}'`
let ids:Record<string,string>={},committed=false,gameIds:string[]=[],playerIds:string[]=[],leagueIds:string[]=[],userIds:string[]=[],seasonIds:string[]=[]
const results:{scenario:string;actual:number;expected:number;history:any[]}[]=[]
let calendarYear=0;const weekIds:string[]=[]
try{
  const setup=(await Deno.readTextFile(`${cwd}/tests/db/taxi-acquisition-policy.sql`)).split('-- Actual real rookie draft.')[0]
  assert.ok(setup.startsWith('-- Real draft/trade acquisition')&&setup.includes('BEGIN;'))
  await sql(setup)
  ids=JSON.parse(await sql("SELECT jsonb_object_agg(name,id) FROM taxi_acceptance_ids"))
  leagueIds=['snake','auction','life','late'].map(w=>ids[`${w}-league`]);seasonIds=['snake','auction','life','late'].map(w=>ids[`${w}-season`])
  userIds=['user-a','user-b','user-outsider'].map(n=>ids[n])
  playerIds=JSON.parse(await sql("SELECT jsonb_agg(p.id) FROM players p JOIN taxi_acceptance_ids f ON f.id=p.id"))
  gameIds=JSON.parse(await sql("SELECT jsonb_agg(g.id) FROM nba_games g JOIN players p ON p.nba_team=g.home_team WHERE p.id=pg_temp.taxi_id('snake-started')"))
  await sql(`DO $$ DECLARE d uuid; n public.nominations%ROWTYPE; t uuid; BEGIN
    d:=(public.start_rookie_draft_atomic(pg_temp.taxi_id('snake-league'),2,false,3600,'auto_pick')->>'id')::uuid;
    PERFORM public.make_snake_pick_atomic(d,pg_temp.taxi_id('snake-a'),pg_temp.taxi_id('snake-first'),true);
    PERFORM public.make_snake_pick_atomic(d,pg_temp.taxi_id('snake-a'),pg_temp.taxi_id('snake-capacity'),false);
    SELECT id INTO d FROM public.start_auction_draft_atomic(pg_temp.taxi_id('auction-league'),'user_nominated',false,3600,100,'auction_no_bid');
    n:=public.create_auction_nomination_atomic(d,pg_temp.taxi_id('auction-a'),pg_temp.taxi_id('auction-sale'),pg_temp.taxi_id('user-a'),3600);
    PERFORM public.place_auction_bid_atomic(d,pg_temp.taxi_id('auction-b'),n.id,5,pg_temp.taxi_id('user-b'),true);
    UPDATE nominations SET countdown_expires_at=now()-interval '1 second' WHERE id=n.id;
    PERFORM public.close_auction_nomination_atomic(n.id);
    t:=public.propose_trade_atomic(pg_temp.taxi_id('life-league'),pg_temp.taxi_id('life-season'),pg_temp.taxi_id('life-a'),pg_temp.taxi_id('life-b'),ARRAY[pg_temp.taxi_id('life-trade-in')],ARRAY[pg_temp.taxi_id('life-return')],ARRAY[]::uuid[],ARRAY[]::uuid[]);
    PERFORM public.set_trade_taxi_destinations_atomic(t,pg_temp.taxi_id('life-a'),ARRAY[pg_temp.taxi_id('life-return')],pg_temp.taxi_id('user-a'));
    PERFORM public.set_trade_taxi_destinations_atomic(t,pg_temp.taxi_id('life-b'),ARRAY[pg_temp.taxi_id('life-trade-in')],pg_temp.taxi_id('user-b'));
    PERFORM public.accept_trade_atomic(t,pg_temp.taxi_id('life-b'));
  END $$`)
  for(const leagueId of leagueIds){await sql(`DELETE FROM lineup_slot_templates WHERE league_id=${literal(leagueId)}; INSERT INTO lineup_slot_templates(league_id,slot_type,slot_count) VALUES(${literal(leagueId)},'PG',1)`)}
  const gameId=crypto.randomUUID();gameIds.push(gameId)
  const day=new Date(Date.now()+86400000).toLocaleDateString('en-CA',{timeZone:'America/New_York'})
  const year=Number(await sql('SELECT public.current_season_year_et(now())'))
  await sql(`INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES(${literal(gameId)},${literal('002-taxi-max-'+gameId)},${year},1,${literal(day)},${literal(day+'T23:00:00Z')},'XTM','XTA','Final')`)
  for(const [name,points] of [['snake-first',100],['snake-capacity',7],['auction-sale',100],['auction-trade-in',7],['life-trade-in',100],['life-return',100],['life-manual',7]] as const){
    await sql(`INSERT INTO player_game_stats(game_id,player_id,season_year,week_number,game_date,points,did_not_play) VALUES(${literal(gameId)},${literal(ids[name])},${year},1,${literal(day)},${points},false)`)
  }
  await sql('COMMIT');committed=true
  for(const [world,side,expected] of [['snake','a',7],['auction','b',7],['life','a',7],['life','b',0]] as const){
    const member=ids[`${world}-${side}`]
    const scores=await calcWeekMaxPossiblePointsByMember([member],ids[`${world}-league`],ids[`${world}-season`],year,{points:1},day,day)
    const history=await q(supabase.from('roster_transactions').select('*').eq('league_season_id',ids[`${world}-season`]).eq('member_id',member).order('occurred_at'))
    const safe=history.map((row:any)=>({player_id:row.player_id,type:row.transaction_type,at:row.occurred_at,...('acquired_to_taxi' in row?{acquired_to_taxi:row.acquired_to_taxi}:{})}))
    results.push({scenario:`${world}-${side}`,actual:scores.get(member)!,expected,history:safe})
  }
  console.log(JSON.stringify({actualAcquisitionScores:results,clock:'Synthetic game/stat cutoff tomorrow; acquisition SQL is actual now. Auction timer alone is explicitly expired as fixture setup.',sourceScorer:true}))
  const mismatch=results.filter(row=>row.actual!==row.expected)
  assert.deepEqual(mismatch,[],'Taxi acquisitions cannot earn maximum-possible points before activation')
  {
    const shift=(n:number)=>new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10)
    for(let n=0;n<50;n++){
      const candidate=4000+crypto.getRandomValues(new Uint32Array(1))[0]%4000
      if(await sql(`SELECT NOT EXISTS(SELECT 1 FROM season_weeks WHERE season_year=${candidate}) AND NOT EXISTS(SELECT 1 FROM league_seasons WHERE season_year=${candidate}) AND NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=${candidate})`) ==='t'){calendarYear=candidate;break}
    }
    assert.ok(calendarYear)
    for(let i=0;i<2;i++){
      const id=crypto.randomUUID();weekIds.push(id)
      await q(supabase.from('season_weeks').insert({id,season_year:calendarYear,week_number:i+1,week_start:shift(i*7-1),week_end:shift(i*7+5)}))
    }
    await q(supabase.from('league_seasons').update({season_year:calendarYear}).in('id',seasonIds))
    await q(supabase.from('nba_games').update({season_year:calendarYear,stats_synced_at:new Date().toISOString()}).eq('id',gameId))
    await q(supabase.from('leagues').update({scoring_settings:{points:1},status:'active'}).in('id',[ids['life-league'],ids['snake-league']]))
    await q(supabase.from('weekly_lineups').delete().in('league_id',leagueIds))
    await q(supabase.from('roster_players').insert({league_id:ids['snake-league'],league_season_id:ids['snake-season'],member_id:ids['snake-b'],player_id:ids['snake-veteran'],acquired_via:'draft'}))
    await q(supabase.from('player_game_stats').insert({game_id:gameId,player_id:ids['snake-veteran'],season_year:calendarYear,week_number:1,game_date:day,points:20,did_not_play:false}))
    const matchupIds=[crypto.randomUUID(),crypto.randomUUID()]
    for(const [i,world] of ['life','snake'].entries())await q(supabase.from('matchups').insert({id:matchupIds[i],league_id:ids[`${world}-league`],league_season_id:ids[`${world}-season`],week_number:1,home_member_id:ids[`${world}-a`],away_member_id:ids[`${world}-b`],matchup_type:i?'playoff_final':'regular_season'}))
    const {syncScores}=await import(`${cwd}/supabase/functions/_shared/syncScores.ts`)
    const reference=new Date(shift(7)+'T16:00:00Z')
    await syncScores(ids['life-league'],reference);await syncScores(ids['snake-league'],reference)
    const decisions=await q(supabase.from('matchups').select('*').in('id',matchupIds))
    const regular=decisions.find((r:any)=>r.id===matchupIds[0]),playoff=decisions.find((r:any)=>r.id===matchupIds[1])
    assert.equal(regular.is_finalized,true);assert.equal(regular.winner_member_id,null);assert.equal(regular.home_max_possible_points,7);assert.equal(regular.away_max_possible_points,0)
    assert.equal(playoff.is_finalized,true);assert.equal(playoff.home_points,0);assert.equal(playoff.away_points,0);assert.equal(playoff.winner_member_id,ids['snake-b']);assert.equal(playoff.home_max_possible_points,7);assert.equal(playoff.away_max_possible_points,20)
    const standing=await q(supabase.from('standings').select('*').eq('league_season_id',ids['life-season']).eq('week_number',1).eq('member_id',ids['life-a']).single())
    assert.equal(standing.max_possible_points,7);assert.equal(standing.ties,1)
    const capture=()=>q(supabase.rpc('capture_score_inputs',{p_league_season_id:ids['snake-season'],p_week_number:1}))
    const beforeToken=await capture()
    const certificate=()=>sql(`SELECT to_jsonb(c) FROM private.score_week_certificates c WHERE league_season_id=${literal(ids['snake-season'])} AND week_number=1`)
    const beforeCertificate=await certificate();assert.ok(beforeCertificate)
    const tx=await q(supabase.from('roster_transactions').select('id').eq('member_id',ids['snake-a']).eq('player_id',ids['snake-first']).eq('transaction_type','draft_won').single())
    await q(supabase.from('roster_transactions').update({acquired_to_taxi:null}).eq('id',tx.id))
    assert.notDeepEqual(await capture(),beforeToken)
    // Legacy rows without destination evidence predate taxi acquisitions, so they score like an active acquisition.
    const playoffResult=()=>q(supabase.from('matchups').select('winner_member_id,home_max_possible_points,away_max_possible_points').eq('id',matchupIds[1]).single())
    await syncScores(ids['snake-league'],reference)
    const legacy=await playoffResult()
    assert.notEqual(await certificate(),beforeCertificate,'A changed acquisition destination recertifies the week')
    await q(supabase.from('roster_transactions').update({acquired_to_taxi:false}).eq('id',tx.id));await syncScores(ids['snake-league'],reference)
    assert.deepEqual(legacy,await playoffResult(),'Unknown legacy destination scores exactly like an active acquisition')
    assert.deepEqual(legacy,{winner_member_id:ids['snake-a'],home_max_possible_points:100,away_max_possible_points:20})
    await q(supabase.from('roster_transactions').update({acquired_to_taxi:true}).eq('id',tx.id));await syncScores(ids['snake-league'],reference)
    const recovered=await q(supabase.from('matchups').select('winner_member_id,home_max_possible_points,away_max_possible_points').eq('id',matchupIds[1]).single())
    assert.deepEqual(recovered,{winner_member_id:ids['snake-b'],home_max_possible_points:7,away_max_possible_points:20})
    console.log(JSON.stringify({actualFullSync:{regular:{max:[7,0],ties:1},playoff:{points:[0,0],max:[7,20],winner:'B'},legacyUnknownScoredActive:true,certificateInvalidated:true,restoredTaxiEvidence:true},fixtureClock:'actual acquisition now; synthetic complete future game; scorer reference next week'}))
    await q(supabase.from('leagues').update({status:'active'}).eq('id',ids['life-league']))
    const rp=await q(supabase.from('roster_players').select('id').eq('member_id',ids['life-a']).eq('player_id',ids['life-return']).single())
    await q(supabase.rpc('toggle_taxi_atomic',{p_roster_player_id:rp.id,p_to_taxi:false,p_user_id:ids['user-a']}))
    const active=await calcWeekMaxPossiblePointsByMember([ids['life-a']],ids['life-league'],ids['life-season'],calendarYear,{points:1},day,day)
    assert.equal(active.get(ids['life-a']),100)
    const history=await q(supabase.from('roster_transactions').select('acquired_to_taxi').eq('member_id',ids['life-a']).eq('transaction_type','trade_in').single())
    assert.equal(history.acquired_to_taxi,true)
    console.log(JSON.stringify({actualActivationMax:100,acquisitionFlagPreserved:true}))
  }
}finally{
  if(!committed){try{await sql('ROLLBACK')}catch{}}
  if(committed){
    await sql(`BEGIN; DELETE FROM roster_transactions WHERE league_id IN(${leagueIds.map(literal).join(',')}); DELETE FROM trade_items WHERE trade_id IN(SELECT id FROM trades WHERE league_id IN(${leagueIds.map(literal).join(',')})); DELETE FROM snake_draft_picks WHERE draft_id IN(SELECT id FROM drafts WHERE league_id IN(${leagueIds.map(literal).join(',')})); DELETE FROM draft_picks WHERE league_id IN(${leagueIds.map(literal).join(',')}); DELETE FROM drafts WHERE league_id IN(${leagueIds.map(literal).join(',')}); DELETE FROM public.leagues WHERE id IN(${leagueIds.map(literal).join(',')}); DELETE FROM public.player_game_stats WHERE game_id IN(${gameIds.map(literal).join(',')}); DELETE FROM public.nba_games WHERE id IN(${gameIds.map(literal).join(',')}); DELETE FROM public.players WHERE id IN(${playerIds.map(literal).join(',')}); DELETE FROM auth.users WHERE id IN(${userIds.map(literal).join(',')}); ${weekIds.length?`DELETE FROM season_weeks WHERE id IN(${weekIds.map(literal).join(',')});`:''} ${calendarYear?`DELETE FROM private.score_input_revisions WHERE scope='calendar:${calendarYear}' OR scope LIKE 'nba:${calendarYear}:%';`:''} DELETE FROM private.score_input_revisions WHERE scope IN(${[...leagueIds.map(id=>'league:'+id),...seasonIds.map(id=>'season:'+id),...playerIds.map(id=>'player:'+id)].map(literal).join(',')}); COMMIT`)
    const left=await sql(`SELECT (SELECT count(*) FROM leagues WHERE id IN(${leagueIds.map(literal).join(',')}))+(SELECT count(*) FROM players WHERE id IN(${playerIds.map(literal).join(',')}))+(SELECT count(*) FROM auth.users WHERE id IN(${userIds.map(literal).join(',')}))+(SELECT count(*) FROM nba_games WHERE id IN(${gameIds.map(literal).join(',')}))`)
    assert.equal(left,'0');console.log(JSON.stringify({exactFixtureCleanup:Number(left)}))
  }
  await writer.close();await reader.cancel();await process.status;globalThis.fetch=nativeFetch
}
