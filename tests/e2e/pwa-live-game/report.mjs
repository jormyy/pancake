import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { labRoot } from './common.mjs'
import { assessGain, assertFreshness, contract } from './contract.mjs'

const directory = path.join(labRoot, 'measurements')
const ticks = (await readFile(path.join(labRoot, 'evidence/ingest-ticks.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(row => JSON.parse(row))
const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]
const spread = values => {
    const minimum = Math.min(...values)
    const maximum = Math.max(...values)
    const middle = median(values)
    return { minimum, maximum, absolute: maximum - minimum, relative: middle ? (maximum - minimum) / middle : 0 }
}
const p95 = values => [...values].sort((left, right) => left - right)[Math.min(values.length - 1, Math.floor(values.length * 0.95))]
const catchup = report => {
    const foreground = report.phases.find(phase => phase.event === 'foreground').at
    const tick = ticks.filter(tick => tick.ingestedAt <= foreground).at(-1)
    assert.ok(tick && foreground - tick.ingestedAt <= 60000, 'Foreground must have a recent ingest checkpoint')
    return p95(report.managersMetrics.map(manager => {
        const member = report.members[manager.manager]
        const matchup = tick.points.find(matchup => matchup.home === member || matchup.away === member)
        const wanted = [matchup.home === member ? matchup.homePoints : matchup.awayPoints, matchup.home === member ? matchup.awayPoints : matchup.homePoints].map(value => Number(value).toFixed(1)).join('\n')
        const score = manager.scores.find(score => score.at >= foreground && score.text === wanted)
        assert.ok(score, 'The newest hidden score must be rendered on foreground')
        return score.at - foreground
    }))
}
const totals = report => Object.values(report.endpoints).reduce((sum, row) => ({ requests: sum.requests + row.requests, transfer: sum.transfer + row.transfer, decoded: sum.decoded + row.decoded }), { requests: 0, transfer: 0, decoded: 0 })
const metrics = report => {
    const scale = report.durationMinutes * report.managers
    const values = totals(report)
    return {
        'Requests/min': values.requests / scale,
        'Transfer bytes/min': values.transfer / scale,
        'Decoded bytes/min': values.decoded / scale,
        'Client DB calls/min': report.clientDbCalls / scale,
        'Duplicates/min': report.duplicateCount / scale,
        'Long tasks/min': report.managersMetrics.reduce((sum, manager) => sum + manager.longTasks, 0) / scale,
        'Main thread task seconds/min': report.managersMetrics.reduce((sum, manager) => sum + manager.taskSeconds, 0) / scale,
        'Main thread script seconds/min': report.managersMetrics.reduce((sum, manager) => sum + manager.scriptSeconds, 0) / scale,
        'Heap start MiB': median(report.managersMetrics.map(manager => manager.heapStart / 1048576)),
        'Heap end MiB': median(report.managersMetrics.map(manager => manager.heapEnd / 1048576)),
        'Score p95 ms': p95(report.freshnessMs),
        ...(report.scenario === 'background' ? { 'Foreground version requests per manager': report.foregroundVersionRequests / report.managers, 'Foreground catch-up p95 ms': catchup(report) } : {}),
    }
}
const scenarios = process.env.PWA_SCENARIOS?.split(',') ?? Object.keys(contract.scenarios)
const lines = ['# PWA live game measurement results', '', 'All rates are per manager. Baseline and candidate starts alternate. A paired window has three managers per arm. Five paired windows run sequentially. The Mac runs have no other project in Docker. Earlier discarded mini setup attempts overlapped other lanes. Every manager has a separate localhost origin and renderer. The measured interval starts after all initial Home loads. Transfer counts response headers and encoded response bodies, plus received WebSocket bytes. Decoded counts response bodies and received WebSocket payloads. Client DB calls count logical REST transactions and GoTrue lookups, including calls made by client-triggered Edge handlers. Nested SQL statements and Realtime subscription authorization SQL are not counted separately. Heap is sampled without forcing garbage collection. Retention requires both total requests and client DB calls to improve beyond noise, plus rendered parity and score freshness. Spread is the full range divided by the median.', '']
const results = []
for (const scenario of scenarios) {
    assert.ok(contract.scenarios[scenario])
    const complete = JSON.parse(await readFile(path.join(directory, `${scenario}-complete.json`), 'utf8'))
    assert.equal(complete.passed, true)
    assert.equal(complete.repetitions, contract.runsPerArm)
    assert.equal(complete.protocol, 'paired windows')
    for (let repetition = 0; repetition < contract.runsPerArm; repetition++) {
        const pair = JSON.parse(await readFile(path.join(directory, `${scenario}-${repetition}-complete.json`), 'utf8'))
        assert.equal(pair.passed, true)
        assert.deepEqual([...pair.reports].sort(), ['baseline', 'candidate'].map(arm => `${scenario}-${arm}-${repetition}.json`))
    }
    const arms = {}
    for (const arm of ['baseline', 'candidate']) {
        arms[arm] = await Promise.all(Array.from({ length: contract.runsPerArm }, (_, repetition) => readFile(path.join(directory, `${scenario}-${arm}-${repetition}.json`), 'utf8').then(JSON.parse)))
        assert.ok(arms[arm].every(report => report.reason === 'completed' && report.protocol === 'paired windows' && report.simultaneousManagers === 6 && report.managers === 3 && report.managersMetrics.every(manager => manager.errors.length === 0)), 'All paired runs must complete without browser errors')
        assert.ok(arms[arm].every(report => report.buildSha === arms[arm][0].buildSha && report.bundleDigest === arms[arm][0].bundleDigest && report.durationMinutes >= contract.scenarios[scenario].minutes), 'Every arm must use one frozen artifact and the full duration')
    }
    assert.equal(arms.baseline[0].buildSha, contract.baseline)
    if (process.env.PWA_CANDIDATE_SHA) assert.equal(arms.candidate[0].buildSha, process.env.PWA_CANDIDATE_SHA)
    const baseline = arms.baseline.map(metrics)
    const candidate = arms.candidate.map(metrics)
    assertFreshness(baseline.map(row => row['Score p95 ms']), candidate.map(row => row['Score p95 ms']))
    if (scenario === 'background') assertFreshness(baseline.map(row => row['Foreground catch-up p95 ms']), candidate.map(row => row['Foreground catch-up p95 ms']))
    lines.push(`## ${scenario}`, '', '| Metric | Baseline median | Baseline spread | Candidate median | Candidate spread | Noise | Change |', '| --- | ---: | ---: | ---: | ---: | ---: | --- |')
    for (const metric of Object.keys(baseline[0])) {
        const before = baseline.map(row => row[metric])
        const after = candidate.map(row => row[metric])
        const result = assessGain(before, after)
        const beforeSpread = spread(before)
        const afterSpread = spread(after)
        results.push({ scenario, metric, ...result, beforeSpread, afterSpread, baseline: before, candidate: after })
        lines.push(`| ${metric} | ${result.before.toFixed(3)} | ${beforeSpread.absolute.toFixed(3)} (${(beforeSpread.relative * 100).toFixed(1)}%) | ${result.after.toFixed(3)} | ${afterSpread.absolute.toFixed(3)} (${(afterSpread.relative * 100).toFixed(1)}%) | ${(result.threshold * 100).toFixed(1)}% | ${(result.gain * 100).toFixed(1)}%${result.passed ? ' beyond noise' : ' within noise'} |`)
    }
    lines.push('', '| Endpoint | Baseline requests/min | Candidate requests/min | Baseline transfer bytes/min | Candidate transfer bytes/min | Baseline decoded bytes/min | Candidate decoded bytes/min |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
    const endpoints = new Set([...arms.baseline, ...arms.candidate].flatMap(report => Object.keys(report.endpoints)))
    for (const endpoint of [...endpoints].sort()) {
        const rate = (arm, field) => median(arms[arm].map(report => (report.endpoints[endpoint]?.[field] ?? 0) / (report.durationMinutes * report.managers)))
        lines.push(`| ${endpoint} | ${rate('baseline', 'requests').toFixed(3)} | ${rate('candidate', 'requests').toFixed(3)} | ${rate('baseline', 'transfer').toFixed(1)} | ${rate('candidate', 'transfer').toFixed(1)} | ${rate('baseline', 'decoded').toFixed(1)} | ${rate('candidate', 'decoded').toFixed(1)} |`)
    }
    lines.push('', '| Client-caused DB endpoint | Baseline calls/min | Candidate calls/min |', '| --- | ---: | ---: |')
    const dbEndpoints = new Set([...arms.baseline, ...arms.candidate].flatMap(report => Object.keys(report.clientDbEndpoints)))
    for (const endpoint of [...dbEndpoints].sort()) {
        const rate = arm => median(arms[arm].map(report => (report.clientDbEndpoints[endpoint] ?? 0) / (report.durationMinutes * report.managers)))
        lines.push(`| ${endpoint} | ${rate('baseline').toFixed(3)} | ${rate('candidate').toFixed(3)} |`)
    }
    lines.push('')
}
await writeFile(path.join(directory, 'summary.md'), `${lines.join('\n')}\n`)
await writeFile(path.join(directory, 'summary.json'), `${JSON.stringify(results, null, 2)}\n`)
const required = results.filter(row => ['Requests/min', 'Client DB calls/min'].includes(row.metric))
const decision = { scenarios, runsPerArm: contract.runsPerArm, renderedParity: 'passed', freshness: 'passed', kept: required.every(row => row.passed), required }
await writeFile(path.join(directory, 'decision.json'), `${JSON.stringify(decision, null, 2)}\n`)
console.log(JSON.stringify(decision))
