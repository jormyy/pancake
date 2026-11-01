import { fantasyAt, percentile } from './measure.mjs'
import { stateAt } from './fixture.mjs'
import { liveLineStats } from '../../../core/cjs/index.js'

const equal = (a,b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b)<0.005
const points = (expected, display) => display.homeMemberId===expected.home_member_id
  ? [expected.home_points,expected.away_points] : [expected.away_points,expected.home_points]

function correctFinalFrame(frame,expected) {
  const game=frame.snapshot?.games.find(row=>row.nbaId===expected.nba_game_id)
  if(!game || game.status!=='Final' || game.source==='espn')return false
  for(const [side,original] of [[game.home,expected.homeTeam],[game.away,expected.awayTeam]]) {
    if(side.team!==original.teamTricode || side.score!==original.score || side.players.length!==original.players.length)return false
    for(const player of original.players) {
      const line=side.players.find(row=>row[0]===String(player.personId))
      const values=line && liveLineStats(line)
      if(!values || values.didNotPlay || values.minutesPlayed!==25)return false
      const fields={points:'points',rebounds:'reboundsTotal',assists:'assists',steals:'steals',blocks:'blocks',turnovers:'turnovers',
        threePointersMade:'threePointersMade',fieldGoalsMade:'fieldGoalsMade',fieldGoalsAttempted:'fieldGoalsAttempted',
        freeThrowsMade:'freeThrowsMade',freeThrowsAttempted:'freeThrowsAttempted',fouls:'foulsPersonal'}
      if(Object.entries(fields).some(([key,source])=>values[key]!==player.statistics[source]))return false
    }
  }
  return true
}

export function phoneGrade({slate,started,ended,renders,phones,requests,reads,messages,frames=[],finalGameChecks=[],architecture=false}) {
  const observations = [], missing = [], invalid = []
  for(const phone of phones) {
    const member = phone.display?.homeMemberId
    const history = renders.filter(row=>row.phone===phone.phone).sort((a,b)=>a.at-b.at)
    const timeline = [0,...Array.from({length:Math.ceil((ended-started)/1000/slate.changeEverySeconds)},(_,index)=>slate.changeOffsetSeconds+index*slate.changeEverySeconds)]
      .map(second=>({second,score:fantasyAt(slate,second).find(row=>[row.home_member_id,row.away_member_id].includes(member))}))
    const versions = history.map(row=>({row,version:timeline.filter(value=>value.score && started+value.second*1000<=row.at
      && equal(row.homePoints,points(value.score,row)[0]) && equal(row.awayPoints,points(value.score,row)[1])).at(-1)?.second}))
    invalid.push(...versions.filter(value=>value.row.at>=started && value.row.at<ended && !value.row.stale && value.row.mode==='public' && value.version==null)
      .map(value=>({phone:phone.phone,at:value.row.at,reason:'Displayed score has no valid fixture state'})))
    let previous = fantasyAt(slate,0).find(row=>[row.home_member_id,row.away_member_id].includes(member))
    for(let second=slate.changeOffsetSeconds;second<(ended-started)/1000;second+=slate.changeEverySeconds) {
      const expected=fantasyAt(slate,second).find(row=>[row.home_member_id,row.away_member_id].includes(member))
      if(!expected) {missing.push({phone:phone.phone,second,reason:'Missing matchup'});continue}
      if(previous && equal(previous.home_points,expected.home_points) && equal(previous.away_points,expected.away_points)) continue
      previous=expected
      const changed=started+second*1000
      const arrival=versions.find(value=>value.row.at>=changed && value.row.at<=changed+45000 && !value.row.stale
        && value.version!=null && value.version>=second)
      if(arrival)observations.push({phone:phone.phone,at:changed,milliseconds:arrival.row.at-changed})
      else missing.push({phone:phone.phone,second,reason:'Score missed its freshness deadline'})
    }
  }
  const finalExpected=fantasyAt(slate,(ended-started)/1000)
  const finalFailures=phones.flatMap(phone=>{
    const display=phone.display
    const expected=finalExpected.find(row=>[row.home_member_id,row.away_member_id].includes(display?.homeMemberId))
    return expected && equal(display.homePoints,points(expected,display)[0]) && equal(display.awayPoints,points(expected,display)[1])
      ? [] : [{phone:phone.phone,reason:'Final phone score differs from fixture'}]
  })
  const times=observations.map(row=>row.milliseconds)
  const timed=rows=>rows.filter(row=>row.at>=started && row.at<ended)
  const received=timed(messages ?? [])
  const broadcastCounts=phones.map(phone=>({phone:phone.phone,count:received.filter(row=>row.phone===phone.phone && row.score).length}))
  const gates={
    clients:{passed:phones.length===10 && phones.every(phone=>phone.ready && !phone.error),count:phones.length},
    freshness:{passed:times.length>0 && missing.length===0 && percentile(times,.95)<=45000,p50Ms:percentile(times,.5),p95Ms:percentile(times,.95),samples:times.length,missing},
    finalScores:{passed:finalFailures.length===0,checked:phones.length,failures:finalFailures},
    validScores:{passed:invalid.length===0,failures:invalid},
    realtime:{passed:broadcastCounts.every(row=>row.count>0),messages:broadcastCounts},
  }
  if(architecture) {
    const expectedFinals=stateAt(slate,(ended-started)/1000).filter(game=>game.gameStatus===3)
    const checks=expectedFinals.flatMap(game=>{
      const expectedAt=started+Math.max(0,(game.startMinute+game.durationMinutes-slate.windowStartMinute)*60000)
      const official=finalGameChecks.find(row=>row.gameId===game.id)
      return phones.map(phone=>({phone:phone.phone,game:game.nba_game_id,official:official?.passed===true,
        delivered:frames.some(frame=>frame.phone===phone.phone && frame.at>=expectedAt-30000 && frame.at<=expectedAt+45000 && correctFinalFrame(frame,game))}))
    })
    gates.finalHandoffs={passed:checks.length>0 && checks.every(row=>row.official && row.delivered),checks}
  }
  return {version:'phone-v2',passed:Object.values(gates).every(gate=>gate.passed),gates,observations,
    requests:timed(requests),viewReads:timed(reads),messages:received,pollCount:timed(requests).length,
    messageBytes:received.reduce((sum,row)=>sum+row.bytes,0),calculationP95Ms:percentile(timed(renders).map(row=>row.calculationMs).filter(Number.isFinite),.95),
    viewBytes:timed(reads).reduce((sum,row)=>sum+row.bytes,0),viewLatencyP95Ms:percentile(timed(reads).map(row=>row.done-row.at),.95)}
}
