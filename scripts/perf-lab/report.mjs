import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentDataClasses, editorContext, analyzerContext } from './data-flow-contracts.mjs'
import { digest, sourceRoot, json } from './common.mjs'
import { evidenceFailures, inventory } from './workloads.mjs'
import { trafficBreakdown, rankTraffic } from './traffic.mjs'
import { controlContract, leafControls } from './interactions.mjs'
import { clockRuntime, replayRuntime } from './replay-runtime.mjs'
import { captureCohort } from './cohort.mjs'
import { emptyPlan } from './empty.mjs'
import { retainedReplay } from './replay-evidence.mjs'
import { screenBaseline, screenBaselineLines } from './screen-baseline.mjs'

const cell = value => String(value ?? 'unmeasured').replaceAll('|', '\\|').replaceAll('\n', ' ')

export function controlLabelMatches(kind, template, observed) {
  if (kind === 'tapPrefix') return observed.startsWith(template)
  const source = template.split(/\{\{[^}]+\}\}/g).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+')
  return new RegExp(`^${source}$`).test(observed)
}

export function sameControlSurface(first, second) {
  const normalize = value => {
    const url = new URL(value.replace(/\{\{[^}]+\}\}|:[a-zA-Z]+/g, ':parameter'), 'http://localhost')
    const defaults = { '/players': ['section', 'players'], '/trades': ['tab', 'offers'] }
    const entry = defaults[url.pathname]
    if (entry && url.searchParams.get(entry[0]) === entry[1]) url.searchParams.delete(entry[0])
    return url.pathname + url.search
  }
  return normalize(first) === normalize(second)
}

export function sequenceControlProved(control, proof) {
  return proof?.passed === true && control.actionCompleted !== false && (control.expectedReached === true || control.actionCompleted === true)
    && ['requests', 'bytesDown', 'resultsMs', 'dbMs', 'dbCalls', 'dbRows', 'dbBuffers', 'renderMutations'].every(key => Number.isFinite(control[key]))
}

export function rankCosts(observations) {
  if (observations.some(row => !Number.isFinite(row.dbMs) || row.dbMs < 0 || !Number.isFinite(row.frequency) || row.frequency < 0)) throw new Error('Cost ranking requires measured duration and frequency')
  return observations.map(row => ({ ...row, costPerOccurrence: row.dbMs, weightedDbMs: row.dbMs * row.frequency }))
    .sort((a, b) => b.weightedDbMs - a.weightedDbMs || a.id.localeCompare(b.id))
}

function sourceControls(work) {
  const routes = new Map()
  for (const scenario of work.scenarios) {
    let route = scenario.from
    const record = (action, prefix) => {
      for (const control of leafControls(action)) {
        routes.set(`${prefix}/${control.path}`, route)
        if (control.kind === 'open') route = control.action.open
      }
    }
    for (const [index, action] of (scenario.prepare ?? []).entries()) record(action, `${scenario.name}/prepare/${index}`)
    for (const [index, step] of scenario.steps.entries()) {
      record(step.action, `${scenario.name}/${index}`)
      route = step.expected?.route ?? route
    }
  }
  return work.controls.map(control => ({ ...control, route: routes.get(control.id) ?? control.route }))
}

export async function verifyArtifacts(evidence, root) {
  const failures = []
  for (const [engine, proof] of Object.entries(evidence)) {
    if (!['webkit', 'ios-pwa'].includes(engine)) continue
    for (const key of ['har', 'firstScreenshot', 'settledScreenshot', 'dbEvidence', 'cacheEvidence', 'pushEvidence']) {
      const relative = proof[key]
      if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) { failures.push(`${engine} unsafe ${key}`); continue }
      const bytes = await readFile(path.join(root, relative)).catch(() => null)
      if (!bytes?.length || digest(bytes) !== proof.hashes?.[key]) failures.push(`${engine} missing or changed ${key}`)
      else if (key.endsWith('Screenshot') && bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') failures.push(`${engine} invalid PNG`)
      else if (key === 'har') {
        try {
          const har = JSON.parse(bytes.toString())
          if (har.log?.version !== '1.2' || !Array.isArray(har.log.entries)) failures.push(`${engine} invalid HAR`)
          if (!/WebInspector|Safari|Playwright/i.test(har.log?.creator?.name ?? '')) failures.push(`${engine} HAR creator is not recognized`)
        } catch { failures.push(`${engine} invalid HAR`) }
      }
    }
  }
  return failures
}


export async function accumulatedReceipts(evidenceRoot, current, fingerprint) {
  if (!evidenceRoot) return current
  const result = new Map()
  const history = path.join(evidenceRoot, 'history')
  for (const run of (await readdir(history).catch(() => [])).sort()) {
    if (!/^[a-f0-9-]{36}$/.test(run)) continue
    const rows = JSON.parse(await readFile(path.join(history, run, 'walk.json'), 'utf8').catch(() => '[]'))
    for (const row of rows.filter(row => row.fingerprint === fingerprint)) {
      const copy = structuredClone(row)
      for (const engine of ['webkit', 'ios-pwa']) if (copy[engine]) {
        for (const key of ['har', 'firstScreenshot', 'settledScreenshot', 'dbEvidence', 'cacheEvidence', 'pushEvidence']) {
          if (copy[engine][key]) copy[engine][key] = `history/${run}/${copy[engine][key]}`
        }
      }
      result.set(row.id, copy)
    }
  }
  for (const row of current.filter(row => row.fingerprint === fingerprint)) result.set(row.id, row)
  return [...result.values()]
}

export async function renderReport(options) {
  const { root = sourceRoot, evidenceRoot, receipts: currentReceipts = [], writeDocs = true } = options ?? {}
  let simulation = options?.simulation ?? null
  const captureReceipt = evidenceRoot ? JSON.parse(await readFile(path.join(evidenceRoot, 'database-run.json'), 'utf8').catch(() => 'null')) : null
  const retained = !simulation?.attempted && !simulation?.passed ? await retainedReplay(evidenceRoot) : null
  const replayRoot = retained?.root ?? evidenceRoot
  const replayReceipt = retained?.receipt ?? captureReceipt
  if (retained) simulation = retained.simulation
  const work = await inventory(root)
  work.controls = sourceControls(work)
  const dataClasses = currentDataClasses(work.dataClasses)
  const receipts = await accumulatedReceipts(evidenceRoot, currentReceipts, work.fingerprint)
  const coldSurvey = JSON.parse(await readFile(path.join(root, 'scripts/perf-lab/baselines/cold-survey.json'), 'utf8'))
  const costReceipts = new Map(coldSurvey.observations.map(row => [row.id, { ...row, archivedSource: coldSurvey.source }]))
  const sectionArchive = JSON.parse(await readFile(path.join(root, 'scripts/perf-lab/baselines/section-content.json'), 'utf8').catch(() => 'null'))
  const finalArchive = JSON.parse(await readFile(path.join(root, 'scripts/perf-lab/baselines/final-capture.json'), 'utf8').catch(() => 'null'))
  const sectionCaptures = [sectionArchive, sectionArchive?.after, ...(sectionArchive?.captures ?? []), finalArchive?.before, finalArchive].filter(Boolean)
  const cohortDefinition = JSON.parse(await readFile(path.join(root, 'scripts/perf-lab/baselines/release-cohort.json'), 'utf8'))
  const cohort = captureCohort(cohortDefinition, sectionCaptures)
  const perScreen = screenBaseline(work.surfaces, [...cohort.observations, ...receipts.map(row => ({ ...row, source: row.source ?? captureReceipt?.source, evidence: evidenceRoot ? path.join(evidenceRoot, path.dirname(row.webkit?.har ?? '.')) : undefined }))])
  const perScreenLines = screenBaselineLines(perScreen)
  const closure = JSON.parse(await readFile(path.join(root, 'scripts/perf-lab/baselines/closure.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return 'null'; throw error }))
  const closureLines = closure ? ['## Baseline closure', '', closure.summary, '',
    `Baseline source: ${closure.source}. Closed at ${closure.closedAt}.`,
    `Adapter checks: ${closure.adapters.passed}/${closure.adapters.total} across ${closure.adapters.screens} screens. Ranked screen states: ${closure.screenStates.measured}/${closure.screenStates.total}.`,
    `Regression matrix at handoff: ${closure.matrix.passed}/${closure.matrix.total}. Its remaining rows belong to the climb lanes.`,
    `Closure evidence: ${closure.evidence}.`, ''] : []
  const cohortLines = [`## Release ${cohort.release} measured workload`, '',
    `${cohort.observations.length} distinct successful cases contribute their latest successful capture.`,
    'The captures use different adapter fingerprints. This cost baseline does not establish current coverage.',
    'Before captures and failed attempts remain in the detailed tables below.',
    'Frequency counts requests in this selected workload, not daily usage.',
    'The source list is in scripts/perf-lab/baselines/release-cohort.json; baseline.json retains each case and evidence path.', '',
    '| State | Cases | Requests | Down bytes | Up bytes |', '| --- | --- | --- | --- | --- |',
    ...cohort.states.map(row => `| ${row.state} | ${row.samples} | ${row.requests} | ${row.bytesDown} | ${row.bytesUp} |`), '']
  for (const [kind, rows] of Object.entries(cohort.ranking)) cohortLines.push(
    `| ${kind === 'resourceTypes' ? 'Asset type' : 'Endpoint'} | Requests | Mean down bytes | Cost × frequency bytes |`,
    '| --- | --- | --- | --- |',
    ...rows.slice(0, kind === 'resourceTypes' ? rows.length : 15).map(row => `| ${cell(row.id)} | ${row.requests} | ${row.bytesPerRequest.toFixed(0)} | ${row.bytesDown} |`), '')
  cohortLines.push('| API endpoint | Requests | Mean down bytes | Cost × frequency bytes |', '| --- | --- | --- | --- |',
    ...cohort.ranking.endpoints.filter(row => /^\w+ \/(?:rest|auth|functions|storage)\/v1\//.test(row.id)).slice(0, 15)
      .map(row => `| ${cell(row.id)} | ${row.requests} | ${row.bytesPerRequest.toFixed(0)} | ${row.bytesDown} |`), '')
  if (cohortDefinition.history?.length) {
    cohortLines.push('## Earlier release workload totals', '', 'These workloads contain different cases. Their total difference is not a performance gain.', '',
      '| Capture | Cases | Down bytes |', '| --- | --- | --- |')
    for (const previous of cohortDefinition.history) {
      const bytes = previous.states.reduce((sum, row) => sum + row.bytesDown, 0)
      cohortLines.push(`| ${cell(previous.label)} | ${previous.cases} | ${bytes} |`, '')
      for (const [kind, rows] of Object.entries(previous.ranking)) cohortLines.push(
        `| Previous ${kind === 'resourceTypes' ? 'asset type' : 'endpoint'} | Requests | Mean down bytes | Cost × frequency bytes |`,
        '| --- | --- | --- | --- |', ...rows.map(row => `| ${cell(row.id)} | ${row.requests} | ${row.bytesPerRequest.toFixed(0)} | ${row.bytesDown} |`), '')
    }
  }
  const imageTransport = JSON.parse(await readFile(path.join(root, 'scripts/perf-lab/baselines/image-transport.json'), 'utf8').catch(() => 'null'))
  if (imageTransport) {
    cohortLines.push('## Local image transport repair', '', 'This restores a blocked image. The added bytes are not a performance gain.', '',
      '| Capture | Requests | Down bytes | Blocked external requests | Evidence |', '| --- | --- | --- | --- | --- |')
    for (const phase of ['before', 'after']) {
      const row = imageTransport[phase]
      cohortLines.push(`| ${phase} | ${row.requests} | ${row.bytesDown} | ${row.blocked} | ${cell(row.evidence)} |`)
    }
    cohortLines.push('')
  }
  for (const archive of sectionCaptures) for (const row of archive.observations) if (row.webkit?.passed) costReceipts.set(row.id, { ...row, archivedSource: archive.source })
  for (const row of receipts.filter(row => row.webkit?.passed)) costReceipts.set(row.id, row)
  const byId = new Map(receipts.map(row => [row.id, row]))
  const results = []
  for (const row of work.rows) {
    const receipt = byId.get(row.id)
    const failures = evidenceFailures(row, receipt, work.fingerprint)
    if (receipt && evidenceRoot) failures.push(...await verifyArtifacts(receipt, evidenceRoot))
    else if (receipt) failures.push('artifact root missing')
    results.push({ ...row, failures, passed: failures.length === 0, receipt })
  }
  const access = evidenceRoot ? (await readFile(path.join(evidenceRoot, 'access.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const traffic = [...costReceipts.values()].filter(row => row.webkit?.passed).map(row => {
    const candidates = access.filter(entry => entry.window === row.id)
    let rows = null
    for (let start = 0; start + row.webkit.requests <= candidates.length; start++) {
      const sample = candidates.slice(start, start + row.webkit.requests)
      if (sample.reduce((sum, item) => sum + item.bytesOut, 0) === row.webkit.bytesIn
        && sample.reduce((sum, item) => sum + item.bytesIn, 0) === row.webkit.bytesOut) rows = sample
    }
    const breakdown = row.webkit.traffic ?? (rows ? trafficBreakdown(rows) : null)
    return { id: row.id, source: row.archivedSource ?? null, httpCache: row.webkit.httpCache ?? 'disabled-by-routing', requests: row.webkit.requests, bytesDown: row.webkit.bytesIn, bytesUp: row.webkit.bytesOut, breakdown }
  })
  const archive = JSON.parse(await readFile(path.join(root, 'scripts/perf-lab/baselines/verified-reopen.json'), 'utf8'))
  const archiveLines = ['## Archived verified reopen', '', `Source: ${archive.source}. Evidence: ${archive.evidence}. These observations do not satisfy the current workload fingerprint.`, '', '| State | Requests | Down bytes | DB ms | Statements | Buffers | First content ms | Settled ms |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...archive.states.map(row => `| ${row.id} | ${row.requests} | ${row.bytesDown} | ${row.dbMs.toFixed(2)} | ${row.dbCalls} | ${row.dbBuffers} | ${row.firstContentMs.toFixed(1)} | ${row.settledMs.toFixed(1)} |`), '', '| Screen | Observed frequency | Mean DB ms | Cost × frequency (DB ms) |', '| --- | --- | --- | --- |', ...archive.ranking.map(row => `| ${row.id} | ${row.frequency} | ${row.dbMs.toFixed(2)} | ${row.weightedDbMs.toFixed(2)} |`), '']
  const initialTraffic = JSON.parse(await readFile(path.join(root, 'scripts/perf-lab/baselines/initial-traffic.json'), 'utf8'))
  const startingNetwork = rankTraffic(initialTraffic.map(row => ({ breakdown: { resourceTypes: row.resourceTypes, endpoints: row.endpoints } })))
  const trafficLines = ['## Captured traffic by state', '', 'Bytes count HTTP payloads at the local gateway. Browser cache hits do not cross this gateway.', '', 'Each endpoint excludes query values. Durations sum request elapsed time and can overlap.', '', `Archived cold survey: ${coldSurvey.source}. Evidence: ${coldSurvey.evidence}. Archived costs do not satisfy current coverage.`, '']
  for (const row of [...initialTraffic.map(row => ({ ...row, id: `Initial capture · ${row.id}`, breakdown: { resourceTypes: row.resourceTypes, endpoints: row.endpoints } })), ...traffic]) {
    trafficLines.push(`### ${row.id}${row.source ? ' · archived' : ''}`, '', `${row.requests} requests; ${row.bytesDown} bytes down; ${row.bytesUp} bytes up. HTTP cache: ${row.httpCache ?? 'disabled-by-routing'}.`, '')
    for (const [label, values] of Object.entries(row.breakdown ?? {})) {
      trafficLines.push(`| ${label === 'resourceTypes' ? 'Asset type' : 'Endpoint'} | Requests | Down bytes | Up bytes | Duration ms | Errors |`, '| --- | --- | --- | --- | --- | --- |')
      for (const value of values) trafficLines.push(`| ${cell(value.id)} | ${value.requests} | ${value.bytesDown} | ${value.bytesUp} | ${value.durationMs.toFixed(2)} | ${value.errors} |`)
      trafficLines.push('')
    }
  }
  const networkRanking = rankTraffic(traffic.filter(row => !row.source))
  const replayNetwork = []
  if (replayRoot) for (const layer of ['client', 'edge']) {
    const file = path.join(replayRoot, `replay-${layer}-access.jsonl`)
    const rows = (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    if (!rows.length) continue
    replayNetwork.push({ layer, file, profile: simulation?.captureProfile ?? 'unknown', complete: simulation?.passed === true, requests: rows.length,
      bytesDown: rows.reduce((sum, row) => sum + row.bytesOut, 0), bytesUp: rows.reduce((sum, row) => sum + row.bytesIn, 0),
      durationMs: rows.reduce((sum, row) => sum + row.durationMs, 0), ...trafficBreakdown(rows) })
  }
  const networkLines = ['## Network cost × observed request frequency', '', 'Cost is mean payload bytes per request. Frequency counts current-workload requests.', 'Archived releases do not contribute to this ranking.', '']
  for (const [kind, rows] of Object.entries(networkRanking)) {
    networkLines.push(`| ${kind === 'resourceTypes' ? 'Asset type' : 'Endpoint'} | Requests | Mean down bytes | Total down bytes | Total duration ms |`, '| --- | --- | --- | --- | --- |', ...rows.map(row => `| ${cell(row.id)} | ${row.requests} | ${row.bytesPerRequest.toFixed(0)} | ${row.bytesDown} | ${row.durationMs.toFixed(1)} |`), '')
  }
  for (const [index, archive] of sectionCaptures.entries()) {
    const captured = archive.observations.filter(row => row.webkit?.passed && row.webkit.traffic).map(row => ({ breakdown: row.webkit.traffic }))
    const ranking = rankTraffic(captured)
    networkLines.push(`## Archived network ranking: ${cell(archive.label ?? (index ? 'after' : 'before'))}`, '', `Source: ${archive.source}. Evidence: ${archive.evidence}.`, '')
    for (const [kind, rows] of Object.entries(ranking)) {
      networkLines.push(`| ${kind === 'resourceTypes' ? 'Asset type' : 'Endpoint'} | Requests | Mean down bytes | Total down bytes | Total duration ms |`, '| --- | --- | --- | --- | --- |', ...rows.map(row => `| ${cell(row.id)} | ${row.requests} | ${row.bytesPerRequest.toFixed(0)} | ${row.bytesDown} | ${row.durationMs.toFixed(1)} |`), '')
    }
  }
  for (const layer of replayNetwork) {
    networkLines.push(`## Replay ${layer.profile} ${layer.layer} network: ${layer.complete ? 'complete' : 'partial'}`, '', 'Layers are separate network hops. Their bytes are not added together.', '', `Evidence: ${layer.file}.`, '', '| Endpoint | Requests | Down / up bytes | Mean duration ms | Cost × frequency ms | Errors |', '| --- | --- | --- | --- | --- | --- |')
    for (const row of [...layer.endpoints].sort((a, b) => b.durationMs - a.durationMs)) networkLines.push(`| ${cell(row.id)} | ${row.requests} | ${row.bytesDown} / ${row.bytesUp} | ${(row.durationMs / row.requests).toFixed(2)} | ${row.durationMs.toFixed(2)} | ${row.errors} |`)
    networkLines.push('')
  }
  const normalCache = JSON.parse(await readFile(path.join(root, 'scripts/perf-lab/baselines/normal-cache.json'), 'utf8').catch(() => 'null'))
  if (normalCache) {
    networkLines.push('## Archived cache-enabled baseline', '', `Source: ${normalCache.source}. Evidence: ${normalCache.evidence}.`, '', 'This capture uses normal HTTP caching. Later harness changes require fresh coverage proofs.', '', '| State | Requests | Down bytes |', '| --- | --- | --- |', ...normalCache.states.map(row => `| ${cell(row.id)} | ${row.requests} | ${row.bytesDown} |`), '')
    networkLines.push('| Screen | Observed frequency | Mean DB ms | Cost × frequency (DB ms) |', '| --- | --- | --- | --- |', ...normalCache.ranking.map(row => `| ${cell(row.id)} | ${row.frequency} | ${row.dbMs.toFixed(2)} | ${row.weightedDbMs.toFixed(2)} |`), '')
    networkLines.push('| Control | Samples | Mean requests | Mean down bytes | Mean result ms | Total down bytes | Over budget |', '| --- | --- | --- | --- | --- | --- | --- |', ...normalCache.interactionRanking.map(row => `| ${cell(row.id)} | ${row.frequency} | ${row.requests.toFixed(1)} | ${row.bytesDown.toFixed(0)} | ${row.resultsMs.toFixed(1)} | ${row.weightedBytes} | ${row.overBudget} |`), '')
    for (const [kind, rows] of Object.entries(normalCache.networkRanking)) {
      networkLines.push(`| ${kind === 'resourceTypes' ? 'Asset type' : 'Endpoint'} | Requests | Mean down bytes | Total down bytes | Total duration ms |`, '| --- | --- | --- | --- | --- |', ...rows.map(row => `| ${cell(row.id)} | ${row.requests} | ${row.bytesPerRequest.toFixed(0)} | ${row.bytesDown} | ${row.durationMs.toFixed(1)} |`), '')
    }
  }
  const passed = results.filter(row => row.passed).length
  const webkitPassed = receipts.filter(row => row.webkit?.passed).length
  const simulationGatePassed = simulation?.passed === true && simulation?.days === 2 && simulation?.fidelity === 'production-cadence'
    && ['liveTicks', 'overnightFinalization', 'preTipoff', 'waivers', 'tradeProposed', 'tradeCountered', 'tradeAccepted', 'forecasts', 'realtime'].every(key => simulation.gates?.[key] === true)
  const fullCapturePassed = simulation?.captureProfile === 'full' && simulationGatePassed && replayReceipt?.captureComplete !== false
  const simulationPassed = ['full', 'control'].includes(simulation?.captureProfile) && simulationGatePassed
  const currentRunLabel = `${retained ? 'Retained' : 'Current'} ${simulation?.captureProfile === 'control' ? 'control' : 'full'} run`
  const runtimeBefore = JSON.parse(await readFile(path.join(root, 'scripts/perf-lab/baselines/replay-runtime.json'), 'utf8').catch(() => 'null'))
  const runtimeRows = replayRoot ? (await readFile(path.join(replayRoot, 'edge-invocations.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const runtimeCurrent = replayRuntime(runtimeRows)
  const runtimeMatched = runtimeBefore ? replayRuntime(runtimeRows, runtimeBefore.summary.through) : null
  const runtimeComparable = Boolean(runtimeCurrent && runtimeBefore && Date.parse(runtimeCurrent.through) >= Date.parse(runtimeBefore.summary.through))
  const matchedLabel = runtimeComparable ? 'Current through prior cutoff' : 'Current partial prefix'
  const currentLoad = replayRoot ? JSON.parse(await readFile(path.join(replayRoot, 'job-load-replay.json'), 'utf8').catch(() => 'null')) : null
  const currentClocks = clockRuntime(currentLoad)
  const runtime = { before: runtimeBefore, current: runtimeCurrent, matched: runtimeMatched, comparable: runtimeComparable, complete: simulationPassed, clocks: currentClocks }
  const runtimeLines = ['', '## Replay elapsed time and worker cost', '',
    'Elapsed time counts the worker span. Worker durations can overlap and are listed separately.',
    'The earlier run stops before day one completes. It is not a full-run timing baseline.', '',
    '| Capture | Through business time | Calls | Elapsed ms | Worker ms | HTTP errors | Gates |',
    '| --- | --- | --- | --- | --- | --- | --- |']
  const storedPrefixes = (runtimeBefore?.prefixes ?? []).map(row => [`${row.profile === 'control' ? 'Control' : 'After'} through prior cutoff (${row.source.slice(0, 8)})`, row.summary, 'incomplete'])
  for (const [label, value, gates] of [['Before', runtimeBefore?.summary, 'failed'], ...storedPrefixes, [matchedLabel, runtimeMatched, 'partial'], [currentRunLabel, runtimeCurrent, simulationGatePassed ? 'passed' : 'not passed']]) {
    if (value) runtimeLines.push(`| ${label} | ${value.through} | ${value.calls} | ${value.spanMs.toFixed(2)} | ${value.durationMs.toFixed(2)} | ${value.errors} | ${gates} |`)
  }
  runtimeLines.push('', '| Capture | Function | Calls | Mean ms | Cost × frequency ms | HTTP errors |', '| --- | --- | --- | --- | --- | --- |')
  for (const [label, value] of [['Before', runtimeBefore?.summary], ...storedPrefixes, [matchedLabel, runtimeMatched], [currentRunLabel, runtimeCurrent]]) {
    for (const row of value?.functions ?? []) runtimeLines.push(`| ${label} | ${row.function} | ${row.calls} | ${(row.durationMs / row.calls).toFixed(2)} | ${row.durationMs.toFixed(2)} | ${row.errors} |`)
  }
  runtimeLines.push('', `Before evidence: ${runtimeBefore?.evidence ?? 'unavailable'}. Current evidence: ${replayRoot ? path.join(replayRoot, 'edge-invocations.jsonl') : 'unavailable'}.`, '',
    'The clock probe is a local measurement. A full-run gain remains unproven until all two-day gates pass.',
    `Replay gates: ${simulationPassed ? 'passed' : 'not passed'}. Full capture gates: ${fullCapturePassed ? 'passed' : 'not passed'}. Capture profile: ${simulation?.captureProfile ?? 'none'}.`, '')
  if (retained) runtimeLines.push(`Retained replay source: ${replayReceipt.source}. Its backend source trees match the current committed backend.`, 'Its original capture profile, timing and evidence remain separate from the current screen walk.', '')
  for (const row of runtimeBefore?.prefixes ?? []) runtimeLines.push(`Captured cutoff evidence: ${row.evidence}. Later two-day work is not included.`, '')
  runtimeLines.push('| Capture | Clock query | Calls | Total ms | Mean ms | Mean × 200 calls ms | Rows | Buffers |', '| --- | --- | --- | --- | --- | --- | --- | --- |')
  const progressClocks = (runtimeBefore?.progress ?? []).map(row => [`Progress ${row.at}, incomplete`, row.clocks])
  for (const [label, clocks] of [['Before, incomplete', runtimeBefore?.clocks ?? []], ...progressClocks, [simulationPassed ? 'Current, complete' : 'Current, incomplete', currentClocks]]) {
    for (const row of clocks) runtimeLines.push(`| ${label} | ${row.clock} | ${row.calls} | ${row.durationMs.toFixed(2)} | ${row.meanMs.toFixed(6)} | ${row.normalized200Ms.toFixed(3)} | ${cell(row.rows)} | ${cell(row.buffers)} |`)
  }
  runtimeLines.push('', 'Mean × 200 normalizes the recorded query average. It is not another 200-call probe.',
    'Clock wrappers contain the clock-table read. These nested durations and buffers must not be added.',
    `Clock evidence: ${runtimeBefore?.clockEvidence ?? 'unavailable'}; ${replayRoot ? path.join(replayRoot, 'job-load-replay.json') : 'unavailable'}.`, '')
  for (const row of runtimeBefore?.progress ?? []) runtimeLines.push(`Progress evidence (${row.at}): ${row.evidence}.`, '')
  runtimeLines.push('## Replay statement cost × frequency', '', 'These are the 30 highest-cost statements retained by the replay capture.',
    'Nested statements remain separate. Their durations and buffers overlap and must not be added.',
    'Query samples are shortened. The linked capture retains the recorded text.', '',
    '| Capture | Query ID | Calls | Mean ms | Cost × frequency ms | Rows | Buffers | Query sample |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const [label, statements] of [['Before, incomplete', runtimeBefore?.statements ?? []], [simulationPassed ? 'Current, complete' : 'Current, incomplete', currentLoad?.byTotal ?? []]]) {
    for (const row of statements) runtimeLines.push(`| ${label} | ${row.queryid} | ${row.calls} | ${(row.total_exec_time / row.calls).toFixed(4)} | ${row.total_exec_time.toFixed(2)} | ${row.rows_returned_or_affected} | ${row.shared_blks_hit + row.shared_blks_read} | ${cell(row.query.replace(/\s+/g, ' ').slice(0, 250))} |`)
  }
  runtimeLines.push('')
  const attempts = JSON.parse(await readFile(path.join(root, 'scripts/perf-lab/baselines/replay-attempts.json'), 'utf8').catch(() => '[]'))
  if (simulation?.attempted || simulation?.passed) {
    const receipt = replayReceipt
    if (!attempts.some(row => row.runId === receipt?.runId)) attempts.push({ runId: receipt?.runId, source: receipt?.source, profile: simulation.captureProfile, passed: simulation.passed, error: simulation.error, gates: simulation.gates, evidence: replayRoot, runtime: runtimeCurrent, clocks: currentClocks })
  }
  runtimeLines.push('## Replay attempts and capture profiles', '', 'Control-profile gate results do not prove full-profile timing or capture completeness.', 'Elapsed spans cover different business windows. Use the cutoff table for a matched comparison.', '', '| Source | Profile | Gates passed | Result | Through business time | Elapsed worker span ms | Failure | Evidence |', '| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const row of attempts) runtimeLines.push(`| ${cell(row.source?.slice(0, 8))} | ${cell(row.profile)} | ${Object.values(row.gates ?? {}).filter(Boolean).length} / ${Object.keys(row.gates ?? {}).length} | ${row.passed ? 'passed' : 'failed'} | ${cell(row.runtime?.through)} | ${row.runtime?.spanMs?.toFixed(2) ?? 'unmeasured'} | ${cell(row.error ?? 'none')} | ${cell(row.evidence)} |`)
  runtimeLines.push('', '### Retained replay traffic and statement costs', '',
    'These stopped captures remain baseline evidence. They do not prove completed two-day gates.',
    'Client and Edge layers overlap. Their byte and time totals must not be added.', '',
    '| Source | Profile | Layer | Requests | Down bytes | Up bytes | Total ms |', '| --- | --- | --- | --- | --- | --- | --- |')
  for (const attempt of attempts) for (const row of attempt.network ?? []) runtimeLines.push(
    `| ${attempt.source.slice(0, 8)} | ${attempt.profile} | ${row.layer} | ${row.requests} | ${row.bytesDown} | ${row.bytesUp} | ${row.durationMs.toFixed(2)} |`)
  runtimeLines.push('', '| Source | Layer | Endpoint | Requests | Cost × frequency bytes | Total ms |', '| --- | --- | --- | --- | --- | --- |')
  for (const attempt of attempts) for (const layer of attempt.network ?? []) for (const row of layer.endpoints.slice(0, 15)) runtimeLines.push(
    `| ${attempt.source.slice(0, 8)} | ${layer.layer} | ${cell(row.id)} | ${row.requests} | ${row.bytesDown} | ${row.durationMs.toFixed(2)} |`)
  runtimeLines.push('', '| Source | Profile | Query ID | Calls | Cost × frequency ms | Rows | Buffers | Query |', '| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const attempt of attempts) for (const row of attempt.statements ?? []) runtimeLines.push(
    `| ${attempt.source.slice(0, 8)} | ${attempt.profile} | ${row.queryid} | ${row.calls} | ${row.total_exec_time.toFixed(2)} | ${row.rows_returned_or_affected} | ${row.shared_blks_hit + row.shared_blks_read} | ${cell(row.query.replace(/\s+/g, ' ').slice(0, 250))} |`)
  for (const row of attempts.filter(row => row.environmentCause)) runtimeLines.push('', `${row.source.slice(0, 8)} environment: ${row.environmentCause}`, '')
  for (const row of attempts.filter(row => row.cause)) {
    runtimeLines.push('', `${row.source.slice(0, 8)} failure cause: ${row.cause}`, '',
      '| Two-day gate | Recorded result |', '| --- | --- |',
      ...Object.entries(row.gates).map(([gate, passed]) => `| ${gate} | ${passed ? 'passed' : gate === row.failingGate ? `failed: ${row.failureFunction} / ${row.failureCode}` : 'not completed before replay stopped'} |`), '')
  }
  for (const row of attempts.filter(row => row.diagnosis)) {
    const value = row.diagnosis
    runtimeLines.push('', `Replay diagnosis ${row.source.slice(0, 8)}: ${value.kind}.`,
      `Requested pick season: ${value.requestedPickSeason}. Available future seasons: ${value.availableFutureSeasons.join(', ')}.`,
      `API request sent: ${value.apiRequestSent ? 'yes' : 'no'}. Failure point: ${value.failurePoint}.`,
      value.rule, 'This stopped attempt does not establish a full-run gain.', '')
  }
  runtimeLines.push('', '| Source | Profile | Clock query | Calls | Mean × 200 calls ms | Rows | Buffers |', '| --- | --- | --- | --- | --- | --- | --- |')
  for (const attempt of attempts) for (const row of attempt.clocks ?? []) runtimeLines.push(`| ${cell(attempt.source?.slice(0, 8))} | ${cell(attempt.profile)} | ${row.clock} | ${row.calls} | ${row.normalized200Ms.toFixed(3)} | ${row.rows} | ${row.buffers} |`)
  runtimeLines.push('')
  const lines = ['# Screen matrix', '', 'Red rows lack complete evidence. Source descriptions are expectations, not visual findings.', '',
    'This matrix is the climb lanes’ regression suite. Its complete execution is not a baseline closure requirement.', '',
    `Workload fingerprint: \`${work.fingerprint}\`.`, '',
    `${webkitPassed} WebKit observations pass. ${passed}/${results.length} rows pass the accepted iPhone WebKit standalone stand-in. installed iOS PWA: not proven on device.`, '',
    '| Route / surface | Role | Day | State | First content | Lazy content | Update trigger | Bytes down/up | Test | Result |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
  const surfaces = new Map(work.surfaces.map(row => [row.id, row]))
  for (const row of results) {
    const surface = surfaces.get(row.surface)
    const contracts = dataClasses.filter(entry => surface.data.includes(entry.id))
    if (surface.route.split('?')[0] === '/propose-trade') contracts.push(editorContext)
    if (surface.id === 'trades.analyzer' || surface.scenario?.includes('analyzer')) contracts.push(analyzerContext)
    const update = [...new Set(contracts.map(entry => entry.invalidation))].join('; ') || 'Requires capture'
    const measured = row.receipt?.webkit
    const bytes = measured && Number.isFinite(measured.bytesIn) ? `WebKit ${measured.bytesIn}/${measured.bytesOut}; standalone ${measured.phone?.standalone ? 'emulated' : 'unproved'}` : 'unmeasured'
    const empty = row.state === 'empty' ? emptyPlan(surface) : null
    const first = row.state === 'empty' ? empty ? JSON.stringify(empty.expected) : 'Empty-state fixture not implemented' : surface.first
    lines.push(`| ${cell(`${surface.route} · ${surface.id}`)} | ${row.role} | ${row.day} | ${row.state} | ${cell(first)} | ${cell(surface.lazy)} | ${cell(update)} | ${bytes} | ${cell(row.test)} | ${row.passed ? '🟢' : `🔴 ${cell(row.failures.join('; '))}`} |`)
  }
  lines.push('', '## Interactive controls', '', 'Budgets are fixed lab ceilings. They are not performance improvements.', 'A green control needs measured results within budget and complete browser evidence.', 'DOM mutations show update scope. They do not count React renders.', '', '| Screen | Control | Type | Budget: requests / bytes / result ms; DB ms / statements / buffers | Measured requests / bytes / result ms | DB ms / statements / rows / buffers | DOM mutations / scopes | Test | Result |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  const observedControls = receipts.filter(row => row.fingerprint === work.fingerprint).flatMap(row => (row.webkit?.interactions ?? []).map(control => ({ ...control, row })))
  for (const control of work.controls) {
    const samples = observedControls.filter(sample => sample.id === control.id)
    const summary = samples.length ? samples.map(sample => `${sample.requests} / ${sample.bytesDown} / ${sample.resultsMs ?? 'unresolved'}`).join('; ') : 'unmeasured'
    const complete = samples.some(sample => sequenceControlProved(sample, sample.row.webkit) && sample.budgetPassed && results.find(row => row.id === sample.row.id)?.passed)
    const database = samples.length ? samples.map(sample => `${sample.dbMs?.toFixed(2) ?? 'unknown'} / ${sample.dbCalls ?? 'unknown'} / ${sample.dbRows ?? 'unknown'} / ${sample.dbBuffers ?? 'unknown'}`).join('; ') : 'unmeasured'
    const renders = samples.length ? samples.map(sample => `${sample.renderMutations ?? 'unknown'} / ${sample.renderScopes?.join(', ') ?? 'unknown'}`).join('; ') : 'unmeasured'
    lines.push(`| ${cell(control.route)} | ${cell(control.label)} | ${control.category} | ${control.budget.requests} / ${control.budget.bytesDown} / ${control.budget.resultsMs}; ${control.budget.dbMs} / ${control.budget.dbCalls} / ${control.budget.dbBuffers} | ${summary} | ${cell(database)} | ${cell(renders)} | ${cell(control.id)} | ${complete ? '🟢' : '🔴'} |`)
    for (const sample of samples) for (const key of sample.keystrokes) lines.push(`| ${cell(control.route)} | Keystroke ${key.index + 1}: ${cell(key.value)} | search, ${sample.cadenceMs} ms cadence | 1 / ${control.budget.bytesDown} / ${control.budget.resultsMs} | ${key.requests} / ${key.bytesDown} / ${key.resultsMs ?? 'coalesced or unresolved'} | included in control | included in control | ${cell(sample.id)} | ${key.resultsMs !== null && key.resultsMs <= control.budget.resultsMs ? 'measured' : '🔴'} |`)
  }
  const discovered = new Map()
  for (const receipt of receipts.filter(row => row.fingerprint === work.fingerprint)) for (const [index, value] of (receipt.webkit?.controls ?? []).entries()) {
    const control = { ...value, label: value.label || `Unlabeled ${value.role} ${value.id || index}` }
    if (observedControls.some(sample => {
      const declared = work.controls.find(value => value.id === sample.id)
      return sample.row.webkit.passed && declared && sameControlSurface(declared.route, surfaces.get(receipt.surface).route)
        && (sample.label === control.label || controlLabelMatches(sample.kind, declared.label, control.label))
    })) continue
    discovered.set(`${receipt.surface}/${control.role}/${control.label}`, { ...control, surface: receipt.surface })
  }
  for (const control of discovered.values()) {
    const contract = controlContract({ tap: control.label })
    lines.push(`| ${cell(control.surface)} | ${cell(control.label)} | ${control.role} | ${contract.budget.requests} / ${contract.budget.bytesDown} / ${contract.budget.resultsMs}; ${contract.budget.dbMs} / ${contract.budget.dbCalls} / ${contract.budget.dbBuffers} | unmeasured | unmeasured | unmeasured | Missing control action | 🔴 |`)
  }
  if (normalCache?.search) {
    lines.push('', '## Archived cache-enabled search evidence', '', `Source: ${normalCache.source}. Evidence: ${normalCache.evidence}. These measurements do not satisfy the current workload fingerprint.`, '', '| State | Control | Requests | Down bytes | Result ms | DB ms / calls / rows / buffers | Budget passed |', '| --- | --- | --- | --- | --- | --- | --- |')
    for (const row of normalCache.search) for (const control of row.controls) lines.push(`| ${cell(row.id)} | ${cell(control.id)} | ${control.requests} | ${control.bytesDown} | ${control.resultsMs ?? 'unresolved'} | ${control.dbMs ?? 'unknown'} / ${control.dbCalls ?? 'unknown'} / ${control.dbRows ?? 'unknown'} / ${control.dbBuffers ?? 'unknown'} | ${row.passed && control.budgetPassed ? 'yes' : 'no'} |`)
    lines.push('', '| State | Keystroke | Value | Requests | Down bytes | Result ms |', '| --- | --- | --- | --- | --- | --- |')
    for (const row of normalCache.search) for (const control of row.controls) for (const key of control.keystrokes) lines.push(`| ${cell(row.id)} | ${key.index + 1} | ${cell(key.value)} | ${key.requests} | ${key.bytesDown} | ${key.resultsMs ?? 'coalesced or unresolved'} |`)
  }
  const measurements = work.surfaces.map(surface => {
    const candidates = [...costReceipts.values()].filter(row => row.surface === surface.id && row.webkit?.passed && Number.isFinite(row.webkit.dbMs))
    const current = candidates.filter(row => !row.archivedSource)
    const sectionRows = candidates.filter(row => row.archivedSource === sectionCaptures.at(-1)?.source)
    const archived = normalCache?.ranking.find(row => row.id === surface.id)
    if (!current.length && !sectionRows.length && archived) return { ...archived, archivedSource: normalCache.source }
    const rows = current.length ? current : sectionRows.length ? sectionRows : candidates
    const samples = rows.map(row => row.webkit)
    if (!samples.length) return null
    const average = key => samples.reduce((sum, row) => sum + row[key], 0) / samples.length
    return { id: surface.id, archivedSource: rows[0].archivedSource ?? null, frequency: samples.length, dbMs: average('dbMs'), requests: average('requests'), bytesIn: average('bytesIn'), bytesOut: average('bytesOut'), dbCalls: average('dbCalls'), dbRows: average('dbRows'), dbBuffers: average('dbBuffers'), pushBytes: average('pushBytes') }
  }).filter(Boolean)
  const initialCold = initialTraffic.find(row => row.id.endsWith('/cold'))
  const initialWarm = initialTraffic.find(row => row.id.endsWith('/warm'))
  const coldScript = initialCold?.resourceTypes.find(row => row.id === 'JavaScript')
  const warmWorker = initialWarm?.resourceTypes.find(row => row.id === 'service worker')
  const opening = initialCold && initialWarm && coldScript && warmWorker ? [
    `The frozen starting matchup records ${initialCold.requests} cold requests / ${initialCold.bytesDown} down bytes and ${initialWarm.requests} warm requests / ${initialWarm.bytesDown} down bytes.`, '',
    `Cold JavaScript contributes ${coldScript.bytesDown} bytes across ${coldScript.requests} requests (${(coldScript.bytesDown / initialCold.bytesDown * 100).toFixed(1)}%). The warm service worker contributes ${warmWorker.bytesDown} bytes (${(warmWorker.bytesDown / initialWarm.bytesDown * 100).toFixed(1)}%).`, '',
    'These starting measurements are archived. Asset and endpoint tables below retain their exact counts and later comparisons.', '',
  ] : []
  opening.push('## Starting workload targets', '',
    'This ranking combines one cold open and one warm reopen of the starting matchup.',
    'Frequency counts requests in those two captures. It does not estimate daily user activity.',
    'Cost × frequency is total response bytes. These archived results do not prove the current release.',
    'Source: [starting traffic records](../scripts/perf-lab/baselines/initial-traffic.json).', '')
  for (const [kind, rows] of Object.entries(startingNetwork)) {
    opening.push(`| ${kind === 'resourceTypes' ? 'Asset type' : 'Endpoint'} | Requests | Mean bytes | Cost × frequency bytes |`, '| --- | --- | --- | --- |',
      ...rows.slice(0, kind === 'resourceTypes' ? rows.length : 10).map(row => `| ${cell(row.id)} | ${row.requests} | ${row.bytesPerRequest.toFixed(0)} | ${row.bytesDown} |`), '')
  }
  for (const kind of ['resourceTypes', 'endpoints']) {
    opening.push(`| Initial ${kind === 'resourceTypes' ? 'asset type' : 'endpoint'} | Cold requests / down bytes | Warm requests / down bytes |`, '| --- | --- | --- |')
    for (const id of new Set([...(initialCold?.[kind] ?? []), ...(initialWarm?.[kind] ?? [])].map(row => row.id))) {
      const values = [initialCold, initialWarm].map(capture => capture?.[kind].find(row => row.id === id))
      opening.push(`| ${cell(id)} | ${values.map(row => `${row?.requests ?? 0} / ${row?.bytesDown ?? 0}`).join(' | ')} |`)
    }
    opening.push('')
  }
  const flow = ['# Screen data flow', '', ...closureLines, ...perScreenLines, ...opening, ...cohortLines, 'Contracts below come from the source inventory. Measured fields remain unknown until the capture passes.', '',
    'API paths below are relative to /functions/v1/api. RPC paths use /rest/v1/rpc.',
    'The shared API and guarded RPCs can save pending writes in account-scoped localStorage entries under pancake:offline-mutations:v1.',
    'Replay uses the current account and the original request ID. A failed write stops the queue until retry.',
    'Trade roster previews use apiReadPost. They do not join the mutation queue or invalidate their own view.', '',
    'The [player identity review](player-identity.md) lists the nine split identities and the repair rule.', '',
    'Verdicts stay unreviewed without measured cost and visual review. Unknown values are never recorded as zero.', '',
    '| Screen | Incoming data | Outgoing actions | Cache | Refresh trigger | Bytes / requests | DB statements / buffers | Pushes | Verdict |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |']
  for (const surface of work.surfaces) {
    const contracts = dataClasses.filter(entry => surface.data.includes(entry.id))
    if (surface.route.split('?')[0] === '/propose-trade') contracts.push(editorContext)
    if (surface.id === 'trades.analyzer' || surface.scenario?.includes('analyzer')) contracts.push(analyzerContext)
    const describe = keys => contracts.map(entry => keys.map(key => entry[key]).filter(Boolean).join('; ')).join('<br>') || 'Requires capture'
    const measured = measurements.find(row => row.id === surface.id)
    flow.push(`| ${cell(`${surface.route} · ${surface.id}`)} | ${cell(describe(['coldSource']))} | ${cell(describe(['outgoing', 'writePolicy']))} | ${cell(describe(['cacheKey', 'warmSource', 'ttl', 'sizeBound']))} | ${cell(describe(['invalidation', 'reconnect']))} | ${measured ? `${Math.round(measured.bytesIn)} down / ${Math.round(measured.bytesOut)} up / ${measured.requests.toFixed(1)} requests` : 'unmeasured'} | ${measured ? `${measured.dbCalls.toFixed(1)} statements / ${measured.dbRows.toFixed(1)} rows / ${measured.dbBuffers.toFixed(1)} buffers` : 'unmeasured'} | ${cell(describe(['realtimeEvent']))}${measured ? `; ${measured.pushBytes.toFixed(0)} measured bytes` : ''} | ${measured ? measured.archivedSource ? `archived ${measured.archivedSource.slice(0, 8)}; current proof pending` : 'keep for baseline; optimization untested' : 'unreviewed'} |`)
  }
  flow.push('', ...networkLines, ...trafficLines, '', ...archiveLines)
  const sectionHistoryStart = flow.length
  for (const [index, archive] of sectionCaptures.entries()) {
    flow.push('', `## Archived section and offline checks: ${cell(archive.label ?? (index ? 'after' : 'before'))}`, '', `Source: ${archive.source}. Evidence: ${archive.evidence}.`, '', '| State | Result | Requests | Down / up bytes | First content / settled ms | DB ms / statements / rows / buffers | Push bytes | Cache hits / misses / invalidations |', '| --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const row of archive.observations) {
      const value = key => Number.isFinite(row.webkit[key]) ? String(row.webkit[key]) : 'unmeasured'
      flow.push(`| ${cell(row.id)} | ${row.webkit.passed ? 'passed' : cell(row.webkit.failure)} | ${value('requests')} | ${value('bytesIn')} / ${value('bytesOut')} | ${value('firstContentMs')} / ${value('settledMs')} | ${value('dbMs')} / ${value('dbCalls')} / ${value('dbRows')} / ${value('dbBuffers')} | ${value('pushBytes')} | ${value('cacheHits')} / ${value('cacheMisses')} / ${value('invalidations')} |`)
    }
    for (const note of archive.notes ?? []) flow.push('', note, '')
  }
  const visual = JSON.parse(await readFile(path.join(root, 'scripts/perf-lab/baselines/visual-first-load.json'), 'utf8').catch(() => '[]'))
  if (visual.length) {
    flow.push('', '## Recorded first-frame observations', '', 'These observations describe the captured pixels. Michael’s review remains pending.', 'A passing content check does not mean the first frame contains screen data.', '', '| State | Source | Visible first frame | Settled frame | Images |', '| --- | --- | --- | --- | --- |')
    for (const row of visual) flow.push(`| ${cell(row.case)} | ${row.source.slice(0, 8)} | ${cell(row.first)} | ${cell(row.settled)} | [First frame](${row.image})${row.settledImage ? `; [settled](${row.settledImage})` : ''} |`)
  }
  const assessedFrames = visual.filter(row => typeof row.bodyAtFirstFrame === 'boolean')
  if (assessedFrames.length) {
    flow.push('', '| Recorded state | Assessed first frames | Body content present | Body content absent |', '| --- | --- | --- | --- |')
    for (const [state, frames] of Map.groupBy(assessedFrames, row => row.case.split('/').at(-1))) flow.push(`| ${state} | ${frames.length} | ${frames.filter(row => row.bodyAtFirstFrame).length} | ${frames.filter(row => !row.bodyAtFirstFrame).length} |`)
    flow.push('', 'These frame observations do not establish current-source coverage or Michael’s approval.', '')
  }
  lines.push(...flow.slice(sectionHistoryStart), ...runtimeLines)
  if (writeDocs) await writeFile(path.join(root, 'docs/screen-matrix.md'), `${lines.join('\n')}\n`)
  const rosterInputs = JSON.parse(await readFile(path.join(root, 'scripts/perf-lab/baselines/roster-inputs.json'), 'utf8').catch(() => 'null'))
  if (rosterInputs) {
    flow.push('', '## Historical roster input coverage', '', `Evidence: ${rosterInputs.evidence}. Earlier dated observations stay available; the 350-player import guard is unchanged.`, '', '| Date | Trimmed input | Retained input |', '| --- | --- | --- |')
    for (const [date, count] of Object.entries(rosterInputs.retained)) flow.push(`| ${date} | ${rosterInputs.trimmed[date] ?? 'not retained'} | ${count} |`)
  }
  const isolation = JSON.parse(await readFile(path.join(root, 'scripts/perf-lab/baselines/replay-isolation.json'), 'utf8').catch(() => '[]'))
  if (isolation.length) {
    flow.push('', '## Replay database isolation', '', 'The combined command now restores the backup again before replay. These counts describe the database before replay creates its league.', '', '| Capture | Leagues | Players | Game stats | Games | Auth users | Recovered retry items / observed | Phase reached |', '| --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const row of isolation) flow.push(`| ${cell(row.label)} | ${row.database.leagues} | ${row.database.players} | ${row.database.stats} | ${row.database.games} | ${row.database.authUsers} | ${row.retryItems.filter(item => item.recovered).length} / ${row.retryItems.length} | ${cell(row.phase)} |`)
    flow.push('', 'The fresh comparison is incomplete until the two-day gates pass. These are fixture-isolation measurements, not product performance gains.', '')
  }
  const clockProbe = JSON.parse(await readFile(path.join(root, 'scripts/perf-lab/baselines/clock-capture.json'), 'utf8').catch(() => 'null'))
  if (clockProbe) {
    flow.push('', '## Synthetic clock capture overhead', '', `${clockProbe.scope} Evidence: ${clockProbe.evidence}.`, '', '| Probe | Calls | Execution ms | Shared buffer hits |', '| --- | --- | --- | --- |')
    for (const [name, sample] of Object.entries(clockProbe.samples)) flow.push(`| ${name} | ${clockProbe.callsPerSample} | ${sample.executionMs} | ${sample.sharedHitBlocks} |`)
    flow.push('', 'The archived clock probe keeps product plan logging at zero milliseconds. New bounded captures sample slow plans.', '')
  }
  const waiver = JSON.parse(await readFile(path.join(root, 'scripts/perf-lab/baselines/waiver-replay.json'), 'utf8').catch(() => 'null'))
  if (waiver) {
  flow.push('', '## Waiver replay before and after', '', waiver.cause, '', '| Capture | Starting FAAB | Available FAAB | Bid | HTTP | Evidence |', '| --- | --- | --- | --- | --- | --- |')
    for (const phase of ['before', 'after']) {
      const row = waiver[phase]
      flow.push(row ? `| ${phase} | ${row.startingBudget} | ${row.availableBudget} | ${row.bid} | ${row.status} | ${cell(row.evidence)} |` : `| ${phase} | unmeasured | unmeasured | unmeasured | unmeasured | pending replay |`)
    }
    flow.push('', 'The stored request body and server receipt are in `scripts/perf-lab/baselines/waiver-replay.json`. Request IDs and actors match in the before capture.', '')
  }
  flow.push(...runtimeLines)
  if (writeDocs) await writeFile(path.join(root, 'docs/data-flow.md'), `${flow.join('\n')}\n`)
  const controlCoverage = Object.fromEntries(['webkit'].map(engine => {
    const ids = new Set(receipts.filter(row => row[engine]?.passed).flatMap(row => (row[engine].interactions ?? []).filter(control => sequenceControlProved(control, row[engine])).map(control => control.id)))
    return [engine, { measured: work.controls.filter(control => ids.has(control.id)).length, total: work.controls.length }]
  }))
  const controlsComplete = Object.values(controlCoverage).every(row => row.measured === row.total) && discovered.size === 0
  const interactionRanking = [...new Set(observedControls.map(row => row.id))].map(id => {
    const samples = observedControls.filter(row => row.id === id && row.expectedReached && Number.isFinite(row.resultsMs))
    if (!samples.length) return null
    const average = key => samples.reduce((sum, row) => sum + row[key], 0) / samples.length
    return { id, frequency: samples.length, requests: average('requests'), bytesDown: average('bytesDown'), resultsMs: average('resultsMs'), weightedBytes: samples.reduce((sum, row) => sum + row.bytesDown, 0), overBudget: samples.filter(row => !row.budgetPassed).length }
  }).filter(Boolean).sort((a, b) => b.weightedBytes - a.weightedBytes)
  const report = { version: 1, fingerprint: work.fingerprint, total: results.length, passed, webkitPassed, failed: results.length - passed,
    closure,
    replayEvidence: replayRoot ? { root: replayRoot, source: replayReceipt?.source, retained: Boolean(retained), artifacts: retained?.artifacts ?? null } : null,
    capturePolicy: captureReceipt?.capturePolicy ?? null, sqlLog: captureReceipt?.sqlLog ?? null, simulationPassed, fullCapturePassed, simulationGatePassed, simulationProfile: simulation?.captureProfile ?? null, controlCoverage, unmappedControls: discovered.size, done: passed === results.length && simulationPassed && controlsComplete && captureReceipt?.captureComplete !== false,
    ranking: rankCosts(measurements.filter(row => !row.archivedSource)), archivedColdRanking: rankCosts(measurements.filter(row => row.archivedSource)), interactionRanking, networkRanking, startingNetwork, cohort, perScreen, replayNetwork, runtime, traffic, archived: archive,
    limitations: ['Frequency counts measured successful observations, not assumed production traffic.', 'installed iOS PWA: not proven on device. iPhone WebKit standalone emulation is the accepted stand-in.', 'A screenshot pair requires visual review before a lazy-load boundary is accepted.'] }
  if (evidenceRoot) {
    await json(path.join(evidenceRoot, 'baseline.json'), report)
    const summary = ['# Baseline measurements', '', `${passed}/${results.length} complete screen-state proofs. Results below cover only measured WebKit observations.`, '', '| Screen | Samples | Requests | Down bytes | Up bytes | DB ms | DB buffers | Cost × frequency (DB ms) |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...report.ranking.map(row => `| ${row.id} | ${row.frequency} | ${row.requests.toFixed(1)} | ${row.bytesIn.toFixed(0)} | ${row.bytesOut.toFixed(0)} | ${row.dbMs.toFixed(2)} | ${row.dbBuffers.toFixed(0)} | ${row.weightedDbMs.toFixed(2)} |`)]
    summary.push('', ...cohortLines, ...networkLines, '## Interaction cost × observed frequency', '', '| Control | Samples | Mean requests | Mean down bytes | Mean result ms | Total down bytes | Over budget |', '| --- | --- | --- | --- | --- | --- | --- |', ...interactionRanking.map(row => `| ${cell(row.id)} | ${row.frequency} | ${row.requests.toFixed(1)} | ${row.bytesDown.toFixed(0)} | ${row.resultsMs.toFixed(1)} | ${row.weightedBytes} | ${row.overBudget} |`), '', ...trafficLines, '', ...archiveLines, ...runtimeLines)
    const ranked = ['## Measured cost × frequency', '', ...summary.slice(4, 6 + report.ranking.length), '']
    if (writeDocs) await writeFile(path.join(root, 'docs/data-flow.md'), `${[...flow, '', ...ranked].join('\n')}\n`)
    await writeFile(path.join(evidenceRoot, 'baseline.md'), `${summary.join('\n')}\n`)
  }
  return { work, report }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const evidenceRoot = process.argv[2]
  const receipts = evidenceRoot ? JSON.parse(await readFile(path.join(evidenceRoot, 'walk.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error })) : []
  const simulation = evidenceRoot ? JSON.parse(await readFile(path.join(evidenceRoot, 'two-day.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return 'null'; throw error })) : null
  const { report } = await renderReport({ evidenceRoot, receipts, simulation })
  console.log(JSON.stringify({ fingerprint: report.fingerprint, total: report.total, passed: report.passed, simulationPassed: report.simulationPassed, controlCoverage: report.controlCoverage, done: report.done }))
  if (evidenceRoot && !report.done) process.exitCode = 1
}
