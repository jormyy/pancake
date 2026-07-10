import { describe, expect, it } from 'vitest'
import { activeRosterOverflow } from '@/lib/roster-overflow'

describe('active roster overflow', () => {
    it.each([
        [20, 20, 0],
        [22, 20, 2],
        [18, 20, 0],
        [1, 0, 1],
    ])('maps %i active against a %i-player cap to %i excess', (active, cap, expected) => {
        expect(activeRosterOverflow(active, cap)).toBe(expected)
    })
})
