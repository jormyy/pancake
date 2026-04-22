import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/transactions', () => ({ logTransaction: vi.fn(), getLeagueTransactions: vi.fn(), TRANSACTION_LABELS: {} }))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeasonId: vi.fn(), getActiveSeasonId: vi.fn(), getCurrentSeason: vi.fn(), currentSeasonYear: vi.fn() }))

import { isIREligible, isDTD, isTaxiEligible } from '@/lib/roster'
import type { RosterPlayer } from '@/lib/roster'

describe('isIREligible', () => {
    it('returns true for "out"', () => expect(isIREligible('out')).toBe(true))
    it('returns true for "Out" (case insensitive)', () => expect(isIREligible('Out')).toBe(true))
    it('returns true for "OUT"', () => expect(isIREligible('OUT')).toBe(true))
    it('returns true for "IR"', () => expect(isIREligible('IR')).toBe(true))
    it('returns true for "IR-LTI"', () => expect(isIREligible('IR-LTI')).toBe(true))
    it('returns true for "ir-out"', () => expect(isIREligible('ir-out')).toBe(true))
    it('returns false for "DTD"', () => expect(isIREligible('DTD')).toBe(false))
    it('returns false for "dtd"', () => expect(isIREligible('dtd')).toBe(false))
    it('returns false for "active"', () => expect(isIREligible('active')).toBe(false))
    it('returns false for empty string', () => expect(isIREligible('')).toBe(false))
    it('returns false for null', () => expect(isIREligible(null)).toBe(false))
})

describe('isDTD', () => {
    it('returns true for "dtd"', () => expect(isDTD('dtd')).toBe(true))
    it('returns true for "DTD"', () => expect(isDTD('DTD')).toBe(true))
    it('returns false for "out"', () => expect(isDTD('out')).toBe(false))
    it('returns false for "IR"', () => expect(isDTD('IR')).toBe(false))
    it('returns false for null', () => expect(isDTD(null)).toBe(false))
    it('returns false for empty string', () => expect(isDTD('')).toBe(false))
})

function mockPlayer(overrides: Partial<RosterPlayer['players']> = {}): RosterPlayer['players'] {
    return {
        id: 'p1',
        display_name: 'Test Player',
        nba_team: 'LAL',
        position: 'PG',
        eligible_positions: ['PG', 'G'],
        injury_status: null,
        nba_id: '123',
        nba_draft_number: null,
        ...overrides,
    }
}

describe('isTaxiEligible', () => {
    it('returns true when nba_draft_number is a positive integer', () => {
        expect(isTaxiEligible(mockPlayer({ nba_draft_number: 1 }))).toBe(true)
    })

    it('returns true when nba_draft_number is 0 (undrafted with known slot)', () => {
        expect(isTaxiEligible(mockPlayer({ nba_draft_number: 0 }))).toBe(true)
    })

    it('returns false when nba_draft_number is null', () => {
        expect(isTaxiEligible(mockPlayer({ nba_draft_number: null }))).toBe(false)
    })

    it('returns false for a veteran with no draft number', () => {
        expect(isTaxiEligible(mockPlayer({ nba_draft_number: null }))).toBe(false)
    })

    it('returns true for a high draft pick', () => {
        expect(isTaxiEligible(mockPlayer({ nba_draft_number: 60 }))).toBe(true)
    })
})
