import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { command, delay, digest, directory, id, json, readJson, repository } from './common.mjs'
import { seedSlate, startFeed, stateAt, validateSlate } from './fixture.mjs'
import { startWorkers } from './workers.mjs'
import { memoryContexts, processMemory } from './process-memory.mjs'
import { prepareActions, startActions } from './quality.mjs'
import { qualityGrade } from './quality-grade.mjs'
import { startPublicFeed } from './public-runtime.mjs'
import { startPhones } from './phones.mjs'
import { phoneGrade } from './phone-grade.mjs'
import { checkpointGrade } from './checkpoint-grade.mjs'
import { projectBudget } from './budget.mjs'
import { counters, fantasyAt, finalCheck, finalGameCheck, graderVersion, groupStatements, percentile, readFantasy, readScores, snapshot, statementDeltas, workCheck } from './measure.mjs'

export async function prepare(stack, slate, label) {
  await stack.sql("ALTER SYSTEM SET cron.launch_active_jobs='off'; SELECT pg_reload_conf();")
  await command('docker', ['update', '--memory=512m', '--memory-swap=1536m', stack.container])
  await stack.sql(await readFile(path.join(directory, 'seed.sql'), 'utf8'))
  const migration = await readFile(path.join(stack.sourceRoot, 'supabase/migrations/20261024100002_live_player_season_totals.sql'), 'utf8')
  await stack.sql(migration.match(/INSERT INTO analytics\.player_season_totals[\s\S]*?;/)[0])
  await stack.sql("UPDATE private.worker_controls SET paused=false,scheduler_level='normal',scheduler_checked_at=NULL,scheduler_healthy_since=NULL,scheduler_last_dispatch_at=NULL,scheduler_health=NULL; TRUNCATE private.scheduler_health_log; UPDATE public.scheduler_health_hint SET level='normal';")
  const anchor = new Date().toISOString()
  await seedSlate(stack, slate, anchor)
  await stack.sql(await readFile(path.join(directory, 'history.sql'), 'utf8'))
  if (stack.qualityEnabled) await prepareActions(stack)
  for (let batch = 0; batch < 100; batch++) {
    if (Number(await stack.sql('SELECT pg_database_size(current_database())')) >= 263000000) break
    await stack.sql(`INSERT INTO public.league_activity(league_id,league_season_id,actor_member_id,event_type,title,body,created_at)
      SELECT game_night.id(1),game_night.id(2),game_night.id(201),'game-night-fixture','Synthetic historical event '||n,
      (SELECT string_agg(md5(n::text||':'||k::text),'') FROM generate_series(1,40)k),now()-interval '180 days'-n*interval '1 minute'
      FROM generate_series(${batch * 1000 + 1},${batch * 1000 + 1000})n;`)
  }
  await stack.sql('ANALYZE public.player_game_stats; ANALYZE analytics.player_season_totals; ANALYZE public.league_activity;')
  await stack.sql('SELECT extensions.pg_stat_statements_reset();')
  const shape = JSON.parse(await stack.sql("SELECT json_build_object('players',(SELECT count(*) FROM public.players),'teams',(SELECT count(*) FROM public.league_members),'stats',(SELECT count(*) FROM public.player_game_stats),'databaseBytes',pg_database_size(current_database()),'tables',(SELECT json_agg(t) FROM (SELECT schemaname,relname,pg_total_relation_size(relid) bytes,n_live_tup FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 25)t))"))
  assert.equal(Number(shape.players), 2600)
  assert.equal(Number(shape.teams), 10)
  assert.equal(Number(shape.stats), 246000)
  shape.priorProviderWork = JSON.parse(await stack.sql("SELECT coalesce(json_agg(w),'[]') FROM (SELECT kind,key,status,payload FROM private.work_items WHERE payload->>'gameNightSyntheticHistory'='true')w"))
  await json(path.join(stack.evidence, `${label}-shape.json`), shape)
  await stack.resetObserver()
  const feed = await startFeed(stack, slate, anchor)
  return { feed, shape, anchor }
}

export async function runWindow(stack, slate, { label, memoryMiB, seconds = slate.windowSeconds, warmup = 120, ingestionOff = false, broken = false }) {
  const harness = Object.fromEntries(await Promise.all((await readdir(directory)).filter(file => !file.startsWith('.')).map(async file => [file, digest(await readFile(path.join(directory, file)))])))
  for (const file of ['server/live/handler.ts','server/live/snapshot.ts','core/cjs/index.js','core/cjs/scoring/formula.js','core/cjs/live/overlay.js','core/cjs/live/poll.js','core/cjs/live/codec.js','core/cjs/live/recovery.js',
    'vitest.config.ts','tests/live-phone-recovery.test.ts',
    'supabase/functions/_shared/nba.ts','supabase/functions/_shared/workContext.ts','supabase/functions/_shared/sourceEnvironment.ts',
    'supabase/functions/_shared/liveSourceChoice.ts','supabase/functions/live-poll/espn.ts']) {
    harness[`source:${file}`] = digest(await readFile(path.resolve(directory,'../../..',file)))
  }
  await json(path.join(stack.evidence, `${label}-harness.json`), harness)
  let phoneBehavior = null
  if(stack.phoneLab) {
    const file=path.join(stack.evidence,`${label}-phone-behavior.json`)
    await command(process.execPath,[path.join(repository,'node_modules/vitest/vitest.mjs'),'run','tests/live-phone-recovery.test.ts','--reporter=json',`--outputFile=${file}`])
    const result=await readJson(file)
    phoneBehavior={passed:result.success && result.numPassedTests===3,tests:result.numPassedTests,clock:'controlled clock; real route, cache, poller, and overlay',file}
    assert.ok(phoneBehavior.passed,'Phone recovery behavior fails before replay')
  }
  console.log(`${label}: preparing synthetic data.`)
  const prepared = await prepare(stack, slate, label)
  let workers, publicFeed, phones
  stack.setRuntimeClose(async () => { await workers?.close(); await phones?.close(); await publicFeed?.close(); await prepared.feed.close() })
  try {
    if (stack.phoneLab) publicFeed = await startPublicFeed(stack,label)
    workers = await startWorkers(stack, label, ingestionOff)
    if (stack.phoneLab) phones = await startPhones(stack,publicFeed)
    await command('docker', ['update', `--memory=${memoryMiB}m`, '--memory-swap=1536m', stack.container])
    await stack.sql("ALTER SYSTEM SET cron.launch_active_jobs='on'; SELECT pg_reload_conf();")
    const warmupMs = seconds < 120 ? warmup * 1000 : (Math.floor(Date.now() / 120000) + 1) * 120000 + 115000 - Date.now()
    console.log(`${label}: warming the real scheduled workers for ${Math.round(warmupMs / 1000)} seconds.`)
    const readyAt = Date.now() + warmupMs
    const policies = {}
    if (stack.policyChecks) {
      await delay(Math.max(0, readyAt - 70000 - Date.now()))
      for (const name of ['injuries','forecasts']) {
        const result = await stack.sqlFile(path.join(directory, `quality-${name}.sql`), { allowFailure: true, output: path.join(stack.evidence, `${label}-policy-${name}.log`) })
        policies[name] = { passed: result.code === 0, exitCode: result.code }
      }
    }
    await delay(Math.max(0, readyAt - Date.now()))
    const realtimeBefore = await fetch(`http://127.0.0.1:${stack.ports.edge}/health`).then(response => response.json())
    const before = await snapshot(stack)
    const checkpoints = () => stack.sql("SELECT coalesce(json_agg(row),'[]') FROM (SELECT game.id,game.status,state.checkpoint_at FROM public.nba_games game LEFT JOIN private.live_poll_game_state state ON state.game_id=game.id WHERE game.nba_game_id LIKE '00299%')row").then(JSON.parse)
    const checkpointBefore = stack.liveArchitecture ? await checkpoints() : null
    const publicBefore = publicFeed ? await publicFeed.health() : null
    const databaseSettings = JSON.parse(await stack.sql("SELECT jsonb_object_agg(name,jsonb_build_object('value',setting,'unit',unit,'source',source,'pendingRestart',pending_restart)) FROM pg_settings WHERE name IN('shared_buffers','wal_buffers','work_mem','hash_mem_multiplier','maintenance_work_mem','autovacuum_work_mem','max_connections','autovacuum_max_workers','checkpoint_timeout','max_wal_size','min_wal_size','huge_pages','jit')"))
    const samples = [await counters(stack)]
    const processSamples = [await processMemory(stack)]
    const contextSamples = stack.profileMemory ? [await memoryContexts(stack)] : []
    const started = Date.now()
    prepared.feed.start(started)
    const actions = stack.qualityEnabled ? startActions(stack, started, stack.qualityOptions) : null
    const freshness = []
    const fantasyFreshness = []
    const seenFantasy = new Set()
    const seen = new Set()
    let observedScoreChanges = 0
    let lastScores = await readScores(stack)
    const finalGameChecks=[]
    const observeFinals=async(scores,at)=>{
      if(!stack.phoneLab)return
      const elapsed=(at-started)/1000
      for(const game of stateAt(slate,elapsed).filter(game=>game.gameStatus===3)) {
        if(finalGameChecks.some(check=>check.gameId===game.id))continue
        const actual=scores.find(row=>row.id===game.id)
        if(actual?.status!=='Final' || !actual.stats_synced_at)continue
        const expectedAt=started+Math.max(0,(game.startMinute+game.durationMinutes-slate.windowStartMinute)*60000)
        const check=await finalGameCheck(stack,slate,elapsed,[game.id])
        finalGameChecks.push({gameId:game.id,expectedAt,observedAt:at,passed:check.passed && at-expectedAt<=45000,check})
      }
    }
    const connectionSamples = []
    console.log(`${label}: measuring ${seconds} real seconds at ${memoryMiB} MiB.`)
    while (Date.now() < started + seconds * 1000) {
      await delay(Math.min(5000, Math.max(1, started + seconds * 1000 - Date.now())))
      const sample = await counters(stack)
      samples.push(sample)
      processSamples.push(await processMemory(stack))
      if (stack.profileMemory && processSamples.length % 12 === 0) contextSamples.push(await memoryContexts(stack))
      const scores = await readScores(stack)
      await observeFinals(scores,Date.now())
      const elapsed = (Date.now() - started) / 1000
      const fantasy = await readFantasy(stack)
      const revision = Math.max(...stateAt(slate, elapsed).map(game => game.revision))
      for (const expected of fantasyAt(slate, elapsed)) {
        const actual = fantasy.find(row => row.home_member_id === expected.home_member_id)
        const key = `${expected.home_member_id}:${revision}`
        if (revision > 0 && !seenFantasy.has(key) && Number(actual?.home_points) === expected.home_points && Number(actual?.away_points) === expected.away_points) {
          fantasyFreshness.push(Date.now() - (started + (10 + (revision - 1) * 20) * 1000))
          seenFantasy.add(key)
        }
      }
      for (const expected of stateAt(slate, elapsed)) {
        const actual = scores.find(row => row.id === expected.id)
        const previous = lastScores.find(row => row.id === expected.id)
        if (actual && previous && (actual.home_score !== previous.home_score || actual.away_score !== previous.away_score)) observedScoreChanges++
        const key = `${expected.id}:${expected.revision}`
        if (expected.revision > 0 && !seen.has(key) && actual?.home_score === expected.homeTeam.score && actual?.away_score === expected.awayTeam.score) {
          freshness.push({ game: expected.nba_game_id, revision: expected.revision, milliseconds: Date.now() - (started + (10 + (expected.revision - 1) * 20) * 1000) })
          seen.add(key)
        }
      }
      lastScores = scores
      connectionSamples.push({ at: Date.now(), clients: JSON.parse(await stack.sql("SELECT coalesce(json_agg(c),'[]') FROM (SELECT application_name,usename,client_addr::text,backend_type,count(*) FROM pg_stat_activity GROUP BY 1,2,3,4)c")) })
    }
    const ended = Date.now()
    prepared.feed.freeze(seconds)
    if (stack.qualityOptions?.fault?.split(',').includes('forecastDelivery')) await stack.sql(`DELETE FROM public.matchup_forecasts WHERE matchup_id=(SELECT id FROM public.matchups WHERE league_id='${id(1)}' AND week_number=2 ORDER BY id LIMIT 1)`)
    const after = await snapshot(stack)
    const checkpointAfter = stack.liveArchitecture ? await checkpoints() : null
    const publicAfter = publicFeed ? await publicFeed.health() : null
    const realtimeAfter = await fetch(`http://127.0.0.1:${stack.ports.edge}/health`).then(response => response.json())
    let settlementSeconds = 0
    if (stack.liveArchitecture) {
      const settlementStarted = Date.now()
      while (Date.now()-settlementStarted < 1920000) {
        await observeFinals(await readScores(stack),Date.now())
        if ((await finalCheck(stack,slate,seconds)).passed) break
        await delay(5000)
      }
      settlementSeconds = (Date.now()-settlementStarted)/1000
    }
    await stack.sql("ALTER SYSTEM SET cron.launch_active_jobs='off'; SELECT pg_reload_conf();")
    const drainStarted = Date.now()
    let health
    do {
      health = await fetch(`http://127.0.0.1:${stack.ports.edge}/health`).then(response => response.json())
      if (!health.active) break
      await delay(1000)
    } while (Date.now() - drainStarted < 125000)
    assert.equal(health.active, 0, 'Real workers do not drain before cleanup')
    const qualityState = stack.liveArchitecture ? await snapshot(stack) : after
    if (broken) await stack.sql(`DELETE FROM public.player_game_stats WHERE game_id='${id(800003)}' AND player_id='${id(1081)}';`)
    const check = await finalCheck(stack, slate, seconds)
    await observeFinals(await readScores(stack),Date.now())
    await phones?.refresh()
    const phoneResults = phones ? phoneGrade({ slate,started,ended,renders:phones.renders,phones:phones.snapshot(),requests:phones.requests,reads:phones.reads,messages:phones.messages,
      frames:phones.frames,finalGameChecks,architecture:Boolean(stack.liveArchitecture) }) : null
    if(phones)await json(path.join(stack.evidence,`${label}-phone-frames.json`),phones.frames)
    const actionResults = actions ? await actions.done : null
    const minutes = (ended - started) / 60000
    const statements = statementDeltas(before.statements, after.statements)
    assert.equal(before.statementInfo.stats_reset, after.statementInfo.stats_reset, 'Statement counters reset during the window')
    const functions = groupStatements(statements, minutes)
    const startOf = value => Date.parse(value)
    const inWindow = value => startOf(value) >= started && startOf(value) < ended
    const cron = after.cron.filter(row => inWindow(row.start_time))
    const invocations = after.invocations.filter(row => inWindow(row.worker_started_at))
    const edgeRequests = (await readFile(workers.receipts,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
      .filter(row=>row.start>=started && row.start<ended)
    const runs = Object.fromEntries([...new Set(invocations.map(row => row.kind))].map(kind => [kind, invocations.filter(row => row.kind === kind).length]))
    let work = workCheck({ statements, observedScoreChanges, workerStarts: invocations.length, cronRuns: cron.length, minutes })
    const publicResults = publicAfter ? {requests:publicAfter.counters.requests-publicBefore.counters.requests,
      origins:publicAfter.records.filter(row=>row.at>=started && row.at<ended),memory:publicAfter.memory,
      bodyBytes:publicAfter.records.filter(row=>row.at>=started && row.at<ended).map(row=>row.bytes)} : null
    if (stack.liveArchitecture) work = checkpointGrade({slate,before:checkpointBefore,after:checkpointAfter,started,ended,
      intervalMs:1800000,work,origins:publicResults.origins.length,phonePolls:phoneResults.pollCount})
    const first = samples[0], last = samples.at(-1)
    const elapsed = (last.at - first.at) / 1000
    const failures = { cron: qualityState.cron.filter(row => row.status === 'failed'), jobs: qualityState.work.filter(row => ['failed','dead'].includes(row.status)), workers: qualityState.invocations.filter(row => row.worker_status === 'failed') }
    const report = { version: 1, grader: { version: stack.liveArchitecture ? 'game-night-v5' : graderVersion, sha256: digest(JSON.stringify([harness['measure.mjs'],harness['checkpoint-grade.mjs'],harness['phone-grade.mjs']])) }, harnessSha256: digest(JSON.stringify(harness)), label, slate: slate.name, fixtureSha256: harness[`${slate.name}.json`], source: stack.metadata.source,
      startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), seconds: (ended - started) / 1000, warmupSeconds: warmupMs / 1000, memoryMiB, databaseSettings, runtimeConfiguration: stack.runtimeConfiguration ?? {},
      shape: prepared.shape, databaseGrowth:{before:before.storage,after:after.storage,bytes:after.storage.databaseBytes-before.storage.databaseBytes,bytesPerMinute:(after.storage.databaseBytes-before.storage.databaseBytes)/minutes,scope:'timed real PostgreSQL database growth; includes index and reusable-page allocation, not only new user rows'}, clock: 'native real time; fixture changes every 20 seconds; no accelerated jobs', observer: 'Seeding session closes before warmup; the measurement session keeps no seed plans',
      swap: { source: 'Linux Docker VM /proc/vmstat pswpin/pswpout; global to the VM, not per-cgroup', pageBytes: 4096, inPagesPerSecond: (last.vm.pswpin - first.vm.pswpin) / elapsed, outPagesPerSecond: (last.vm.pswpout - first.vm.pswpout) / elapsed, available: last.swaps.length > 0, cgroupSwapPeakBytes: Math.max(...samples.map(row => row.swapCurrent)), foreignContainerActivityObserved: samples.some(row => row.foreignContainers.length > 0), cgroupAnonRefaultsPerSecond: (last.cgroup.workingset_refault_anon - first.cgroup.workingset_refault_anon) / elapsed },
      memory: { cgroupAnonPeakBytes: Math.max(...samples.map(row => row.cgroup.anon)), cgroupShmemPeakBytes: Math.max(...samples.map(row => row.cgroup.shmem)), sampleIntervalSeconds: 5, containerLifetimePeakBytes: last.peak, oomKills: (last.events.oom_kill ?? 0) - (first.events.oom_kill ?? 0), majorFaults: last.cgroup.pgmajfault - first.cgroup.pgmajfault },
      diskIo: {source:'database cgroup io.stat, summed device counters',readsPerSecond:(last.io.rios-first.io.rios)/elapsed,writesPerSecond:(last.io.wios-first.io.wios)/elapsed,
        readBytesPerSecond:(last.io.rbytes-first.io.rbytes)/elapsed,writeBytesPerSecond:(last.io.wbytes-first.io.wbytes)/elapsed},
      statementExecSecondsPerMinuteByFunction: functions, statements, functionCounters: { before: before.functions, after: after.functions },
      walBytesPerMinute: (Number(after.wal.wal_bytes) - Number(before.wal.wal_bytes)) / minutes,
      newSessionsPerMinute: (Number(after.database.sessions) - Number(before.database.sessions)) / minutes,
      cronRunsPerMinute: cron.length / minutes, cron, workerRunsPerHourByKind: Object.fromEntries(Object.entries(runs).map(([kind, count]) => [kind, count / minutes * 60])),
      workerCounts: runs, workCounts: work, connectionsByClient: connectionSamples,
      edgeRequestCount:edgeRequests.length,edgeRequests,
      providerTransfer:{source:'synthetic provider response bodies inside the timed window',requests:prepared.feed.requests.filter(row=>row.at>=started && row.at<ended),bytes:prepared.feed.requests.filter(row=>row.at>=started && row.at<ended).reduce((sum,row)=>sum+row.bytes,0)},
      workerDataTransfer: {source:'API response bodies observed by the local Edge runtime; no header or TLS bytes',
        requests:(realtimeAfter.transfers ?? []).filter(row=>row.at>=started && row.at<ended)},
      realtime: { subscribed: realtimeBefore.realtimeStatus === 'SUBSCRIBED', messages: realtimeAfter.realtimeMessages - realtimeBefore.realtimeMessages, scoreMessages: realtimeAfter.realtimeScoreMessages - realtimeBefore.realtimeScoreMessages, clientCount: 1 },
      drainSeconds: (Date.now() - drainStarted) / 1000,
      scoreFreshness: { p50Ms: percentile(freshness.map(row => row.milliseconds), .5), p95Ms: percentile(freshness.map(row => row.milliseconds), .95), samples: freshness.length, resolutionMs: 5000, observations: freshness, fantasyP50Ms: percentile(fantasyFreshness, .5), fantasyP95Ms: percentile(fantasyFreshness, .95), fantasySamples: fantasyFreshness.length },
      finalState: check, settlementSeconds, publicFeed:publicResults,phones:phoneResults,phoneBehavior,actionResults, failures, deadWorkItems: failures.jobs.filter(row => row.status === 'dead'),
      passed: check.passed && work.passed && (!phoneResults || phoneResults.passed) && (!actionResults || actionResults.passed) && !Object.values(failures).some(rows => rows.length) && last.events.oom_kill === first.events.oom_kill,
      control: broken ? 'delete one stored final stat' : ingestionOff ? 'live ingestion disabled at worker boundary' : stack.qualityOptions?.fault ?? null,
      processSamples, contextSamples, observations: samples, feedRequests: prepared.feed.requests, before, after }
    if (stack.qualityEnabled) {
      const freshness = stack.liveArchitecture ? phoneResults.gates.freshness : report.scoreFreshness
      report.quality = qualityGrade({ actions: actionResults, freshness, realtime: report.realtime, policies, liveForecasts: after.liveForecasts, observedAt: ended, requireLimits: Boolean(stack.qualityOptions?.limits), requirePolicies: Boolean(stack.policyChecks) })
      report.quality.gates.scoreFreshness.source = stack.liveArchitecture ? 'ten phones' : 'stored scores'
      report.passed &&= report.quality.passed
    }
    report.projectedBudget = projectBudget(report)
    await json(path.join(stack.evidence, `${label}.json`), report)
    console.log(`${label}: final=${check.passed}, work=${work.passed}, swap=${report.swap.inPagesPerSecond.toFixed(1)}/${report.swap.outPagesPerSecond.toFixed(1)} pages/s.`)
    return report
  } catch (error) {
    await json(path.join(stack.evidence, `${label}.json`), { label, memoryMiB, passed: false, error: error.message, at: new Date().toISOString() })
    throw error
  } finally {
    await stack.sql("ALTER SYSTEM SET cron.launch_active_jobs='off'; SELECT pg_reload_conf();").catch(() => {})
    await workers?.close()
    await phones?.close()
    await publicFeed?.close()
    await prepared.feed.close()
    stack.setRuntimeClose(null)
  }
}

export async function experiment(stack, phase = 'all') {
  const files = (await readdir(directory)).sort()
  await json(path.join(stack.evidence, 'harness.json'), { files: Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(path.join(directory, file)))]))), source: stack.metadata.source })
  const training = await readJson(path.join(directory, 'training.json'))
  validateSlate(training)
  if (phase === 'smoke') return runWindow(stack, training, { label: 'smoke', memoryMiB: 512, seconds: 40, warmup: 125 })
  if (phase === 'baseline') {
    const calibration = await readJson(path.join(stack.evidence, 'calibration.json'))
    const broken = await readJson(path.join(stack.evidence, 'control-broken-final.json'))
    const off = await readJson(path.join(stack.evidence, 'control-ingestion-off.json'))
    assert.equal(broken.finalState.passed, false)
    assert.equal(off.workCounts.passed, false)
    return baselineSeries(stack, training, calibration.selectedMemoryMiB)
  }
  const calibration = []
  for (const memoryMiB of [384, 192, 96, 64]) {
    const report = await runWindow(stack, training, { label: `calibration-${memoryMiB}`, memoryMiB, seconds: 120 })
    calibration.push(report)
    if (report.swap.inPagesPerSecond >= 600 && report.swap.inPagesPerSecond <= 1400 && report.swap.outPagesPerSecond >= 600 && report.swap.outPagesPerSecond <= 1400) break
  }
  const healthy = calibration.filter(report => report.workCounts.passed && !report.memory.oomKills && !Object.values(report.failures).some(rows => rows.length))
  assert.ok(healthy.length, 'No calibration run performs real work without errors')
  const error = report => Math.abs(report.swap.inPagesPerSecond - 1000) + Math.abs(report.swap.outPagesPerSecond - 1000)
  const swapping = healthy.filter(report => report.swap.cgroupSwapPeakBytes > 0)
  const chosen = [...(swapping.length ? swapping : healthy)].sort((a, b) => error(a) - error(b))[0]
  const nearTarget = error(chosen) <= 800 && !chosen.swap.foreignContainerActivityObserved
  await json(path.join(stack.evidence, 'calibration.json'), { target: { inPagesPerSecond: 1000, outPagesPerSecond: 1000 }, selectedMemoryMiB: chosen.memoryMiB, nearTarget, rateMatch: error(chosen) <= 800, runs: calibration.map(report => ({ label: report.label, memoryMiB: report.memoryMiB, swap: report.swap, work: report.workCounts, failures: report.failures })), limitation: nearTarget ? null : 'The host cannot show isolated production-equivalent swap traffic at the tested caps. VM counters include other containers. Use cgroup anonymous refaults, major faults, swap occupancy, and memory peaks as the closest per-database measures. Keep VM swap rates as contextual evidence.' })
  const broken = await runWindow(stack, training, { label: 'control-broken-final', memoryMiB: chosen.memoryMiB, broken: true })
  assert.equal(broken.finalState.passed, false, 'Broken final stat must fail')
  const off = await runWindow(stack, training, { label: 'control-ingestion-off', memoryMiB: chosen.memoryMiB, ingestionOff: true, seconds: 120 })
  assert.equal(off.workCounts.passed, false, 'Disabled ingestion must fail the work gate')
  return baselineSeries(stack, training, chosen.memoryMiB)
}

async function baselineSeries(stack, training, memoryMiB) {
  const baselines = []
  for (let n = 1; n <= 3; n++) {
    const report = await runWindow(stack, training, { label: `baseline-${n}`, memoryMiB })
    assert.ok(report.passed, `Baseline ${n} fails its quality bar`)
    baselines.push(report)
  }
  const { summarize, hypotheses } = await import('./summary.mjs')
  const summary = summarize(baselines)
  await json(path.join(stack.evidence, 'baseline-summary.json'), summary)
  await hypotheses(stack.evidence, summary)
  const heldout = await readJson(path.join(directory, 'held-out.json'))
  validateSlate(heldout)
  const heldoutReport = await runWindow(stack, heldout, { label: 'held-out-baseline', memoryMiB })
  assert.ok(heldoutReport.passed, 'Held-out baseline fails its quality bar')
}
