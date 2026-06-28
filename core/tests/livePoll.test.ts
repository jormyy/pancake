import { describe, expect, it } from 'vitest'
import {
    LIVE_POLL_LEASE_TTL_SECONDS,
    LIVE_POLL_LOCK_KEY,
    addDaysToETDate,
    dateFromETDate,
    livePollCandidateDates,
} from '../src/sync/livePoll'

describe('live poll sync policy', () => {
    it('keeps the shared lease policy stable', () => {
        expect(LIVE_POLL_LOCK_KEY).toBe(779001)
        expect(LIVE_POLL_LEASE_TTL_SECONDS).toBe(90)
    })

    it('builds yesterday and today ET candidate dates once', () => {
        expect(livePollCandidateDates(new Date('2026-06-28T03:30:00Z'))).toEqual([
            '2026-06-26',
            '2026-06-27',
        ])
        expect(livePollCandidateDates(new Date('2026-06-28T16:00:00Z'))).toEqual([
            '2026-06-27',
            '2026-06-28',
        ])
    })

    it('converts ET date keys through the noon UTC sync instant', () => {
        expect(addDaysToETDate('2026-03-01', -1)).toBe('2026-02-28')
        expect(dateFromETDate('2026-03-01').toISOString()).toBe('2026-03-01T12:00:00.000Z')
    })
})
