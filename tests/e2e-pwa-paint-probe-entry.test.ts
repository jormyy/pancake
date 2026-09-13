import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { installEarlyObserver, runPaintProbe, runPaintProbeEntry } from './e2e/pwa-paint-probe.mjs'
import { ownScenarioResource, releaseScenarioResource } from './e2e/scenario-resource-owner.mjs'

// Executable regression for phase-8 run 1: the probe's browser sessions must be
// owned by a scenario resource owner. The fake browser below goes through the
// real ownScenarioResource/releaseScenarioResource contract (the same calls
// createBrowser makes), so a probe that runs outside the owner fails the same
// way the real one did, and the entry wrapper is what makes it work.

const paintState = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    path: '/roster', fcpByType: 40, paintByType: [{ name: 'first-paint', startTime: 30 }, { name: 'first-contentful-paint', startTime: 40 }],
    paintObserved: [{ name: 'first-contentful-paint', startTime: 40 }], paintEarly: null, shellMark: 6, mountMark: 30,
    visibilityState: 'visible', hasFocus: true, readyState: 'complete', prerendering: false, navigationType: 'navigate',
    navigationDuration: 100, paintTimingSupported: true, userAgent: 'fake', swControlled: true, rootTextLength: 10, ...overrides,
})

type Call = { session: string; args: string[] }
const fakeBrowserFactory = (calls: Call[], stateFor: (session: string, index: number) => string) => () => {
    let evals = 0
    return async (session: string, args: string[]) => {
        calls.push({ session, args })
        ownScenarioResource(`browser:${session}`, `browser session ${session}`, async () => {})
        if (args[0] === 'close') releaseScenarioResource(`browser:${session}`)
        if (args[0] === 'get' && args[1] === 'cdp-url') return 'no endpoint here'
        if (args[0] === 'eval') return stateFor(session, evals++)
        return ''
    }
}

const env = { frontendUrl: 'http://127.0.0.1:8081', supabaseUrl: 'http://127.0.0.1:54321', anonKey: 'x' }

describe('pwa paint probe entry point', () => {
    it('fails outside a scenario resource owner exactly like phase-8 run 1', async () => {
        const calls: Call[] = []
        const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'paint-probe-'))
        const { results } = await runPaintProbe({ browserFactory: fakeBrowserFactory(calls, () => paintState()), launches: 2, waitMs: 0, signedOut: true, env, artifactDir, log: () => {} })
        expect(results.map((r) => r.status)).toEqual(['FAIL', 'FAIL'])
        expect(results[0].reason).toMatch(/Cannot own browser session .* without an active scenario resource owner/)
    })

    it('under the entry wrapper it measures every launch, owns only its sessions, and closes exactly those', async () => {
        const calls: Call[] = []
        const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'paint-probe-'))
        const { failed, results, report } = await runPaintProbeEntry({ browserFactory: fakeBrowserFactory(calls, () => paintState()), launches: 6, waitMs: 0, signedOut: true, env, artifactDir, log: () => {} })
        expect(failed).toBe(0)
        expect(results.map((r) => r.mode)).toEqual(['fresh', 'reused', 'fresh', 'reused', 'fresh', 'reused'])
        expect(results.every((r) => r.measuredNavigationAttempts === 1)).toBe(true)
        expect(results.every((r) => r.earlyObserver?.installed === false)).toBe(true)
        const opens = calls.filter((c) => c.args[0] === 'open')
        expect(opens).toHaveLength(6) // one measured navigation per launch, no retries
        const closes = calls.filter((c) => c.args[0] === 'close').map((c) => c.session)
        const freshSessions = results.filter((r) => r.mode === 'fresh').map((r) => r.session)
        const reused = new Set(results.filter((r) => r.mode === 'reused').map((r) => r.session))
        expect(reused.size).toBe(1) // one reused session across all reused launches
        expect(closes.sort()).toEqual([...freshSessions, ...reused].sort()) // each owned session closed once, nothing else
        expect(calls.some((c) => c.args.includes('--all'))).toBe(false)
        expect(report.summary.fresh.pass).toBe(3)
        expect(JSON.parse(await readFile(path.join(artifactDir, 'report.json'), 'utf8')).results).toHaveLength(6)
    })

    it('keeps the gate on a missing entry and labels the early-observer outcome', async () => {
        const calls: Call[] = []
        const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'paint-probe-'))
        const { failed, results } = await runPaintProbeEntry({
            browserFactory: fakeBrowserFactory(calls, () => paintState({ fcpByType: null, paintByType: [], paintObserved: [] })),
            launches: 1, waitMs: 0, signedOut: true, env, artifactDir, log: () => {},
        })
        expect(failed).toBe(1)
        expect(results[0].reason).toMatch(/no-late-reader-evidence/)
    })
})

describe('early observer through CDP', () => {
    it('registers the document-start observer through Page.addScriptToEvaluateOnNewDocument when the endpoint answers', async () => {
        const sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = []
        const fakeClient = {
            send: async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
                sent.push({ method, params, sessionId })
                if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 't1', type: 'page', url: 'http://127.0.0.1:8081/roster', attached: false }] }
                if (method === 'Target.attachToTarget') return { sessionId: 's1' }
                if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: '7' }
                return {}
            },
            close: () => {},
        }
        const browser = async () => 'ws://127.0.0.1:9222/devtools/page/abc'
        const outcome = await installEarlyObserver(browser as never, 'probe-session', { openClient: async () => fakeClient as never })
        expect(outcome).toEqual({ installed: true, identifier: '7', endpointHost: '127.0.0.1' })
        const registration = sent.find((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument')
        expect(registration?.sessionId).toBe('s1')
        expect(String(registration?.params.source)).toContain("observe({ type: 'paint', buffered: true })")
        expect(String(registration?.params.source)).toContain('window.__pancakePaintProbe')
    })

    it('reports a missing endpoint as not installed instead of throwing', async () => {
        const outcome = await installEarlyObserver((async () => 'nothing') as never, 'probe-session')
        expect(outcome).toEqual({ installed: false, error: 'no CDP endpoint from agent-browser' })
    })
})
