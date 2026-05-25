import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: vi.fn(() => 2025) }))

import { supabase } from '@/lib/supabase'
import { getPlayerTransactionHistory } from '@/lib/players'

// ── Pure logic helpers (extracted from component logic) ──────────────────────

function shouldShowIRModal(ineligibleIRPlayers: unknown[], _isWaiverPlayer: boolean): boolean {
    return ineligibleIRPlayers.length > 0
}

function shouldShowInjuryBadge(injuryStatus: string | null, _playedToday: boolean): boolean {
    return injuryStatus != null && injuryStatus !== ''
}

// ── IR check before waiver claim ─────────────────────────────────────────────

describe('shouldShowIRModal', () => {
    it('returns true when ineligible IR players exist and player is on waivers', () => {
        expect(shouldShowIRModal([{ id: 'p1' }], true)).toBe(true)
    })

    it('returns true when ineligible IR players exist and player is a free agent', () => {
        expect(shouldShowIRModal([{ id: 'p1' }], false)).toBe(true)
    })

    it('returns false when no ineligible IR players exist (waiver claim)', () => {
        expect(shouldShowIRModal([], true)).toBe(false)
    })

    it('returns false when no ineligible IR players exist (free agent add)', () => {
        expect(shouldShowIRModal([], false)).toBe(false)
    })

    it('returns true for multiple ineligible IR players', () => {
        expect(shouldShowIRModal([{ id: 'p1' }, { id: 'p2' }], true)).toBe(true)
    })
})

// ── Injury badge visibility ───────────────────────────────────────────────────

describe('shouldShowInjuryBadge', () => {
    it('shows badge when injury status is set and player did not play today', () => {
        expect(shouldShowInjuryBadge('Out', false)).toBe(true)
    })

    it('shows badge when injury status is set even if player played today', () => {
        expect(shouldShowInjuryBadge('DTD', true)).toBe(true)
    })

    it('shows badge for IR status regardless of playedToday', () => {
        expect(shouldShowInjuryBadge('IR', true)).toBe(true)
        expect(shouldShowInjuryBadge('IR-LTI', true)).toBe(true)
    })

    it('does not show badge when injury status is null', () => {
        expect(shouldShowInjuryBadge(null, false)).toBe(false)
        expect(shouldShowInjuryBadge(null, true)).toBe(false)
    })

    it('does not show badge when injury status is empty string', () => {
        expect(shouldShowInjuryBadge('', false)).toBe(false)
    })
})

// ── Transaction pagination ────────────────────────────────────────────────────

describe('getPlayerTransactionHistory', () => {
    const mockRow = (id: string) => ({
        id,
        transaction_type: 'add',
        occurred_at: '2025-01-01T00:00:00Z',
        league_members: { team_name: 'Team A' },
    })

    function setupMock(rows: ReturnType<typeof mockRow>[]) {
        const rangeStub = vi.fn().mockResolvedValue({ data: rows, error: null })
        const orderStub = vi.fn().mockReturnValue({ range: rangeStub })
        const eqLeagueStub = vi.fn().mockReturnValue({ order: orderStub })
        const eqPlayerStub = vi.fn().mockReturnValue({ eq: eqLeagueStub })
        const selectStub = vi.fn().mockReturnValue({ eq: eqPlayerStub })
        ;(supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ select: selectStub })
        return { rangeStub }
    }

    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('fetches first page with default limit and offset', async () => {
        const rows = [mockRow('tx1'), mockRow('tx2')]
        const { rangeStub } = setupMock(rows)

        const result = await getPlayerTransactionHistory('player-1', 'league-1')

        expect(rangeStub).toHaveBeenCalledWith(0, 19)
        expect(result).toHaveLength(2)
        expect(result[0].id).toBe('tx1')
    })

    it('fetches second page with correct offset', async () => {
        const rows = [mockRow('tx21')]
        const { rangeStub } = setupMock(rows)

        const result = await getPlayerTransactionHistory('player-1', 'league-1', 20, 20)

        expect(rangeStub).toHaveBeenCalledWith(20, 39)
        expect(result[0].id).toBe('tx21')
    })

    it('respects custom limit', async () => {
        const rows = [mockRow('tx1')]
        const { rangeStub } = setupMock(rows)

        await getPlayerTransactionHistory('player-1', 'league-1', 10, 0)

        expect(rangeStub).toHaveBeenCalledWith(0, 9)
    })

    it('maps rows to TransactionHistoryEntry shape', async () => {
        setupMock([mockRow('tx-abc')])

        const result = await getPlayerTransactionHistory('player-1', 'league-1')

        expect(result[0]).toMatchObject({
            id: 'tx-abc',
            transactionType: 'add',
            teamName: 'Team A',
            occurredAt: '2025-01-01T00:00:00Z',
        })
    })

    it('returns empty array when no transactions exist', async () => {
        setupMock([])

        const result = await getPlayerTransactionHistory('player-1', 'league-1')

        expect(result).toHaveLength(0)
    })
})
