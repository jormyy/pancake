import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUCKETS, beginEarlyObserver, runPaintProbe, runPaintProbeEntry } from './e2e/pwa-paint-probe.mjs'
import { ownScenarioResource, releaseScenarioResource } from './e2e/scenario-resource-owner.mjs'

// Executable regressions for the two probe runs that measured nothing
// (phase 8: no scenario resource owner; phase 9: eval output is a JSON string
// literal). The fake browser goes through the real ownScenarioResource /
// releaseScenarioResource contract in createBrowser's order (release only
// after a close succeeds; dispose closes for real), double-encodes eval
// output exactly as agent-browser 0.25.4 prints it, and can fail `open` or
// `close` on demand.

const state = (overrides: Record<string, unknown> = {}) => ({
    path: '/roster', fcpByType: 40, paintByType: [{ name: 'first-paint', startTime: 30 }, { name: 'first-contentful-paint', startTime: 40 }],
    paintObserved: [{ name: 'first-contentful-paint', startTime: 40 }], paintEarly: null, shellMark: 6, mountMark: 30,
    visibilityState: 'visible', hasFocus: true, readyState: 'complete', prerendering: false, navigationType: 'navigate',
    navigationDuration: 100, paintTimingSupported: true, userAgent: 'fake', swControlled: true, rootTextLength: 10, ...overrides,
})
const encode = (value: unknown) => `${JSON.stringify(JSON.stringify(value))}\n`

type Call = { session: string; args: string[] }
type FakeOptions = {
    stateFor?: (session: string, evalIndex: number, expression: string) => Record<string, unknown>
    failOpen?: (session: string, url: string, openIndex: number) => boolean
    failClose?: (session: string) => boolean
    cdpUrl?: string
}
const fakeBrowserFactory = (calls: Call[], options: FakeOptions = {}) => () => {
    let evals = 0
    let opens = 0
    const closed = new Set<string>()
    const closeSession = async (session: string) => {
        if (options.failClose?.(session)) throw new Error(`close failed for ${session}`)
        closed.add(session)
    }
    return async (session: string, args: string[]) => {
        calls.push({ session, args })
        ownScenarioResource(`browser:${session}`, `browser session ${session}`, () => closeSession(session))
        if (args[0] === 'close') { await closeSession(session); releaseScenarioResource(`browser:${session}`); return '' }
        if (args[0] === 'open') { opens += 1; if (options.failOpen?.(session, args[1], opens)) throw new Error(`open failed: ${args[1]}`); return '' }
        if (args[0] === 'get' && args[1] === 'cdp-url') return options.cdpUrl ?? 'no endpoint here'
        if (args[0] === 'eval') {
            const expression = args[1]
            if (expression.includes('localStorage.clear')) return '"cleared"\n'
            const value = options.stateFor ? options.stateFor(session, evals++, expression) : (expression.includes('text: (document') ? { path: '/', text: 12 } : state())
            return encode(value)
        }
        return ''
    }
}

const env = { frontendUrl: 'http://127.0.0.1:8081', supabaseUrl: 'http://127.0.0.1:54321', anonKey: 'x' }
const temps: string[] = []
const tempDir = async () => { const dir = await mkdtemp(path.join(os.tmpdir(), 'paint-probe-')); temps.push(dir); return dir }
afterEach(async () => { await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
const base = (calls: Call[], options: FakeOptions = {}, extra: Record<string, unknown> = {}) =>
    ({ browserFactory: fakeBrowserFactory(calls, options), waitMs: 0, signedOut: true, env, log: () => {}, ...extra })

describe('pwa paint probe entry point', () => {
    it('fails outside a scenario resource owner exactly like phase-8 run 1', async () => {
        const calls: Call[] = []
        const { results } = await runPaintProbe({ ...base(calls), launches: 2, artifactDir: await tempDir() })
        expect(results.slice(0, 2).map((r) => r.bucket)).toEqual(['probe-error', 'probe-error'])
        expect(results[0].reason).toMatch(/Cannot own browser session .* without an active scenario resource owner/)
    })

    it('decodes double-encoded eval output, measures every launch once, owns and closes only its sessions', async () => {
        const calls: Call[] = []
        const artifactDir = await tempDir()
        const { failed, results, report } = await runPaintProbeEntry({ ...base(calls), launches: 6, artifactDir })
        expect(failed).toBe(0)
        expect(results.map((r) => r.mode)).toEqual(['fresh', 'reused', 'fresh', 'reused', 'fresh', 'reused'])
        expect(results.every((r) => r.measuredNavigationAttempts === 1)).toBe(true)
        // gate prelude ran on every fresh launch and once for the reused session
        expect(results.map((r) => r.prelude)).toEqual(['full gate prelude', 'full gate prelude', 'full gate prelude', 'none (session already signed in)', 'full gate prelude', 'none (session already signed in)'])
        expect(results.filter((r) => r.mode === 'fresh').every((r) => r.setupAttempts === 2)).toBe(true) // signed-out prelude: two opens of "/"
        const measuredOpens = calls.filter((c) => c.args[0] === 'open' && c.args[1].endsWith('/roster'))
        expect(measuredOpens).toHaveLength(6)
        const freshSessions = results.filter((r) => r.mode === 'fresh').map((r) => r.session)
        expect(new Set(freshSessions).size).toBe(3) // distinct fresh sessions
        const reused = new Set(results.filter((r) => r.mode === 'reused').map((r) => r.session))
        expect(reused.size).toBe(1)
        const closes = calls.filter((c) => c.args[0] === 'close').map((c) => c.session)
        expect(closes.sort()).toEqual([...freshSessions, ...reused].sort())
        expect(calls.some((c) => c.args.includes('--all'))).toBe(false)
        expect(calls.some((c) => c.args[0] === 'get' && c.args[1] === 'cdp-url')).toBe(true) // the probe asks for the endpoint
        expect(results.every((r) => r.earlyObserver?.registered === false && r.earlyObserver?.ran === false)).toBe(true)
        expect(report.summary.buckets.pass).toBe(6)
        expect(JSON.parse(await readFile(path.join(artifactDir, 'report.json'), 'utf8')).results).toHaveLength(6)
    })

    it('runs the signed-in prelude (sign-in page, credentials, 2000 ms settle) before the measured relaunch', async () => {
        const calls: Call[] = []
        const stateFor = (_session: string, _index: number, expression: string) => expression.includes('text: (document') ? { path: '/', text: 42 } : state()
        const { failed, results } = await runPaintProbeEntry({
            ...base(calls, { stateFor }), signedOut: false, launches: 2, artifactDir: await tempDir(),
            readState: async () => ({ users: [{ email: 'e2e@example.com' }], password: 'pw' }),
            env: { ...env, anonKey: 'x' }, verifySignIn: async () => ({ error: null }),
        })
        void failed
        const opens = calls.filter((c) => c.args[0] === 'open').map((c) => c.args[1])
        expect(opens.slice(0, 4)).toEqual(['http://127.0.0.1:8081/', 'http://127.0.0.1:8081/', 'http://127.0.0.1:8081/sign-in', 'http://127.0.0.1:8081/roster'])
        const waits = calls.filter((c) => c.args[0] === 'wait').map((c) => c.args[1])
        expect(waits.indexOf('2500')).toBeGreaterThan(-1) // signed-out relaunch settle
        expect(waits.indexOf('2000')).toBeGreaterThan(waits.indexOf('2500')) // post-sign-in settle, after it
        expect(results[0].setupAttempts).toBe(3)
        expect(results[1].prelude).toBe('full gate prelude')
        expect(results[1].setupAttempts).toBe(3)
    })

    it('records a failed measured navigation as one attempt with no retry, and still closes the fresh session', async () => {
        const calls: Call[] = []
        const { results } = await runPaintProbeEntry({ ...base(calls, { failOpen: (_s, url) => url.endsWith('/roster') }), launches: 1, artifactDir: await tempDir() })
        expect(results[0]).toMatchObject({ status: 'FAIL', bucket: 'probe-error', measuredNavigationAttempts: 1 })
        expect(calls.filter((c) => c.args[0] === 'open' && c.args[1].endsWith('/roster'))).toHaveLength(1)
        expect(calls.filter((c) => c.args[0] === 'close').map((c) => c.session)).toContain(results[0].session)
    })

    it('records a failed setup with its attempt count', async () => {
        const calls: Call[] = []
        const { results } = await runPaintProbeEntry({ ...base(calls, { failOpen: (_s, url) => url.endsWith(':8081/') }), launches: 1, artifactDir: await tempDir() })
        expect(results[0].bucket).toBe('probe-error')
        expect(results[0].reason).toMatch(/setup navigation failed after 3 attempt/)
        expect(results[0].setupAttempts).toBe(3)
    })

    it('surfaces a fresh-session close failure in the record and in the owner cleanup', async () => {
        const calls: Call[] = []
        const artifactDir = await tempDir()
        let rejected: Error | null = null
        await runPaintProbeEntry({ ...base(calls, { failClose: (session) => session.includes('-fresh-') }), launches: 1, artifactDir }).catch((error) => { rejected = error })
        expect(rejected).not.toBeNull()
        expect(String(rejected)).toMatch(/resource cleanup failed/)
        const report = JSON.parse(await readFile(path.join(artifactDir, 'report.json'), 'utf8'))
        expect(report.results[0].closeError).toMatch(/close failed/)
    })

    it('keeps the gate on a missing entry and files it in exactly one bucket', async () => {
        const calls: Call[] = []
        const { failed, results, report } = await runPaintProbeEntry({
            ...base(calls, { stateFor: () => state({ fcpByType: null, paintByType: [], paintObserved: [] }) }), launches: 2, artifactDir: await tempDir(),
        })
        expect(failed).toBe(2)
        expect(results.map((r) => r.bucket)).toEqual(['missing:no-evidence', 'missing:no-evidence'])
        const total = BUCKETS.reduce((sum, bucket) => sum + report.summary.buckets[bucket], 0)
        expect(total).toBe(results.length)
    })
})

describe('early observer through CDP', () => {
    const fakeClient = (log: string[]) => ({
        send: async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
            log.push(`${method}${sessionId ? `@${sessionId}` : ''}`)
            if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 't1', type: 'page', url: 'http://127.0.0.1:8081/roster', attached: false }] }
            if (method === 'Target.attachToTarget') return { sessionId: 's1' }
            if (method === 'Page.addScriptToEvaluateOnNewDocument') { expect(String(params.source)).toContain("observe({ type: 'paint', buffered: true })"); return { identifier: '7' } }
            return {}
        },
        close: () => { log.push('close') },
    })

    it('registers before navigation, stays attached until finish, then removes the script and closes', async () => {
        const log: string[] = []
        const browser = async () => 'ws://127.0.0.1:9222/devtools/browser/abc'
        const handle = await beginEarlyObserver(browser as never, 'probe-session', { openClient: async () => fakeClient(log) as never })
        expect(handle.outcome).toMatchObject({ registered: true, identifier: '7', error: null, endpointHost: '127.0.0.1' })
        expect(log).toEqual(['Target.getTargets', 'Target.attachToTarget', 'Page.enable@s1', 'Page.addScriptToEvaluateOnNewDocument@s1'])
        expect(log.includes('close')).toBe(false) // still attached while the measured navigation runs
        await handle.finish()
        expect(log.slice(-2)).toEqual(['Page.removeScriptToEvaluateOnNewDocument@s1', 'close'])
        await handle.finish() // idempotent
        expect(log.filter((l) => l === 'close')).toHaveLength(1)
    })

    it('reports a missing endpoint as not registered instead of throwing, and finish is a no-op', async () => {
        const handle = await beginEarlyObserver((async () => 'nothing') as never, 'probe-session')
        expect(handle.outcome).toMatchObject({ registered: false, error: 'no CDP endpoint from agent-browser' })
        await expect(handle.finish()).resolves.toBeUndefined()
    })

    it('the probe marks the observer as ran only when the page exposed its store, and finishes it after the read', async () => {
        const calls: Call[] = []
        const log: string[] = []
        let ran = 0
        const earlyObserver = async () => ({ outcome: { registered: true, identifier: '7', error: null, endpointHost: '127.0.0.1' }, finish: async () => { log.push('finish'); ran += 1 } })
        const { results } = await runPaintProbeEntry({
            ...base(calls, { stateFor: (_s, i) => i === 0 ? state({ paintEarly: { installedAt: 1, entries: [{ name: 'first-contentful-paint', startTime: 40 }], error: null } }) : state({ paintEarly: null }) }),
            launches: 2, artifactDir: await tempDir(), earlyObserver: earlyObserver as never,
        })
        expect(results[0].earlyObserver).toMatchObject({ registered: true, ran: true })
        expect(results[1].earlyObserver).toMatchObject({ registered: true, ran: false }) // registered, but the page never exposed it
        expect(ran).toBe(2)
        const closeIndex = calls.findIndex((c) => c.args[0] === 'close')
        expect(log[0]).toBe('finish')
        expect(closeIndex).toBeGreaterThan(-1)
    })
})
