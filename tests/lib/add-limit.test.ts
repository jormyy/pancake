import { describe, expect, it } from 'vitest'
import {
    addLimitBlockedMessage,
    addLimitBlockedReason,
    addLimitSummary,
    classifyPickupError,
    formatAddLimitReset,
    getAddLimitStatus,
    type AddLimitSource,
} from '@/lib/add-limit'
import { RequestError } from '@/lib/shared/errors'

// Midnight ET on Monday 2026-11-02 (EST, UTC-5).
const RESET = '2026-11-02T05:00:00.000Z'
const BEFORE_RESET = Date.parse('2026-11-01T20:00:00.000Z')
const AFTER_RESET = Date.parse('2026-11-02T05:00:01.000Z')

const state = (overrides: Partial<AddLimitSource> = {}): AddLimitSource => ({
    weeklyAddLimit: 7,
    weeklyAddCount: 7,
    addLimitResetsAt: RESET,
    addWeekTimeZone: 'America/New_York',
    ...overrides,
})

describe('getAddLimitStatus', () => {
    it('reports a reached limit with the reset instant', () => {
        const status = getAddLimitStatus(state(), BEFORE_RESET)
        expect(status).toMatchObject({ limit: 7, used: 7, reached: true, timeZone: 'America/New_York' })
        expect(status?.resetsAt?.toISOString()).toBe(RESET)
    })

    it('treats a count from an ended week as stale and available again', () => {
        expect(getAddLimitStatus(state(), AFTER_RESET)).toMatchObject({ used: 0, reached: false, resetsAt: null })
    })

    it('is null for unlimited leagues and missing state', () => {
        expect(getAddLimitStatus(state({ weeklyAddLimit: null }))).toBeNull()
        expect(getAddLimitStatus(null)).toBeNull()
    })

    it('ignores a malformed reset timestamp', () => {
        expect(getAddLimitStatus(state({ addLimitResetsAt: 'not-a-date', weeklyAddCount: 3 }), BEFORE_RESET))
            .toMatchObject({ used: 3, reached: false, resetsAt: null })
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
        expect(addLimitSummary(state(), BEFORE_RESET)).toBe('Adds 7/7 · resets Mon 12:00 AM ET')
    })

    it('derives the blocked reason only while the limit is reached', () => {
        expect(addLimitBlockedReason(state(), BEFORE_RESET)).toMatch(/^You've used all 7 of this week's adds\./)
        expect(addLimitBlockedReason(state({ weeklyAddCount: 6 }), BEFORE_RESET)).toBeNull()
        expect(addLimitBlockedReason(state(), AFTER_RESET)).toBeNull()
        expect(addLimitBlockedReason(null)).toBeNull()
    })

    it('summarizes unknown, unlimited, reached, and open states', () => {
        expect(addLimitSummary(null)).toBe('Adds —/—')
        expect(addLimitSummary(state({ weeklyAddLimit: null, weeklyAddCount: 9 }))).toBe('Adds 9/∞')
        expect(addLimitSummary(state({ addLimitResetsAt: null }), BEFORE_RESET)).toBe('Adds 7/7 · limit reached')
        expect(addLimitSummary(state({ weeklyAddCount: 2 }), BEFORE_RESET)).toBe('Adds 2/7')
    })

    it('falls back when the reset is unknown', () => {
        const status = getAddLimitStatus(state({ addLimitResetsAt: null }), BEFORE_RESET)!
        expect(addLimitBlockedMessage(status)).toBe("You've used all 7 of this week's adds. Adds reset when the next week starts.")
    })
})

describe('classifyPickupError', () => {
    it('recognizes the weekly limit by its SQLSTATE from either request path', () => {
        const message = 'Weekly add limit reached (7/7 adds used this week). Adds reset Mon, Nov 2 at 12:00 AM ET.'
        expect(classifyPickupError(new RequestError(message, { code: 'PA001', status: 400 })))
            .toEqual({ limitReached: true, onWaivers: false, title: 'Weekly add limit reached', message })
        expect(classifyPickupError({ message, code: 'PA001' }))
            .toEqual({ limitReached: true, onWaivers: false, title: 'Weekly add limit reached', message })
    })

    it('recognizes a player the server still holds on waivers by its SQLSTATE', () => {
        const message = 'This player is on waivers - submit a waiver claim instead.'
        expect(classifyPickupError(new RequestError(message, { code: 'PA002', status: 400 })))
            .toEqual({ limitReached: false, onWaivers: true, title: 'Still on waivers', message })
    })

    it('leaves every other failure on the generic path', () => {
        expect(classifyPickupError(new RequestError('Your active roster is full (20 players).', { code: 'P0001' })))
            .toEqual({ limitReached: false, onWaivers: false, title: 'Error', message: 'Your active roster is full (20 players).' })
        expect(classifyPickupError(new Error('offline'))).toEqual({ limitReached: false, onWaivers: false, title: 'Error', message: 'offline' })
    })
})
