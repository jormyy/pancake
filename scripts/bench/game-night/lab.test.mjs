import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { loopback } from './common.mjs'
import { stateAt, validateSlate, startFeed } from './fixture.mjs'
import { groupStatements, statementDeltas, workCheck } from './measure.mjs'
import { distribution, summarize } from './summary.mjs'
import { qualityGrade, scoreMessage } from './quality-grade.mjs'
import { actionLimits, compareSeries } from './series.mjs'

test('network guard rejects remote hosts and foreign local ports', () => {
  for (const host of ['https://example.com', 'postgres://db.supabase.co:5432/postgres', 'http://127.0.0.1.example.com:38000']) assert.throws(() => loopback(host, [38000]))
  assert.throws(() => loopback('http://127.0.0.1:54321', [38000]))
  assert.equal(loopback('http://127.0.0.1:38000', [38000]).hostname, '127.0.0.1')
})

test('training fixture keeps five live games and a final transition', async () => {
  const slate = JSON.parse(await readFile(new URL('./training.json', import.meta.url), 'utf8'))
  assert.equal(validateSlate(slate), 5)
  assert.equal(stateAt(slate, 0).filter(game => game.gameStatus === 2).length, 5)
  assert.equal(stateAt(slate, 240).filter(game => game.gameStatus === 3).length, 3)
  assert.notDeepEqual(stateAt(slate, 10), stateAt(slate, 0))
  assert.deepEqual(stateAt(slate, 240), stateAt(slate, 1000))
})

test('statement deltas retain duplicate query IDs across roles and sum function costs', () => {
  const row = { queryid: '7', dbid: '1', userid: '1', toplevel: true, query: 'select public.resolve_player_imports_atomic($1)', calls: 2, total_exec_time: 1000, wal_bytes: '10' }
  const other = { ...row, userid: '2', calls: 3, total_exec_time: 2000 }
  const delta = statementDeltas([], [row, other])
  const grouped = groupStatements(delta, 1)
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0].calls, 5)
  assert.equal(grouped[0].execSecondsPerMinute, 3)
  assert.throws(() => statementDeltas([row], [{ ...row, calls: 1 }]))
})

test('work bar fails empty and stale-work-only windows', () => {
  assert.equal(workCheck({ statements: [], observedScoreChanges: 0, workerStarts: 0, cronRuns: 20, minutes: 4 }).passed, false)
  assert.equal(workCheck({ statements: [{ function: 'save_live_game_stats_atomic', calls: 100 }], observedScoreChanges: 0, workerStarts: 5, cronRuns: 20, minutes: 4 }).passed, false)
  assert.equal(workCheck({ statements: [{ function: 'save_live_game_stats_atomic', calls: 100 }], observedScoreChanges: 40, workerStarts: 5, cronRuns: 20, minutes: 4 }).passed, true)
  assert.equal(workCheck({ statements: [{ function: 'save_live_feed_snapshot_atomic', calls: 100 }], observedScoreChanges: 40, workerStarts: 5, cronRuns: 20, minutes: 4 }).passed, true)
})

test('spread reports observed range and sample count', () => {
  assert.deepEqual(distribution([1, 9, 4]), { median: 4, min: 1, max: 9, spread: 8, n: 3 })
})

test('work is accepted under a lower legal cron cadence and fractional elapsed minutes', () => {
  for (const cronRuns of [0, 4]) {
    const result = workCheck({ statements: [{ function: 'save_live_feed_snapshot_atomic', calls: 73 }], observedScoreChanges: 32, workerStarts: 6, cronRuns, minutes: 4.00125 })
    assert.equal(result.passed, true)
  }
})

test('quality gates reject each missing action, slow scores, missing broadcasts, and broken schedules', () => {
  const healthy = {
    actions: { records: ['rosterMove','lineupSave','tradeOffer','tradeAccept','waiverResult'].map(name => ({ name, passed: true, latencyMs: 100, limitMs: 200 })) },
    freshness: { samples: 20, p95Ms: 30000 }, realtime: { subscribed: true, scoreMessages: 10 },
    policies: { injuries: { passed: true }, forecasts: { passed: true } }, requireLimits: true, requirePolicies: true,
    liveForecasts: Array.from({ length: 5 }, () => ({ calculated_at: new Date().toISOString(), valid_until: new Date(Date.now()+3600000).toISOString() })),
  }
  assert.equal(qualityGrade(healthy).passed, true)
  for (const record of healthy.actions.records) {
    const changed = structuredClone(healthy)
    changed.actions.records.find(row => row.name === record.name).passed = false
    assert.equal(qualityGrade(changed).gates[record.name].passed, false)
    assert.equal(qualityGrade(changed).passed, false)
  }
  for (const change of [
    value => { value.freshness.p95Ms = 45001 },
    value => { value.freshness.samples = 0 },
    value => { value.realtime.scoreMessages = 0 },
    value => { value.policies.injuries.passed = false },
    value => { value.policies.forecasts.passed = false },
    value => { value.actions.records[0].limitMs = null },
    value => { value.liveForecasts.pop() },
    value => { value.liveForecasts[0].calculated_at = new Date(Date.now()-1800001).toISOString() },
  ]) {
    const changed = structuredClone(healthy)
    change(changed)
    assert.equal(qualityGrade(changed).passed, false)
  }
})

test('score broadcast gate excludes unrelated action and health messages', () => {
  assert.equal(scoreMessage({ payload: { topic: 'score', sources: ['matchups'] } }), true)
  assert.equal(scoreMessage({ payload: { topic: 'roster', sources: ['roster_players'] } }), false)
  assert.equal(scoreMessage({ payload: { status: 'SUBSCRIBED' } }), false)
})

test('action limits require three observed successful baseline actions', () => {
  const reports = [100,105,110].map(latencyMs => ({ actionResults: { records: ['rosterMove','lineupSave','tradeOffer','tradeAccept','waiverResult'].map(name => ({ name, passed: true, latencyMs })) } }))
  assert.equal(actionLimits(reports).waiverResult, 120)
  assert.throws(() => actionLimits(reports.slice(0,2)))
  reports[1].actionResults.records[0].passed = false
  assert.throws(() => actionLimits(reports))
})

test('a paired comparison rejects host pressure, changed fixtures, and changed caps', () => {
  const report = (pages, source) => ({
    passed: true, source, fixtureSha256: 'fixture', harnessSha256: 'harness', memoryMiB: 192, label: source, seconds: 240,
    resources: {version:'game-night-cgroup-v1',hostMemory:{passed:true}}, runtimeConfiguration: {}, swap: { inPagesPerSecond: pages / 2, outPagesPerSecond: pages / 2, cgroupAnonRefaultsPerSecond: pages, cgroupSwapPeakBytes: 1000, foreignContainerActivityObserved: false },
    memory: { majorFaults: 0, cgroupAnonPeakBytes: 1000, cgroupShmemPeakBytes: 1000 },
    walBytesPerMinute: 0, newSessionsPerMinute: 1, cronRunsPerMinute: 1, scoreFreshness: { p95Ms: 30000 },
    workCounts: { passed: true }, statementExecSecondsPerMinuteByFunction: [], workerRunsPerHourByKind: {},
    quality: { passed: true, gates: { injuries: { passed: true }, forecasts: { passed: true } } },
    actionResults: { records: ['rosterMove','lineupSave','tradeOffer','tradeAccept','waiverResult'].map(name => ({ name, passed: true, latencyMs: 10 })) },
  })
  const baseline = Array.from({ length: 3 }, () => report(2000, 'base'))
  const candidate = Array.from({ length: 3 }, () => report(50, 'candidate'))
  assert.equal(compareSeries(baseline, candidate).passed, true)
  assert.equal(compareSeries(baseline,candidate,{targetCeiling:35}).passed,false)
  assert.equal(compareSeries(baseline,candidate,{targetCeiling:35}).targetPagesPerSecond,35)
  assert.equal(compareSeries(baseline,candidate,{targetCeiling:100}).targetPagesPerSecond,61)
  assert.throws(()=>compareSeries(baseline,candidate,{targetCeiling:0}))
  const failedReference=structuredClone(baseline)
  failedReference[0].passed=false
  failedReference[0].finalState={passed:false,failures:[{field:'points'}]}
  failedReference[0].failures={jobs:[{kind:'refresh-views'}]}
  assert.throws(()=>summarize(failedReference))
  assert.throws(()=>compareSeries(failedReference,candidate))
  const failedCandidate=structuredClone(candidate)
  failedCandidate[0].passed=false
  assert.throws(()=>compareSeries(failedReference,failedCandidate))
  failedReference[0].containerWatch={passed:false}
  assert.throws(()=>compareSeries(failedReference,candidate))
  delete failedReference[0].containerWatch
  failedReference[0].workCounts.passed=false
  assert.throws(()=>compareSeries(failedReference,candidate))
  const lowerReference=baseline.map(row=>({...row,swap:{...row.swap,cgroupAnonRefaultsPerSecond:500}}))
  assert.equal(compareSeries(lowerReference,candidate).trainingTarget,false)
  for (const change of [
    row => { row.resources.hostMemory.passed = false },
    row => { row.resources.version = 'old' },
    row => { row.fixtureSha256 = 'different' },
    row => { row.memoryMiB = 193 },
  ]) {
    const changed = structuredClone(candidate)
    change(changed[0])
    assert.throws(() => compareSeries(baseline, changed))
  }
})


test('settlement republishes the fixed slate without inventing new stat changes',async()=>{
  const slate=JSON.parse(await readFile(new URL('./training.json',import.meta.url),'utf8'))
  const feed=await startFeed({ports:{feed:0}},slate,new Date().toISOString())
  try {
    feed.start(Date.now()-600000)
    feed.freeze(240)
    const first=await fetch(feed.origin+'/static/json/liveData/scoreboard/todaysScoreboard_00.json').then(r=>r.json())
    assert.ok(Date.now()-Date.parse(first.meta.time)<1000)
    assert.deepEqual(first.scoreboard.games.map(game=>game.homeTeam),stateAt(slate,240).map(game=>game.homeTeam))
    const second=await fetch(feed.origin+'/static/json/liveData/scoreboard/todaysScoreboard_00.json').then(r=>r.json())
    assert.deepEqual(second.scoreboard.games,first.scoreboard.games)
  }finally {await feed.close()}
})
