import { describe, expect, it } from 'vitest'
import {
    addLimitBlockedMessage,
    addLimitSummary,
    formatAddLimitReset,
    getAddLimitStatus,
    isAddLimitError,
} from '@/lib/add-limit'

// Midnight ET on Monday 2026-11-02 (EST, UTC-5).
const RESET = '2026-11-02T05:00:00.000Z'
const BEFORE_RESET = Date.parse('2026-11-01T20:00:00.000Z')
const AFTER_RESET = Date.parse('2026-11-02T05:00:01.000Z')

const state = (overrides: Partial<Parameters<typeof getAddLimitStatus>[0] & object> = {}) => ({
    weeklyAddLimit: 7,
    weeklyAddCount: 7,
    addLimitResetsAt: RESET,
    addWeekTimeZone: 'America/New_York',
    ...overrides,
})

describe('getAddLimitStatus', () => {
    it('reports a reached limit with the reset instant', () => {
        const status = getAddLimitStatus(state(), BEFORE_RESET)
        expect(status).toMatchObject({ limit: 7, used: 7, remaining: 0, reached: true, timeZone: 'America/New_York' })
        expect(status?.resetsAt?.toISOString()).toBe(RESET)
    })

    it('treats a count from an ended week as stale and available again', () => {
        const status = getAddLimitStatus(state(), AFTER_RESET)
        expect(status).toMatchObject({ used: 0, remaining: 7, reached: false, resetsAt: null })
    })

    it('is null for unlimited leagues and missing state', () => {
        expect(getAddLimitStatus(state({ weeklyAddLimit: null }))).toBeNull()
        expect(getAddLimitStatus(null)).toBeNull()
    })

    it('ignores a malformed reset timestamp', () => {
        const status = getAddLimitStatus(state({ addLimitResetsAt: 'not-a-date', weeklyAddCount: 3 }), BEFORE_RESET)
        expect(status).toMatchObject({ used: 3, remaining: 4, reached: false, resetsAt: null })
    })
})

describe('formatAddLimitReset', () => {
    const status = getAddLimitStatus(state(), BEFORE_RESET)!

    it('formats the league boundary in ET', () => {
        expect(formatAddLimitReset(status, { localTimeZone: 'America/New_York' })).toBe('Mon, Nov 2 at 12:00 AM ET')
        expect(formatAddLimitReset(status, { style: 'short' })).toBe('Mon 12:00 AM ET')
    })

    it('adds the viewer local time when it differs', () => {
        expect(formatAddLimitReset(status, { localTimeZone: 'America/Los_Angeles' }))
            .toBe('Mon, Nov 2 at 12:00 AM ET (Sun, Nov 1 at 9:00 PM PST)')
    })

    it('is null without a known reset', () => {
        expect(formatAddLimitReset({ resetsAt: null, timeZone: 'America/New_York' })).toBeNull()
    })
})

describe('messages', () => {
    it('explains the block and the next eligible time', () => {
        const status = getAddLimitStatus(state(), BEFORE_RESET)!
        expect(addLimitBlockedMessage(status, { localTimeZone: 'America/Chicago' }))
            .toBe("You've used all 7 of this week's adds. Adds reset Mon, Nov 2 at 12:00 AM ET (Sun, Nov 1 at 11:00 PM CST).")
        expect(addLimitSummary(status)).toBe('Adds 7/7 · resets Mon 12:00 AM ET')
    })

    it('falls back when the reset is unknown', () => {
        const status = getAddLimitStatus(state({ addLimitResetsAt: null }), BEFORE_RESET)!
        expect(addLimitBlockedMessage(status)).toBe("You've used all 7 of this week's adds. Adds reset when the next week starts.")
        expect(addLimitSummary(status)).toBe('Adds 7/7 · limit reached')
        expect(addLimitSummary(getAddLimitStatus(state({ weeklyAddCount: 2 }), BEFORE_RESET)!)).toBe('Adds 2/7')
    })

    it('recognizes the server rejection', () => {
        expect(isAddLimitError('Weekly add limit reached (7/7 adds used this week). Adds reset Mon, Nov 2 at 12:00 AM ET.')).toBe(true)
        expect(isAddLimitError('Your active roster is full (20 players).')).toBe(false)
    })
})
