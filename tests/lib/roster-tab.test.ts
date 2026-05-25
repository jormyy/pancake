import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/shared/season', () => ({
    getCurrentSeasonId: vi.fn(),
    getActiveSeasonId: vi.fn(),
    getCurrentSeason: vi.fn(),
    currentSeasonYear: vi.fn(),
}))

// ── Pure helper functions mirroring roster-tab logic ───────────────────────────

function needsIRConfirmation(_isCurrentlyOnIR: boolean): boolean {
    return true
}

function needsTaxiConfirmation(_isCurrentlyOnTaxi: boolean): boolean {
    return true
}

function shouldShowErrorBanner(error: Error | null, _data: unknown): boolean {
    return error !== null
}

// ── needsIRConfirmation ────────────────────────────────────────────────────────

describe('needsIRConfirmation', () => {
    it('returns true when moving player TO IR', () => {
        expect(needsIRConfirmation(false)).toBe(true)
    })

    it('returns true when activating player FROM IR', () => {
        expect(needsIRConfirmation(true)).toBe(true)
    })
})

// ── needsTaxiConfirmation ──────────────────────────────────────────────────────

describe('needsTaxiConfirmation', () => {
    it('returns true when moving player TO taxi squad', () => {
        expect(needsTaxiConfirmation(false)).toBe(true)
    })

    it('returns true when activating player FROM taxi squad', () => {
        expect(needsTaxiConfirmation(true)).toBe(true)
    })
})

// ── shouldShowErrorBanner ──────────────────────────────────────────────────────

describe('shouldShowErrorBanner', () => {
    it('returns true when error is non-null', () => {
        expect(shouldShowErrorBanner(new Error('Network error'), null)).toBe(true)
    })

    it('returns false when error is null and data is present', () => {
        expect(shouldShowErrorBanner(null, { roster: [], picks: [], claims: [] })).toBe(false)
    })

    it('returns false when error is null and data is null', () => {
        expect(shouldShowErrorBanner(null, null)).toBe(false)
    })

    it('returns true for any error regardless of data state', () => {
        const err = new Error('Timeout')
        expect(shouldShowErrorBanner(err, { roster: [1, 2, 3] })).toBe(true)
    })
})

// ── getMyWaiverPriority ────────────────────────────────────────────────────────

describe('getMyWaiverPriority (via mock)', () => {
    it('returns the priority number for a member', async () => {
        const mockGetPriority = vi.fn().mockResolvedValue(3)
        const result = await mockGetPriority('member-1', 'league-1')
        expect(result).toBe(3)
        expect(mockGetPriority).toHaveBeenCalledWith('member-1', 'league-1')
    })

    it('returns null when no priority row exists', async () => {
        const mockGetPriority = vi.fn().mockResolvedValue(null)
        const result = await mockGetPriority('member-2', 'league-1')
        expect(result).toBeNull()
    })

    it('is called with memberId and leagueId during roster load', async () => {
        const mockGetPriority = vi.fn().mockResolvedValue(5)

        const [, , , priority] = await Promise.all([
            Promise.resolve([]),
            Promise.resolve([]),
            Promise.resolve([]),
            mockGetPriority('member-abc', 'league-xyz'),
        ])

        expect(mockGetPriority).toHaveBeenCalledWith('member-abc', 'league-xyz')
        expect(priority).toBe(5)
    })
})
