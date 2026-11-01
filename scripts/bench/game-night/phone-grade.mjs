import { fantasyAt, percentile } from './measure.mjs'

const equal = (a,b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b)<0.005
const points = (expected, display) => display.homeMemberId===expected.home_member_id
  ? [expected.home_points,expected.away_points] : [expected.away_points,expected.home_points]

export function phoneGrade({slate,started,ended,renders,phones,requests,reads,messages}) {
  const observations = [], missing = []
  for(const phone of phones) {
    const member = phone.display?.homeMemberId
    const history = renders.filter(row=>row.phone===phone.phone).sort((a,b)=>a.at-b.at)
    let previous = fantasyAt(slate,0).find(row=>[row.home_member_id,row.away_member_id].includes(member))
    for(let second=slate.changeOffsetSeconds;second<(ended-started)/1000;second+=slate.changeEverySeconds) {
      const expected=fantasyAt(slate,second).find(row=>[row.home_member_id,row.away_member_id].includes(member))
      if(!expected) {missing.push({phone:phone.phone,second,reason:'Missing matchup'});continue}
      if(previous && equal(previous.home_points,expected.home_points) && equal(previous.away_points,expected.away_points)) continue
      previous=expected
      const changed=started+second*1000
      const arrival=history.find(row=>row.at>=changed && row.at<=changed+45000 && !row.stale
        && equal(row.homePoints,points(expected,row)[0]) && equal(row.awayPoints,points(expected,row)[1]))
      if(arrival)observations.push({phone:phone.phone,at:changed,milliseconds:arrival.at-changed})
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
    realtime:{passed:broadcastCounts.every(row=>row.count>0),messages:broadcastCounts},
  }
  return {passed:Object.values(gates).every(gate=>gate.passed),gates,observations,
    requests:timed(requests),viewReads:timed(reads),messages:received,pollCount:timed(requests).length,
    messageBytes:received.reduce((sum,row)=>sum+row.bytes,0),calculationP95Ms:percentile(timed(renders).map(row=>row.calculationMs).filter(Number.isFinite),.95),
    viewBytes:timed(reads).reduce((sum,row)=>sum+row.bytes,0),viewLatencyP95Ms:percentile(timed(reads).map(row=>row.done-row.at),.95)}
}
