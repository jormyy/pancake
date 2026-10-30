import { expect, it } from 'vitest'
import { assessGain, assertFreshness, compareRegions, contract } from './pwa-live-game/contract.mjs'

it('freezes nonempty rendered score, roster and standings parity before tuning', () => {
    const baseline = { score: '201.5 199.0', roster: 'Manager A PG Jalen 12', standings: '1 Manager A 2-0' }
    compareRegions(baseline, { ...baseline })
    for (const region of contract.regions) {
        expect(() => compareRegions(baseline, { ...baseline, [region]: 'stale' })).toThrow(`Rendered ${region} differs`)
        expect(() => compareRegions({ ...baseline, [region]: '' }, baseline)).toThrow(`Missing baseline ${region}`)
    }
})

it('rejects a freshness regression and accepts unchanged timing', () => {
    assertFreshness([100, 100, 100, 100, 100], [100, 100, 100, 100, 100])
    expect(() => assertFreshness([100, 100, 100, 100, 100], [120, 120, 120, 120, 120])).toThrow('freshness regressed')
})

it('retains only gains greater than observed spread or ten percent', () => {
    expect(assessGain([100, 100, 100, 100, 100], [91, 91, 91, 91, 91]).passed).toBe(false)
    expect(assessGain([90, 100, 100, 100, 110], [85, 85, 85, 85, 85]).passed).toBe(false)
    expect(assessGain([100, 100, 100, 100, 100], [80, 80, 80, 80, 80]).passed).toBe(true)
    expect(() => assessGain([100], [80])).toThrow('five runs')
})
