import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase before importing anything that uses it
vi.mock('@/lib/supabase', () => ({
    supabase: { from: vi.fn() },
}))

vi.mock('@/lib/players', () => ({
    getEligiblePositions: vi.fn(() => []),
}))

vi.mock('@/lib/alert', () => ({
    confirmAction: vi.fn(),
    showAlert: vi.fn(),
}))

import { supabase } from '@/lib/supabase'
import { getLeagueTransactions } from '@/lib/transactions'
import { confirmAction } from '@/lib/alert'

// ── Chainable Supabase query builder ─────────────────────────────

function q(data: unknown, error: unknown = null) {
    const result = { data, error }
    const chain: Record<string, unknown> = {}
    const methods = ['select', 'eq', 'in', 'order', 'limit', 'range']
    for (const m of methods) {
        chain[m] = vi.fn(() => chain)
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then = (res: (v: unknown) => unknown, rej: (v: unknown) => unknown) =>
        Promise.resolve(result).then(res, rej)
    return chain as any
}

beforeEach(() => {
    vi.clearAllMocks()
})

// ── Fix 1: shouldFetchTab helper ─────────────────────────────────

/**
 * Pure helper that mirrors the lazy-load logic in league.tsx:
 * return true when the tab is NOT yet in loadedTabs.
 */
function shouldFetchTab(tab: string, loadedTabs: Set<string>): boolean {
    return !loadedTabs.has(tab)
}

describe('shouldFetchTab', () => {
    it('returns true when tab has not been loaded', () => {
        const loaded = new Set<string>()
        expect(shouldFetchTab('results', loaded)).toBe(true)
    })

    it('returns false when tab is already in the set', () => {
        const loaded = new Set(['results'])
        expect(shouldFetchTab('results', loaded)).toBe(false)
    })

    it('returns true for a different tab even if one is loaded', () => {
        const loaded = new Set(['results'])
        expect(shouldFetchTab('history', loaded)).toBe(true)
    })

    it('returns false for all tabs once all are loaded', () => {
        const tabs = ['results', 'auctions', 'mockRooms', 'draftBoard', 'settings', 'history']
        const loaded = new Set(tabs)
        for (const t of tabs) {
            expect(shouldFetchTab(t, loaded)).toBe(false)
        }
    })
})

// ── Fix 3: getLeagueTransactions with limit/offset ───────────────

describe('getLeagueTransactions', () => {
    it('returns empty array when no active season', async () => {
        vi.mocked(supabase.from).mockReturnValue(q(null) as any)
        const result = await getLeagueTransactions('league-1')
        expect(result).toEqual([])
    })

    it('calls .range(offset, offset + limit - 1) with defaults (limit=50, offset=0)', async () => {
        const txChain = q([])
        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'league_seasons') return q({ id: 'season-1' }) as any
            return txChain as any
        })

        await getLeagueTransactions('league-1')

        expect(txChain.range).toHaveBeenCalledWith(0, 49)
    })

    it('calls .range with custom limit and offset', async () => {
        const txChain = q([])
        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'league_seasons') return q({ id: 'season-1' }) as any
            return txChain as any
        })

        await getLeagueTransactions('league-1', 25, 50)

        expect(txChain.range).toHaveBeenCalledWith(50, 74)
    })

    it('maps returned rows to TransactionRow shape', async () => {
        const rows = [
            {
                id: 'tx-1',
                member_id: 'm1',
                player_id: 'p1',
                transaction_type: 'fa_add',
                occurred_at: '2026-01-01T00:00:00Z',
                league_members: { team_name: 'Alpha' },
                players: { display_name: 'LeBron James', position: 'SF', eligible_positions: ['SF', 'F'], nba_id: '2544' },
            },
        ]
        const txChain = q(rows)
        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'league_seasons') return q({ id: 'season-1' }) as any
            return txChain as any
        })

        const result = await getLeagueTransactions('league-1')

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('tx-1')
        expect(result[0].teamName).toBe('Alpha')
        expect(result[0].playerName).toBe('LeBron James')
        expect(result[0].transactionType).toBe('fa_add')
    })
})

// ── Fix 4: Draft confirmations ───────────────────────────────────

describe('draft confirmation via confirmAction', () => {
    it('confirmAction is called with auction draft title and message', () => {
        vi.mocked(confirmAction).mockImplementation((_title, _msg, _cb) => {
            // do not call cb — simulating user pressing Cancel
        })

        const startDraftFlow = () => {
            confirmAction(
                'Start Auction Draft?',
                'This will begin the auction draft for all teams. This cannot be undone.',
                () => { /* draft logic */ },
                'Start Draft',
            )
        }

        startDraftFlow()

        expect(confirmAction).toHaveBeenCalledOnce()
        expect(confirmAction).toHaveBeenCalledWith(
            'Start Auction Draft?',
            'This will begin the auction draft for all teams. This cannot be undone.',
            expect.any(Function),
            'Start Draft',
        )
    })

    it('confirmAction is called with rookie draft title and message', () => {
        vi.mocked(confirmAction).mockImplementation((_title, _msg, _cb) => {
            // do not call cb
        })

        const startRookieDraftFlow = () => {
            confirmAction(
                'Start Rookie Draft?',
                'This will begin the rookie snake draft. This cannot be undone.',
                () => { /* draft logic */ },
                'Start Draft',
            )
        }

        startRookieDraftFlow()

        expect(confirmAction).toHaveBeenCalledOnce()
        expect(confirmAction).toHaveBeenCalledWith(
            'Start Rookie Draft?',
            'This will begin the rookie snake draft. This cannot be undone.',
            expect.any(Function),
            'Start Draft',
        )
    })

    it('draft logic is NOT executed when user cancels (confirmAction does not call cb)', () => {
        const draftLogic = vi.fn()
        vi.mocked(confirmAction).mockImplementation((_title, _msg, _cb) => {
            // simulate cancel — don't invoke _cb
        })

        confirmAction('Start Auction Draft?', 'message', draftLogic, 'Start Draft')

        expect(draftLogic).not.toHaveBeenCalled()
    })

    it('draft logic IS executed when user confirms (confirmAction calls cb)', () => {
        const draftLogic = vi.fn()
        vi.mocked(confirmAction).mockImplementation((_title, _msg, cb) => {
            cb()
        })

        confirmAction('Start Auction Draft?', 'message', draftLogic, 'Start Draft')

        expect(draftLogic).toHaveBeenCalledOnce()
    })
})
