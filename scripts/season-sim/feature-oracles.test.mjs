import assert from 'node:assert/strict'
import test from 'node:test'
import { checkMatchupOrder,checkPlayoffEvidence,checkPlayersPool,checkDraftPushes,checkDraftCutoff } from './feature-oracles.mjs'

const ids=['a','b','c','d'],members=ids.map(id=>({id,joined_at:id})),order=['c','a','d','b']
const rows=[['a','b'],['c','d'],['c','a'],['d','b'],['a','d'],['b','c']].map(([home_member_id,away_member_id],index)=>({id:String(index),week_number:Math.floor(index/2)+1,home_member_id,away_member_id,matchup_type:'regular_season'}))

test('F1 independently rejects unfair, unbalanced, unstable and unshuffled schedules',()=>{
  const rows=[['a','d'],['c','b'],['b','a'],['d','c'],['a','c'],['b','d']].map(([home_member_id,away_member_id],index)=>({id:String(index),week_number:Math.floor(index/2)+1,home_member_id,away_member_id,matchup_type:'regular_season'}))
  assert.ok(checkMatchupOrder({rows,members,order}).passed)
  assert.ok(checkMatchupOrder({rows,members,order:null}).passed)
  assert.throws(()=>checkMatchupOrder({rows:rows.slice(1),members,order}))
  assert.throws(()=>checkMatchupOrder({rows:rows.map((row,i)=>i===2?{...row,home_member_id:'a',away_member_id:'b'}:row),members,order}))
  assert.throws(()=>checkMatchupOrder({rows,members,order:ids}))
  assert.throws(()=>checkMatchupOrder({rows,members,order,earlier:[[]]}))
  const current=checkMatchupOrder({rows,members,order})
  assert.throws(()=>checkMatchupOrder({rows,members,order,previous:current}))
})

test('F2 rejects a playoff span outside the raw NBA calendar',()=>{
  const data={rows,standings:[],seasonId:'s',seeds:[],members,settings:{playoff_start_week:4,playoff_round_lengths:[1,2]},calendar:{weeks:[{week_number:6,week_end:'2025-04-13'}]},seasonEnd:'2025-04-13'}
  assert.ok(checkPlayoffEvidence(data).fit)
  assert.throws(()=>checkPlayoffEvidence({...data,seasonEnd:'2025-04-12'}))
})

test('F3 rejects wrong averages, seasons, missing pages and null-first sort',()=>{
  const data={rows:[{id:'a',avg_fantasy_points:12,stats_season_year:2025},{id:'b',avg_fantasy_points:null,stats_season_year:2025}],expected:{a:12},expectedYear:2025,allPlayerIds:['a','b']}
  assert.ok(checkPlayersPool(data).passed)
  assert.throws(()=>checkPlayersPool({...data,rows:[...data.rows].reverse()}))
  assert.throws(()=>checkPlayersPool({...data,expected:{a:13}}))
  assert.throws(()=>checkPlayersPool({...data,expectedYear:2026}))
  assert.throws(()=>checkPlayersPool({...data,rows:data.rows.slice(0,1)}))
})

test('F6 rejects missing, duplicate and wrong-recipient on-clock pushes',()=>{
  const pick={id:'p',draft_id:'d',member_id:'a',overall_pick:1},member={memberId:'a',token:'token'},sent={eventType:'draft_on_clock',data:{pickId:'p',draftId:'d'},recipientToken:'token',dedupeKey:'key'},event={event_type:'draft_on_clock',data:{pickId:'p'},member_id:'a',dedupe_key:'key',delivered_at:'at'}
  assert.ok(checkDraftPushes([pick],[member],[sent],[event]).passed)
  assert.throws(()=>checkDraftPushes([pick],[member],[],[event]))
  assert.throws(()=>checkDraftPushes([pick],[member],[sent,sent],[event]))
  assert.throws(()=>checkDraftPushes([pick],[member],[{...sent,recipientToken:'outsider'}],[event]))
})

test('F4 rejects a remaining on-clock pick at the opening cutoff',()=>{
  const cutoff=Date.parse('2025-10-21T13:00Z'),data={picks:[{id:'p',picked_at:'at',player_id:'p',timer_expires_at:null}],audits:[{action:'auto_pick',metadata:{reason:'season_boundary_backstop',pick:{id:'p'}}}],status:'completed',warning:{code:'opening_night_overrun',openingNightCutoff:'2025-10-21T13:00Z'},cutoff,at:cutoff}
  assert.equal(checkDraftCutoff(data).autoPicked,1)
  assert.throws(()=>checkDraftCutoff({...data,picks:[{...data.picks[0],timer_expires_at:'later'}]}))
  assert.throws(()=>checkDraftCutoff({...data,status:'in_progress'}))
})

test('F2 rejects wrong seeds, returning losers, changed settled scores and duplicate champions',()=>{
  const regular=rows.map(row=>({...row,is_finalized:true,home_points:1,away_points:0,home_max_possible_points:1,away_max_possible_points:0,winner_member_id:row.home_member_id}))
  const standings=ids.map(member_id=>({member_id,week_number:3,wins:['a','c'].includes(member_id)?2:1,points_for:['a','c'].includes(member_id)?2:1}))
  const game=(id,home,away,round,week,end,type)=>({id,home_member_id:home,away_member_id:away,playoff_round:round,week_number:week,end_week_number:end,matchup_type:type,is_finalized:true,home_points:2,away_points:1,home_max_possible_points:2,away_max_possible_points:1,winner_member_id:home})
  const bracket=[game('s1','c','b',1,4,4,'playoff_semifinal'),game('s2','a','d',1,4,4,'playoff_semifinal'),game('f','c','a',2,5,6,'playoff_final')]
  const input={rows:[...regular,...bracket],standings,seasonId:'s',seeds:['c','a','d','b'],members,settings:{playoff_entrants:4,playoff_start_week:4,playoff_round_lengths:[1,2]},calendar:{weeks:[{week_number:6,week_end:'2025-04-13'}]},seasonEnd:'2025-04-13'}
  assert.equal(checkPlayoffEvidence(input).champions,1)
  assert.throws(()=>checkPlayoffEvidence({...input,seeds:['a','c','d','b']}))
  assert.throws(()=>checkPlayoffEvidence({...input,rows:[...regular,...bracket.slice(0,2),{...bracket[2],away_member_id:'d'}]}))
  assert.throws(()=>checkPlayoffEvidence({...input,before:[{...bracket[0],home_points:1}]}))
  assert.throws(()=>checkPlayoffEvidence({...input,rows:[...input.rows,{...bracket[2],id:'extra'}]}))
})

test('F1 cannot accept a joined-order rotation behind unrelated shuffle metadata',()=>{
  assert.throws(()=>checkMatchupOrder({rows,members,order}))
})
