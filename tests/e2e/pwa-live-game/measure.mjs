import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { command } from '../../../scripts/perf-lab/process.mjs'
import { localKeys } from './database.mjs'
import { labRoot, project } from './common.mjs'
import { contract, compareRegions } from './contract.mjs'
import { automationBrowser, openManager, originProxy, regions, tabTour, tourStep, visibility } from './browser.mjs'
import { releaseServer } from './release-server.mjs'

assert.equal(process.env.DOCKER_CONTEXT, 'desktop-linux')
assert.equal(project, 'pt4bafablec1')
const pilot = process.argv.includes('--pilot')
const tourOnly = pilot && process.argv.includes('--tour-only')
const scenarios = process.env.PWA_SCENARIOS?.split(',') ?? (pilot ? ['home'] : Object.keys(contract.scenarios))
const arms = pilot && !process.argv.includes('--both') ? ['baseline'] : ['baseline', 'candidate']
const repetitions = pilot ? 1 : contract.runsPerArm
const windows = scenarios.flatMap(scenario => Array.from({ length: repetitions }, (_, repetition) => ({ scenario, repetition })))
const fixture = JSON.parse(await readFile(path.join(labRoot, 'seed/complete.json'), 'utf8'))
const keys = await localKeys()
const output = path.join(labRoot, pilot ? 'pilot' : 'measurements')
await mkdir(output, { recursive: true })
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stopping = true })
const servers = []
const artifacts = {}
let browser
let stopBrowser
const activeRuns = []
const log = value => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }))
const json = (file, value) => writeFile(path.join(output, file), `${JSON.stringify(value, null, 2)}\n`)
await json('managers.json', fixture.members.slice(0, contract.managers).map(member => member.id))
const sessions = async () => Promise.all(fixture.users.slice(0, contract.managers).map(async user => {
    const auth = createClient(keys.API_URL, keys.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data, error } = await auth.auth.signInWithPassword({ email: user.email, password: fixture.password })
    assert.equal(error, null)
    return data.session
}))
const expected = (tick, manager) => {
    const member = fixture.members[manager].id
    const matchup = tick.points.find(row => row.home === member || row.away === member)
    assert.ok(matchup, 'A manager must have a scored matchup')
    return [matchup.home === member ? matchup.homePoints : matchup.awayPoints, matchup.home === member ? matchup.awayPoints : matchup.homePoints].map(value => Number(value).toFixed(1)).join('\n')
}
let tickNumber = 0
const ingest = async () => {
    tickNumber++
    const result = await command('node', ['tests/e2e/pwa-live-game/ingest.mjs', String(tickNumber)], { timeout: 90000 })
    const resultLine = result.stdout.trim().split('\n').at(-1)
    const tick = JSON.parse(resultLine)
    log({ event: 'ingest', tick: tick.tick, rows: tick.rows, version: tick.scoreVersion })
    return tick
}
const tickResults = []
async function scoreCheckpoint(runs, tick, visible = true) {
    const until = Date.now() + 25000
    const remaining = new Set(runs.flatMap(run => run.managers.filter(manager => manager.page.url().replace(manager.origin, '').split('?')[0] === '/').map(manager => ({ run, manager }))))
    if (!visible) return
    while (remaining.size && Date.now() < until) {
        for (const item of [...remaining]) {
            const wanted = expected(tick, item.manager.manager)
            const history = await item.manager.page.evaluate(() => window['__pwaMeasure'].scores)
            const found = history.find(row => row.at >= tick.ingestedAt && row.text === wanted)
            if (found) {
                item.run.freshness.push(found.at - tick.ingestedAt)
                remaining.delete(item)
            }
        }
        if (remaining.size) await delay(100)
    }
    assert.equal(remaining.size, 0, `A score checkpoint failed after tick ${tick.tick}`)
    const groups = new Map()
    for (const run of runs) for (const manager of run.managers) {
        if (manager.page.url().replace(manager.origin, '').split('?')[0] !== '/') continue
        const score = await manager.page.getByTestId('matchup-score-card').innerText()
        const lineup = await manager.page.getByTestId('matchup-daily-total').innerText()
        const key = manager.manager
        const text = { score, lineup }
        if (groups.has(key)) assert.deepEqual(text, groups.get(key), `Home rendered data differs for manager ${key}`)
        else groups.set(key, text)
    }
    tickResults.push({ tick: tick.tick, ingestedAt: tick.ingestedAt, passed: true })
}
async function tourGate(runs, label) {
    const expectedByManager = new Map()
    const captures = await Promise.all(runs.flatMap(run => run.managers.map(async manager => ({ manager: manager.manager, value: await regions(manager) }))))
    for (const { manager, value } of captures) {
        if (expectedByManager.has(manager)) compareRegions(expectedByManager.get(manager), value)
        else expectedByManager.set(manager, value)
    }
    await json(`${label}-regions.json`, Object.fromEntries(expectedByManager))
    log({ event: 'region-gate', label, passed: true })
}
async function navigateTour(runs) {
    for (const step of tabTour) {
        const texts = await Promise.all(runs.flatMap(run => run.managers.map(async manager => ({ manager: manager.manager, text: await tourStep(manager, step) }))))
        if ('region' in step && step.region && step.region !== 'score') {
            const reference = new Map()
            for (const value of texts) {
                if (reference.has(value.manager)) assert.equal(value.text, reference.get(value.manager), `${step.region} parity during tab navigation`)
                else reference.set(value.manager, value.text)
            }
        }
        log({ event: 'navigate', ...step })
    }
}
async function negativeControls(manager) {
    const baseline = await regions(manager)
    for (const region of contract.regions) {
        const route = region === 'score' ? '/' : region === 'roster' ? '/roster' : '/league'
        const selector = region === 'score' ? '[data-testid="matchup-score-card"]' : region === 'roster' ? '#root' : '#league-standings-results'
        await manager.page.goto(`${manager.origin}${route}`, { waitUntil: 'domcontentloaded' })
        await manager.page.locator(selector).waitFor({ state: 'attached' })
        if (region === 'roster') await manager.page.getByRole('heading', { name: 'Roster', exact: true }).first().waitFor()
        await manager.page.locator(selector).evaluate(node => { node.textContent = 'DELIBERATELY STALE QUALITY CONTROL' })
        const changed = region === 'roster' ? await manager.page.locator('body').innerText() : await manager.page.locator(selector).innerText()
        assert.throws(() => compareRegions(baseline, { ...baseline, [region]: changed }), new RegExp(`Rendered ${region} differs`))
    }
    await json('negative-controls.json', { renderedScore: 'rejected', renderedRoster: 'rejected', renderedStandings: 'rejected', passed: true })
    log({ event: 'negative-controls', passed: true })
}
async function complete(run, end) {
    run.ended = Date.now()
    const samples = await Promise.all(run.managers.map(manager => manager.sample()))
    for (const [index, sample] of samples.entries()) assert.equal(sample.metrics.NavigationStart, run.initial[index].metrics.NavigationStart, 'Tab navigation must keep the measured document')
    const apiWire = (await readFile(path.join(labRoot, 'evidence/api-transfer.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(row => JSON.parse(row))
    const apiRequests = apiWire.flatMap(row => {
        const manager = run.managers.find(manager => manager.origin === row.origin)
        return manager ? [{ ...row, manager: manager.manager }] : []
    })
    const streams = run.requests.filter(row => row.method === 'WS').map(row => ({ ...row, at: Math.max(row.at, run.started), requestCount: row.at < run.started ? 0 : 1, decoded: row.decoded - (run.initialStreams.get(row) ?? 0) }))
    const requests = [...run.requests.filter(row => row.target === 'web'), ...streams, ...apiRequests].filter(row => row.at >= run.started && row.at <= run.ended)
    assert.ok(requests.some(row => row.method === 'WS' && row.decoded > 0), 'Realtime must exchange frames')
    const wire = (await readFile(path.join(labRoot, 'evidence/ws-transfer.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(row => JSON.parse(row))
    for (const manager of run.managers) {
        const row = requests.find(request => request.method === 'WS' && request.manager === manager.manager)
        if (row) row.transfer = wire.filter(event => event.origin === manager.origin && event.at >= run.started && event.at <= run.ended).reduce((total, event) => total + event.bytes, 0)
    }
    const duplicates = new Map()
    let duplicateCount = 0
    const endpoints = {}
    for (const row of requests.sort((left, right) => left.at - right.at)) {
        const key = `${row.manager}:${row.signature}`
        if (row.requestCount !== 0) {
            if (row.at - (duplicates.get(key) ?? 0) <= contract.duplicateWindowMs) duplicateCount++
            duplicates.set(key, row.at)
        }
        const endpoint = `${row.target} ${row.method} ${row.endpoint}`
        const values = endpoints[endpoint] ??= { requests: 0, transfer: 0, decoded: 0, failures: 0 }
        values.requests += row.requestCount ?? 1
        values.transfer += row.transfer
        values.decoded += row.decoded
        if (row.failure || row.status >= 400) values.failures++
    }
    const dbLines = (await readFile(path.join(labRoot, 'evidence/client-db-calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(row => JSON.parse(row))
    const clientDbCalls = dbLines.filter(row => run.managers.some(manager => manager.origin === row.origin) && row.at >= run.started && row.at <= run.ended)
    const directDbCalls = requests.filter(row => (row.endpoint.startsWith('/rest/v1/') || ['/auth/v1/user', '/auth/v1/token', '/auth/v1/logout'].includes(row.endpoint)) && row.method !== 'OPTIONS')
    const foreground = run.phases.find(phase => phase.event === 'foreground')?.at
    const foregroundVersionRequests = foreground ? requests.filter(row => row.at >= foreground && row.at <= foreground + 5000 && row.method === 'GET' && row.endpoint === '/functions/v1/api/version').length : 0
    const report = {
        arm: run.arm, scenario: run.scenario, repetition: run.repetition, started: run.started, ended: run.ended,
        buildSha: artifacts[run.arm].commitSha, bundleDigest: artifacts[run.arm].bundleDigest,
        durationMinutes: (run.ended - run.started) / 60000, managers: run.managers.length, concurrentOtherLanes: false,
        protocol: 'paired windows', simultaneousManagers: activeRuns.reduce((total, run) => total + run.managers.length, 0), members: fixture.members.slice(0, contract.managers).map(member => member.id),
        endpoints, duplicateCount, clientDbCalls: clientDbCalls.length + directDbCalls.length, clientDbEndpoints: [...clientDbCalls, ...directDbCalls].reduce((result, row) => ({ ...result, [row.endpoint]: (result[row.endpoint] ?? 0) + 1 }), {}),
        requests, phases: run.phases, foregroundVersionRequests,
        freshnessMs: run.freshness,
        managersMetrics: samples.map((sample, index) => ({ manager: index, heapStart: run.initial[index].heap, heapEnd: sample.heap,
            longTasks: sample.longTasks.filter(task => task.duration > 50 && task.at >= run.started).length,
            longTaskMs: sample.longTasks.filter(task => task.duration > 50 && task.at >= run.started).reduce((total, task) => total + task.duration, 0),
            taskSeconds: sample.metrics.TaskDuration - run.initial[index].metrics.TaskDuration,
            scriptSeconds: sample.metrics.ScriptDuration - run.initial[index].metrics.ScriptDuration,
            scores: sample.scores, errors: run.managers[index].errors })),
        reason: end,
    }
    await json(`${run.scenario}-${run.arm}-${run.repetition}.json`, report)
    log({ event: 'run-complete', scenario: run.scenario, arm: run.arm, repetition: run.repetition, requests: requests.length, dbCalls: report.clientDbCalls })
    return report
}
const awake = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
await json('owner.json', { pid: process.pid, project, scenarios, repetitions, protocol: 'paired windows', started: new Date().toISOString() })
try {
    for (const arm of arms) {
        const port = arm === 'baseline' ? 64990 : 64991
        const root = arm === 'baseline' ? path.join(labRoot, 'baseline/dist') : path.join(process.cwd(), 'dist')
        const server = await releaseServer(root, port, arm === 'baseline' ? contract.baseline : process.env.PWA_CANDIDATE_SHA)
        servers.push(server.child)
        artifacts[arm] = server.marker
    }
    const automation = await automationBrowser(labRoot)
    browser = automation.browser
    stopBrowser = automation.close
    for (const { scenario, repetition } of windows) {
        assert.ok(contract.scenarios[scenario])
        if (process.argv.includes('--resume')) {
            const previous = await readFile(path.join(output, `${scenario}-${repetition}-complete.json`), 'utf8').then(JSON.parse).catch(error => {
                if (error.code === 'ENOENT') return null
                throw error
            })
            if (previous) {
                assert.equal(previous.passed, true)
                assert.deepEqual([...previous.reports].sort(), arms.map(arm => `${scenario}-${arm}-${repetition}.json`).sort())
                for (const file of previous.reports) {
                    const report = JSON.parse(await readFile(path.join(output, file), 'utf8'))
                    assert.equal(report.reason, 'completed')
                    assert.equal(report.protocol, 'paired windows')
                    assert.equal(report.buildSha, artifacts[report.arm].commitSha)
                    assert.equal(report.bundleDigest, artifacts[report.arm].bundleDigest)
                }
                log({ event: 'preserved-pair', scenario, repetition })
                continue
            }
        }
        const auth = await sessions()
        const runs = []
        for (const arm of repetition % 2 ? [...arms].reverse() : arms) {
            assert.ok(!stopping, 'Measurement interrupted')
            const port = 64940 + runs.length * contract.managers
            const run = { arm, scenario, repetition, origin: `http://127.0.0.1:${port}`, started: Date.now(), requests: [], managers: [], freshness: [], phases: [] }
            const proxies = []
            run.closeProxy = async () => { for (const close of proxies) await close() }
            activeRuns.push(run)
            for (const [manager, session] of auth.entries()) {
                const origin = `http://pwa-${scenario}-${arm === 'baseline' ? 'b' : 'c'}-${repetition}-${manager}.localhost:${port + manager}`
                proxies.push(await originProxy(port + manager, arm === 'baseline' ? 64990 : 64991, run.requests, manager, new URL(origin).host))
                run.managers.push(await openManager(browser, origin, manager, session, scenario === 'phone', run.requests))
            }
            run.initial = await Promise.all(run.managers.map(manager => manager.sample()))
            runs.push(run)
            log({ event: 'run-start', scenario, arm, repetition })
        }
        const cover = await browser.contexts()[0].newPage()
        await cover.bringToFront()
        const browserCdp = await browser.newBrowserCDPSession()
        const processes = await browserCdp.send('SystemInfo.getProcessInfo')
        const renderers = processes.processInfo.filter(process => process.type === 'renderer').length
        assert.ok(renderers >= runs.length * contract.managers, 'Managers must have separate renderer processes')
        await json(`${scenario}-${repetition}-renderer-isolation.json`, { renderers, managers: runs.length * contract.managers, passed: true })
        await browserCdp.detach()
        const started = Date.now()
        for (const run of runs) {
            run.started = started
            run.initial = await Promise.all(run.managers.map(manager => manager.sample()))
            run.initialStreams = new Map(run.requests.filter(row => row.method === 'WS').map(row => [row, row.decoded]))
        }
        const minutes = tourOnly ? 0 : pilot ? 2 : contract.scenarios[scenario].minutes
        const deadline = started + minutes * 60000
        let lastNavigation = started
        let hidden = false
        let foregrounded = false
        let touring = false
        let checking = 0
        let latestTick
        let pumpError
        let pumpStopped = false
        const checkpoint = async tick => {
            checking++
            try { await scoreCheckpoint(runs, tick, scenario !== 'background' || !hidden || foregrounded) }
            finally { checking-- }
        }
        const pump = (async () => {
            let nextIngest = started
            while (!stopping && !pumpStopped && Date.now() < deadline) {
                if (Date.now() >= nextIngest) {
                    nextIngest += 45000
                    latestTick = await ingest()
                    if (!touring) await checkpoint(latestTick)
                }
                await delay(100)
            }
        })().catch(error => { pumpError = error })
        try { while (!stopping && Date.now() < deadline) {
            if (pumpError) throw pumpError
            const elapsed = Date.now() - started
            if (scenario === 'background' && !hidden && elapsed >= 30000) {
                for (const run of runs) run.phases.push({ event: 'hidden', at: Date.now() })
                await Promise.all(runs.flatMap(run => run.managers.map(manager => visibility(manager, true))))
                hidden = true
                log({ event: 'background', scenario })
            }
            if (scenario === 'background' && hidden && !foregrounded && elapsed >= 30000 + (pilot ? 20000 : 20 * 60000)) {
                for (const run of runs) run.phases.push({ event: 'foreground', at: Date.now() })
                await Promise.all(runs.flatMap(run => run.managers.map(manager => visibility(manager, false))))
                foregrounded = true
                log({ event: 'foreground', scenario })
            }
            if (scenario === 'tabs' && !checking && Date.now() - lastNavigation >= 3 * 60000) {
                touring = true
                await navigateTour(runs)
                touring = false
                if (latestTick) await checkpoint(latestTick)
                lastNavigation = Date.now()
            }
            await delay(500)
        } } finally { pumpStopped = true; await pump }
        if (pumpError) throw pumpError
        assert.ok(!stopping, 'Measurement interrupted')
        const reports = []
        if (!tourOnly) for (const run of runs) reports.push(await complete(run, 'completed'))
        if (pilot && (process.argv.includes('--tour') || tourOnly)) await navigateTour(runs)
        await tourGate(runs, `${scenario}-${repetition}`)
        if (pilot) await negativeControls(runs[0].managers[0])
        await json(`${scenario}-${repetition}-complete.json`, { reports: reports.map(report => `${report.scenario}-${report.arm}-${report.repetition}.json`), ticks: tickResults, passed: true })
        if (repetition === repetitions - 1) await json(`${scenario}-complete.json`, { repetitions, protocol: 'paired windows', ticks: tickResults, passed: true })
        await cover.close()
        for (const run of runs) {
            await Promise.all(run.managers.map(manager => manager.close()))
            await run.closeProxy()
            activeRuns.splice(activeRuns.indexOf(run), 1)
        }
    }
} catch (error) {
    await json('failure.json', { message: error.message, stack: error.stack })
    throw error
} finally {
    for (const run of activeRuns) {
        await Promise.all(run.managers.map(manager => manager.close().catch(() => {})))
        await run.closeProxy().catch(() => {})
    }
    await stopBrowser?.()
    for (const server of servers) server.kill('SIGTERM')
    awake.kill('SIGTERM')
}
