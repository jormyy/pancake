import { describe, expect, it } from 'vitest'
import { allocateLaunches, judgeLaunch, parseCount, parseWaitMs } from './e2e/pwa-paint-probe.mjs'

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

    it('keeps the product gate: non-finite or negative timing fails, over budget fails, within budget passes', () => {
        for (const missing of [null, undefined, NaN, Infinity, -Infinity, -1, '52']) {
            const verdict = judgeLaunch({ fcpByType: missing, paintObserved: [] } as never, 400)
            expect(verdict.status, String(missing)).toBe('FAIL')
            expect(verdict.reason, String(missing)).toMatch(/missing-timing: no-late-reader-evidence/)
        }
        expect(judgeLaunch({ fcpByType: null, paintObserved: [{ name: 'first-contentful-paint', startTime: 40 }] }, 400).reason)
            .toMatch(/present via late buffered observer/)
        expect(judgeLaunch({ fcpByType: 401, paintObserved: [] }, 400).status).toBe('FAIL')
        expect(judgeLaunch({ fcpByType: 400, paintObserved: [] }, 400).status).toBe('PASS')
        expect(judgeLaunch({ fcpByType: 52, paintObserved: [] }, 400)).toEqual({ status: 'PASS', reason: 'fcp 52ms <= 400ms' })
        expect(judgeLaunch({ fcpByType: 0, paintObserved: [] }, 400).status).toBe('PASS')
    })
})
