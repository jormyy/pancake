import { describe, expect, it } from 'vitest'
import { allocateLaunches, judgeLaunch } from './e2e/pwa-paint-probe.mjs'

describe('pwa paint probe', () => {
    it('interleaves fresh and reused launches evenly', () => {
        const launches = allocateLaunches(20)
        expect(launches.filter((l) => l.mode === 'fresh')).toHaveLength(10)
        expect(launches.filter((l) => l.mode === 'reused')).toHaveLength(10)
        expect(launches.slice(0, 4).map((l) => l.mode)).toEqual(['fresh', 'reused', 'fresh', 'reused'])
    })

    it('keeps the product gate: missing timing fails, over budget fails, within budget passes', () => {
        const base = { fcpByType: null }
        expect(judgeLaunch(base, 400).status).toBe('FAIL')
        expect(judgeLaunch(base, 400).reason).toMatch(/missing-timing/)
        expect(judgeLaunch({ fcpByType: 401 }, 400).status).toBe('FAIL')
        expect(judgeLaunch({ fcpByType: 52 }, 400)).toEqual({ status: 'PASS', reason: 'fcp 52ms <= 400ms' })
    })
})
