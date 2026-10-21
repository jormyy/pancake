import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { expectedWinner } from './score-oracle.mjs'

export function matchupOrder(rows) {
  return rows.filter(row => row.matchup_type === 'regular_season' && !row.is_voided).map(row => ({ week: row.week_number, home: row.home_member_id, away: row.away_member_id })).sort((a,b) => a.week-b.week || a.home.localeCompare(b.home) || a.away.localeCompare(b.away))
}

function joinedCycle(order) {
  const circle=order.length%2?[...order,null]:[...order],weeks=[]
  for(let round=0;round<circle.length-1;round++){
    const pairs=[]
    for(let index=0;index<circle.length/2;index++){
      const pair=[circle[index],circle[circle.length-1-index]]
      if(pair.every(Boolean))pairs.push(pair.sort().join(':'))
    }
    weeks.push(pairs.sort().join('|'))
    circle.splice(1,0,circle.pop())
  }
  return weeks
}

export function checkMatchupOrder({ rows, members, order, earlier = [], previous = null }) {
  const table = matchupOrder(rows), ids = members.map(row => row.id)
  assert.ok(table.length, 'F1 requires a full regular schedule')
  const weeks = [...new Set(table.map(row => row.week))], counts = new Map()
  for (const week of weeks) {
    const games = table.filter(row => row.week === week), teams = games.flatMap(row => [row.home,row.away])
    assert.equal(teams.length, ids.length - ids.length%2, 'Every eligible week has all expected pairings')
    assert.equal(new Set(teams).size, teams.length, 'No team plays twice in a week')
    assert.ok(teams.every(id => ids.includes(id)), 'Every pairing belongs to the league')
    for (const game of games) { const pair = [game.home,game.away].sort().join(':'); counts.set(pair,(counts.get(pair)??0)+1) }
  }
  const ideal = table.length / (ids.length*(ids.length-1)/2)
  for (let a=0;a<ids.length;a++) for(let b=a+1;b<ids.length;b++) assert.ok([Math.floor(ideal),Math.ceil(ideal)].includes(counts.get([ids[a],ids[b]].sort().join(':'))??0), 'Every opponent pair meets floor/ceil times')
  const cycle = ids.length%2 ? ids.length : ids.length-1
  for(let start=0;start+cycle<=weeks.length;start+=cycle) for(const id of ids){
    const games=table.filter(row=>weeks.slice(start,start+cycle).includes(row.week))
    assert.ok(Math.abs(games.filter(row=>row.home===id).length-games.filter(row=>row.away===id).length)<=1,'Each full cycle balances home and away')
  }
  const joined=[...members].sort((a,b)=>a.joined_at.localeCompare(b.joined_at)||a.id.localeCompare(b.id)).map(row=>row.id)
  const playedCycle=weeks.slice(0,cycle).map(week=>table.filter(row=>row.week===week).map(row=>[row.home,row.away].sort().join(':')).sort().join('|'))
  assert.equal(playedCycle.length,cycle,'The schedule contains a full cycle to measure its ordering')
  assert.ok(!joined.some((_,index)=>JSON.stringify(joinedCycle([...joined.slice(index),...joined.slice(0,index)]))===JSON.stringify(playedCycle)),'Actual matchup order is not a rotation of joined_at order')
  if(order!=null){
    assert.deepEqual([...order].sort(),[...ids].sort(),'The observed season order is a complete permutation')
    assert.ok(!joined.some((_,index)=>JSON.stringify([...joined.slice(index),...joined.slice(0,index)])===JSON.stringify(order)),'The observed season shuffle is not a rotation of joined_at order')
  }
  for(const prior of earlier) assert.deepEqual(table,prior,'Schedule reads remain stable within the season')
  if(previous){
    if(order!=null&&previous.order!=null)assert.notDeepEqual(order,previous.order,'The next season has a different member order')
    const common=weeks.filter(week=>previous.table.some(row=>row.week===week))
    assert.notDeepEqual(table.filter(row=>common.includes(row.week)),previous.table.filter(row=>common.includes(row.week)),'The next season changes actual pair/home/away order on common weeks')
  }
  return { passed:true,table,pairs:[...counts].map(([pair,count])=>({pair,count})),completeCycles:Math.floor(weeks.length/cycle),order,checkpointCount:earlier.length+1 }
}

export function checkPlayoffEvidence({ rows, standings, seasonId, seeds, members, settings, calendar, seasonEnd, before = [] }) {
  const last=settings.playoff_start_week+settings.playoff_round_lengths.reduce((a,b)=>a+b,0)-1
  const end=calendar.weeks.find(row=>row.week_number===last)?.week_end
  assert.ok(end&&end<=seasonEnd,'Configured playoff weeks fit inside the NBA regular season')
  const playoffs=rows.filter(row=>row.matchup_type!=='regular_season'&&!row.is_voided)
  if(!playoffs.length)return {passed:true,fit:true,lastWeek:last,end,phase:'Playoffs not measured',warning:{shouldWarn:false,source:'Independent settings/calendar fit; rendered UI warning not measured'}}
  const regular=rows.filter(row=>row.matchup_type==='regular_season'&&!row.is_voided)
  assert.ok(regular.length&&regular.every(row=>row.is_finalized),'Playoffs require all regular results')
  const latest=Math.max(...standings.map(row=>row.week_number)),snapshot=standings.filter(row=>row.week_number===latest)
  assert.equal(snapshot.length,members.length,'Final standings include every team')
  const ranked=members.map(member=>{
    const games=regular.filter(row=>[row.home_member_id,row.away_member_id].includes(member.id)),standing=snapshot.find(row=>row.member_id===member.id)
    const wins=games.filter(row=>row.winner_member_id===member.id).length,points=games.reduce((sum,row)=>sum+Number(row.home_member_id===member.id?row.home_points:row.away_points),0)
    assert.equal(Number(standing.wins),wins,'Final standing wins rebuild from results')
    assert.equal(Number(standing.points_for),Math.round(points*100)/100,'Final standing PF rebuilds from results')
    return {id:member.id,wins,points:Math.round(points*100)/100,max:Math.round(games.reduce((sum,row)=>sum+Number(row.home_member_id===member.id?row.home_max_possible_points:row.away_max_possible_points),0)*100)/100,against:Math.round(games.reduce((sum,row)=>sum+Number(row.home_member_id===member.id?row.away_points:row.home_points),0)*100)/100,tie:createHash('sha256').update(`${seasonId}:${member.id}`).digest('hex')}
  }).sort((a,b)=>b.wins-a.wins||b.points-a.points||b.max-a.max||a.against-b.against||a.tie.localeCompare(b.tie)||a.id.localeCompare(b.id))
  assert.deepEqual(seeds,ranked.slice(0,settings.playoff_entrants).map(row=>row.id),'Seeds use wins, PF, max possible, PA, season hash, member id')
  const eligible=ranked.slice(0,settings.playoff_entrants).map(row=>row.id)
  assert.ok(playoffs.every(row=>[row.home_member_id,row.away_member_id].filter(Boolean).every(id=>eligible.includes(id))),'Only playoff entrants receive bracket rows')
  let start=settings.playoff_start_week
  const byeCount=2**Math.ceil(Math.log2(settings.playoff_entrants))-settings.playoff_entrants
  for(let round=1;round<=settings.playoff_round_lengths.length;round++){
    const games=playoffs.filter(row=>row.playoff_round===round)
    if(games.length){
      for(const row of games){
        assert.equal(row.week_number,start);assert.equal(row.end_week_number,start+settings.playoff_round_lengths[round-1]-1)
        if(row.is_finalized)assert.equal(row.winner_member_id,expectedWinner(row),'Playoff winner follows independent tie rules')
      }
      if(round===1)for(const id of eligible.slice(0,byeCount))assert.ok(!games.some(row=>[row.home_member_id,row.away_member_id].includes(id))||games.some(row=>row.home_member_id===id&&!row.away_member_id),'Highest seeds receive first-round byes')
    }
    start+=settings.playoff_round_lengths[round-1]
  }
  for(const lost of playoffs.filter(row=>row.is_finalized&&row.away_member_id)){
    const loser=lost.winner_member_id===lost.home_member_id?lost.away_member_id:lost.home_member_id
    assert.ok(!playoffs.some(row=>row.week_number>(lost.end_week_number??lost.week_number)&&[row.home_member_id,row.away_member_id].includes(loser)),'Eliminated teams receive no later scoring matchup')
  }
  for(const prior of before.filter(row=>row.is_finalized)){
    const current=rows.find(row=>row.id===prior.id)
    assert.ok(current,'Settled eliminated-team matchup remains in history')
    for(const field of ['home_points','away_points','winner_member_id'])assert.equal(current[field],prior[field],'Settled playoff scores never accrue later points')
  }
  const finals=playoffs.filter(row=>row.matchup_type==='playoff_final')
  assert.ok(finals.length<=1,'Exactly one championship final can exist')
  if(finals.some(row=>row.is_finalized))assert.equal(finals.filter(row=>row.is_finalized&&row.winner_member_id).length,1,'Exactly one champion is recorded')
  return {passed:true,fit:true,lastWeek:last,end,seeds,byeCount,champions:finals.filter(row=>row.is_finalized).length,phase:finals.some(row=>row.is_finalized)?'Champion measured':'Bracket in progress',warning:{shouldWarn:false,source:'Independent settings/calendar fit; rendered UI warning not measured'}}
}

export function checkPlayersPool({ rows, expected, expectedYear, allPlayerIds }) {
  assert.deepEqual(rows.map(row=>row.id).sort(),[...allPlayerIds].sort(),'All Players pages contain every player once')
  let previous=Infinity,missing=false
  for(const row of rows){
    assert.equal(row.stats_season_year,expectedYear,'Every page uses the shown statistics season')
    const value=expected[row.id]??null
    assert.equal(row.avg_fantasy_points==null?null:Number(row.avg_fantasy_points),value,'Shown FP/game equals the independent stored-stat average')
    if(value==null)missing=true
    else{assert.equal(missing,false,'Players without stats sort last');assert.ok(value<=previous,'Auto sorts FP/game descending');previous=value}
  }
  return {passed:true,players:rows.length,withStats:rows.filter(row=>expected[row.id]!=null).length,statsSeason:expectedYear,label:`${expectedYear-1}-${String(expectedYear).slice(-2)}`}
}

export function checkDraftPushes(picks,members,deliveries,outbox,audits=[]){
  assert.ok(picks.length,'A played rookie draft has expected pick rows')
  const table=[]
  for(const pick of picks){
    const owner=members.find(row=>row.memberId===pick.member_id)
    assert.ok(owner,'Every pick owner belongs to the league')
    const sent=deliveries.filter(row=>row.eventType==='draft_on_clock'&&row.data.pickId===pick.id)
    assert.equal(sent.length,1,'One recorded on-clock push exists per pick in this run')
    assert.equal(sent[0].recipientToken,owner.token,'On-clock push reaches the traded pick owner')
    const events=outbox.filter(row=>row.event_type==='draft_on_clock'&&row.data.pickId===pick.id)
    assert.equal(events.length,1,'One durable on-clock event exists per pick')
    assert.equal(events[0].member_id,pick.member_id)
    assert.equal(sent[0].dedupeKey,events[0].dedupe_key,'Transport records the persisted dedupe key')
    assert.ok(events[0].delivered_at,'A receipt acknowledges each delivered on-clock event')
    table.push({pick:pick.overall_pick,pickId:pick.id,member:pick.member_id,token:owner.token,dedupeKey:sent[0].dedupeKey,businessAt:sent[0].businessAt,autoPicked:audits.some(row=>row.action==='auto_pick'&&row.metadata.pick?.id===pick.id),skippedAt:pick.skipped_at??null})
  }
  assert.ok(deliveries.filter(row=>row.data?.draftId===picks[0].draft_id).every(row=>members.some(member=>member.token===row.recipientToken)),'No draft push reaches a user outside the league')
  return {passed:true,table}
}

export function checkDraftCutoff({ picks,status,warning,cutoff,at,audits }){
  assert.equal(warning.code,'opening_night_overrun','A crossing draft displays the product start warning')
  assert.equal(Date.parse(warning.openingNightCutoff),cutoff,'Warning uses actual NBA opening day at 09:00 ET')
  assert.ok(at>=cutoff)
  assert.equal(status,'completed','The production opening-night path completes the draft')
  assert.ok(picks.length&&picks.every(row=>row.picked_at&&row.player_id),'Opening-night auto-completion leaves no unfinished pick')
  assert.ok(picks.every(row=>row.timer_expires_at==null),'No pick remains on the clock')
  const autoIds=new Set(audits.filter(row=>row.action==='auto_pick'&&row.metadata.reason==='season_boundary_backstop').map(row=>row.metadata.pick?.id))
  assert.ok(picks.every(row=>autoIds.has(row.id)),'Every cutoff selection has a real automatic-pick audit row')
  return {passed:true,picks:picks.length,autoPicked:autoIds.size,cutoff:new Date(cutoff).toISOString(),default:'Reversible product default: complete unfinished rookie picks at actual opening day 09:00 ET'}
}
