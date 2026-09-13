import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { BUCKETS, allocateLaunches, isLoopbackUrl, judgeLaunch, parseCount, parseEvalJson, parseWaitMs, readArg } from './e2e/pwa-paint-probe.mjs'

describe('pwa paint probe', () => {
    it('interleaves fresh and reused launches evenly', () => {
        const launches = allocateLaunches(20)
        expect(launches.filter((l) => l.mode === 'fresh')).toHaveLength(10)
        expect(launches.filter((l) => l.mode === 'reused')).toHaveLength(10)
        expect(launches.slice(0, 4).map((l) => l.mode)).toEqual(['fresh', 'reused', 'fresh', 'reused'])
    })

    it('rejects launch counts that are not finite positive integers', () => {
        for (const bad of [0, -1, 1.5, NaN, Infinity, 'x', undefined]) {
            expect(() => parseCount(bad as never), String(bad)).toThrow(RangeError)
            expect(() => allocateLaunches(bad as never), String(bad)).toThrow(RangeError)
        }
        expect(parseCount('20')).toBe(20)
    })

    it('rejects waits that are not finite and non-negative', () => {
        for (const bad of [-1, NaN, Infinity, 'x']) expect(() => parseWaitMs(bad as never), String(bad)).toThrow(RangeError)
        expect(parseWaitMs('0')).toBe(0)
        expect(parseWaitMs(3000)).toBe(3000)
    })

    it('reads --name=value and --name value, and refuses a bare flag', () => {
        expect(readArg(['--launches=7'], 'launches', 20)).toBe('7')
        expect(readArg(['--launches', '7'], 'launches', 20)).toBe('7')
        expect(readArg([], 'launches', 20)).toBe(20)
        expect(() => readArg(['--launches'], 'launches', 20)).toThrow(RangeError)
        expect(() => readArg(['--launches', '--signed-out'], 'launches', 20)).toThrow(RangeError)
    })

    it('treats every loopback spelling as local', () => {
        for (const url of ['http://127.0.0.1:8081', 'http://localhost:8081', 'http://[::1]:8081']) expect(isLoopbackUrl(url), url).toBe(true)
        expect(isLoopbackUrl('https://ceeytbfmwsnzalxlkalc.supabase.co')).toBe(false)
        expect(isLoopbackUrl('nonsense')).toBe(false)
    })

    it('decodes the real double-encoded agent-browser eval output (phase-9 raw sample)', async () => {
        const raw = await readFile('tests/fixtures/agent-browser-eval-sample.txt', 'utf8')
        expect(raw.startsWith('"{\\"path\\"')).toBe(true) // the literal bytes agent-browser printed
        expect(parseEvalJson(raw)).toEqual({ path: '/sign-in', text: 605 })
        expect(parseEvalJson('noise line\n"{\\"a\\":1}"\n')).toEqual({ a: 1 })
        expect(parseEvalJson('{"a":1}')).toEqual({ a: 1 })
        expect(() => parseEvalJson('')).toThrow(/no output/)
    })

    it('keeps the product gate: non-finite or negative timing fails, over budget fails, within budget passes', () => {
        for (const missing of [null, undefined, NaN, Infinity, -Infinity, -1, '52']) {
            const verdict = judgeLaunch({ fcpByType: missing, paintObserved: [], paintEarly: null } as never, 400)
            expect(verdict.status, String(missing)).toBe('FAIL')
            expect(verdict.bucket, String(missing)).toBe('missing:no-evidence')
        }
        expect(judgeLaunch({ fcpByType: 401, paintObserved: [], paintEarly: null }, 400)).toMatchObject({ status: 'FAIL', bucket: 'budget' })
        expect(judgeLaunch({ fcpByType: 400, paintObserved: [], paintEarly: null }, 400)).toMatchObject({ status: 'PASS', bucket: 'pass' })
        expect(judgeLaunch({ fcpByType: 52, paintObserved: [], paintEarly: null }, 400)).toEqual({ status: 'PASS', bucket: 'pass', reason: 'fcp 52ms <= 400ms' })
        expect(judgeLaunch({ fcpByType: 0, paintObserved: [], paintEarly: null }, 400).status).toBe('PASS')
    })

    it('never passes on early-observer evidence alone, and files each missing case in one bucket', () => {
        const fcpEntry = [{ name: 'first-contentful-paint', startTime: 40 }]
        expect(judgeLaunch({ fcpByType: null, paintObserved: [], paintEarly: { entries: fcpEntry, error: null } }, 400)).toMatchObject({ status: 'FAIL', bucket: 'missing:early-saw' })
        expect(judgeLaunch({ fcpByType: null, paintObserved: fcpEntry, paintEarly: { entries: fcpEntry, error: null } }, 400)).toMatchObject({ status: 'FAIL', bucket: 'missing:early-saw' })
        expect(judgeLaunch({ fcpByType: null, paintObserved: [], paintEarly: { entries: [], error: null } }, 400)).toMatchObject({ status: 'FAIL', bucket: 'missing:early-none' })
        expect(judgeLaunch({ fcpByType: null, paintObserved: fcpEntry, paintEarly: { entries: [], error: null } }, 400)).toMatchObject({ status: 'FAIL', bucket: 'missing:early-none' })
        expect(judgeLaunch({ fcpByType: null, paintObserved: [], paintEarly: { entries: [], error: 'observe threw' } }, 400)).toMatchObject({ status: 'FAIL', bucket: 'missing:early-error' })
        expect(judgeLaunch({ fcpByType: null, paintObserved: fcpEntry, paintEarly: null }, 400)).toMatchObject({ status: 'FAIL', bucket: 'missing:late-observer-saw' })
        expect(judgeLaunch({ fcpByType: null, paintObserved: [], paintEarly: null }, 400)).toMatchObject({ status: 'FAIL', bucket: 'missing:no-evidence' })
        // a real FCP wins regardless of what the observers saw
        expect(judgeLaunch({ fcpByType: 30, paintObserved: [], paintEarly: { entries: [], error: 'x' } }, 400).bucket).toBe('pass')
        expect(BUCKETS).toHaveLength(8)
    })
})
