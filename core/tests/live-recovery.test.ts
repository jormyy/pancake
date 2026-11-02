import { describe, expect, it } from 'vitest'
import { nextLiveRecovery } from '../src/live/recovery'

describe('database recovery behind public live scores', () => {
    it('uses ten-minute saved-screen recovery and restores legacy recovery with the switch', () => {
        expect(nextLiveRecovery([{ status: 'InProgress' }], 0, true)).toBe(600000)
        expect(nextLiveRecovery([{ status: 'InProgress' }], 0, false)).toBe(20000)
    })
    it('keeps tipoff wakeup and stops for completed or postponed games', () => {
        const tip = 100000
        expect(nextLiveRecovery([{ status: 'Scheduled', game_time: new Date(tip).toISOString() }], 90000, true)).toBe(10000)
        expect(nextLiveRecovery([{ status: 'Final' }], tip, true)).toBeNull()
        expect(nextLiveRecovery([{ status: 'Scheduled', game_status_text: 'Postponed' }], tip, true)).toBeNull()
    })
})
