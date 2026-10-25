import assert from 'node:assert/strict'
import { sql, query, quote, clock, restoreClock, fixture, cleanup, api, startEdge, stopEdge, restart, processes, enableExpiryCron, cronTick, until, record } from '../../scripts/mutation/draft/clock-stack.mjs'

const fixtures=[]
let installed=false
const state = draft => query(`SELECT json_build_object('deadline',(SELECT extract(epoch FROM timer_expires_at)*1000 FROM snake_draft_picks WHERE draft_id=d.id AND overall_pick=1),'remaining',(SELECT extract(epoch FROM timer_expires_at-clock_timestamp()) FROM snake_draft_picks WHERE draft_id=d.id AND overall_pick=1),'now',extract(epoch FROM clock_timestamp())*1000,'status',d.status,'saved',d.timer_paused_remaining_seconds,'onClockRows',(SELECT count(*) FROM notification_outbox WHERE event_type='draft_on_clock' AND data->>'draftId'=d.id::text)) FROM drafts d WHERE d.id=${quote(draft)}`)
async function tick(job, worker = true) {
  const previous = query("SELECT coalesce(json_agg(invocation_key),'[]') FROM edge_invocations")
  const run=await cronTick(job)
  let response=null
  if (worker) await until(()=>{
    const responses=query(`SELECT coalesce(json_agg(result),'[]') FROM (SELECT e.invocation_key,e.request_id,r.status_code,r.content FROM edge_invocations e JOIN net._http_response r ON r.id=e.request_id WHERE e.function_name='close-expired-nominations' AND e.invocation_key<>ALL(ARRAY[${previous.map(quote).join(',')}]::uuid[]) AND r.status_code=200) result`)
    response=responses[0]??null
    return response!==null
  },'real expiry worker HTTP success')
  return {...run,worker:response}
}
try {
  await startEdge()
  clock('2025-10-30T13:00:00.000Z',true); installed=true
  const running=await fixture(), paused=await fixture();fixtures.push(running,paused)
  for(const f of fixtures) {
    const result=await api(f,'/draft/start-rookie',{leagueId:f.league,rounds:1,timerSeconds:604800,timerExpiryBehavior:'auto_pick'})
    f.draft=result.draft.id
    const initial=state(f.draft)
    assert.equal(initial.deadline,Date.parse('2025-11-06T13:00:00Z'))
    assert.equal(initial.remaining,604800)
    assert.equal(initial.onClockRows,1)
  }
  const initial=state(running.draft)
  clock('2025-10-31T13:00:00.250Z')
  sql(`SELECT pause_draft_atomic(${quote(paused.draft)})`)
  const pausedBefore=state(paused.draft)
  assert.equal(pausedBefore.saved,518400,'Manual pause rounds up the fractional remaining second exactly')
  assert.equal(pausedBefore.deadline,null)
  clock('2025-11-02T05:59:59.000Z')
  const beforeDst=state(running.draft)
  clock('2025-11-02T06:00:01.000Z')
  const afterDst=state(running.draft)
  assert.equal(afterDst.deadline,initial.deadline)
  assert.equal(beforeDst.remaining-afterDst.remaining,2)
  for (const snapshot of [initial,beforeDst,afterDst]) assert.equal(snapshot.remaining,(snapshot.deadline-snapshot.now)/1000)
  for(const zone of ['America/New_York','America/Los_Angeles','UTC']) {
    assert.equal(Number(sql(`SET TIME ZONE ${quote(zone)}; SELECT extract(epoch FROM timer_expires_at)*1000 FROM snake_draft_picks WHERE draft_id=${quote(running.draft)} AND overall_pick=1`)),initial.deadline)
  }
  const job=enableExpiryCron()
  const beforeProcesses=await processes()
  record('restart-before',{beforeProcesses,initial,beforeDst,afterDst,pausedBefore})
  await restart()
  const afterProcesses=await processes()
  assert.notEqual(afterProcesses.db.id,beforeProcesses.db.id)
  assert.notEqual(afterProcesses.db.pid,beforeProcesses.db.pid)
  assert.notEqual(afterProcesses.edge.id,beforeProcesses.edge.id)
  assert.notEqual(afterProcesses.edgeCliPid,beforeProcesses.edgeCliPid)
  const afterRestart=state(running.draft)
  assert.deepEqual(afterRestart,afterDst,'Running absolute deadline and remaining seconds survive real process replacement')
  assert.equal(afterRestart.remaining,(afterRestart.deadline-afterRestart.now)/1000)
  assert.deepEqual(state(paused.draft),{...pausedBefore,now:afterRestart.now})
  sql(`SELECT resume_draft_atomic(${quote(paused.draft)})`)
  const resumed=state(paused.draft)
  assert.equal(resumed.remaining,pausedBefore.saved,'Resume must restore the saved integer, not a fresh seven days')
  assert.equal(resumed.deadline,resumed.now+pausedBefore.saved*1000)
  assert.equal(resumed.onClockRows,1,'Resume and runtime restart do not duplicate the same pick alert')
  record('restart-after',{afterProcesses,afterRestart,resumed})
  if (!process.argv.includes('--state-only')) {
  clock(new Date(initial.deadline-1000).toISOString())
  const early=await tick(job)
  assert.equal(Number(sql(`SELECT count(*) FROM snake_draft_picks WHERE draft_id=${quote(running.draft)} AND player_id IS NOT NULL`)),0,'Real cron never picks early')
  clock(new Date(initial.deadline).toISOString())
  const due=await tick(job)
  await until(()=>Number(sql(`SELECT count(*) FROM snake_draft_picks WHERE draft_id=${quote(running.draft)} AND player_id IS NOT NULL`))===1,'one auto-pick at deadline')
  assert.equal(Number(sql(`SELECT extract(epoch FROM picked_at)*1000 FROM snake_draft_picks WHERE draft_id=${quote(running.draft)} AND overall_pick=1`)),initial.deadline)
  const retry=await tick(job,false)
  assert.equal(Number(sql(`SELECT count(*) FROM draft_audit_logs WHERE draft_id=${quote(running.draft)} AND action='auto_pick' AND metadata->>'reason'='timer_expired'`)),1)
  assert.equal(Number(sql(`SELECT count(*) FROM roster_transactions WHERE league_id=${quote(running.league)} AND transaction_type='draft_won'`)),1)
  const alerts=query(`SELECT json_agg(r ORDER BY overall_pick) FROM (SELECT p.overall_pick,count(o.id) AS count FROM snake_draft_picks p LEFT JOIN notification_outbox o ON o.event_type='draft_on_clock' AND o.data->>'pickId'=p.id::text WHERE p.draft_id=${quote(running.draft)} GROUP BY p.overall_pick) r`)
  assert.deepEqual(alerts,[{overall_pick:1,count:1},{overall_pick:2,count:1}])
  record('restart-cron',{passed:true,provenance:'SYNTHETIC seven-day draft and business clock; native minute cron',early,due,retry,alerts})
  }
} catch(error) { console.error('Primary test failure:',error); throw error } finally {
  cleanup(fixtures)
  if(installed) { restoreClock(); sql('ALTER DATABASE postgres RESET app.supabase_url; ALTER DATABASE postgres RESET app.edge_internal_token;') }
  await stopEdge()
}
