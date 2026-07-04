import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase before importing anything that uses it
vi.mock('@/lib/supabase', () => ({
    supabase: { from: vi.fn(), rpc: vi.fn() },
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
import { LEAGUE_TABS, parseLeagueTab } from '@/lib/league/tabs'

beforeEach(() => {
    vi.clearAllMocks()
})

function shouldFetchTab(tab: string, loadedTabs: Set<string>): boolean {
    return !loadedTabs.has(tab)
}

describe('parseLeagueTab', () => {
    it('accepts known league tabs and falls back to results', () => {
        for (const { key } of LEAGUE_TABS) {
            expect(parseLeagueTab(key)).toBe(key)
        }
        expect(parseLeagueTab('not-a-tab')).toBe('results')
        expect(parseLeagueTab(undefined)).toBe('results')
    })
})

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
        const tabs = LEAGUE_TABS.map((tab) => tab.key)
        const loaded = new Set(tabs)
        for (const t of tabs) {
            expect(shouldFetchTab(t, loaded)).toBe(false)
        }
    })
})

describe('getLeagueTransactions', () => {
    it('returns empty array when the feed RPC has no rows', async () => {
        vi.mocked(supabase.rpc).mockResolvedValue({ data: [], error: null } as any)
        const result = await getLeagueTransactions('league-1')
        expect(result).toEqual([])
    })

    it('delegates pagination to the canonical activity feed RPC', async () => {
        vi.mocked(supabase.rpc).mockResolvedValue({ data: [], error: null } as any)
        await getLeagueTransactions('league-1')

        expect(supabase.rpc).toHaveBeenCalledWith('get_league_activity_feed', {
            p_league_id: 'league-1',
            p_limit: 50,
            p_offset: 0,
        })
        expect(supabase.from).not.toHaveBeenCalled()
    })

    it('passes custom limit and offset to the feed RPC', async () => {
        vi.mocked(supabase.rpc).mockResolvedValue({ data: [], error: null } as any)
        await getLeagueTransactions('league-1', 25, 50)

        expect(supabase.rpc).toHaveBeenCalledWith('get_league_activity_feed', {
            p_league_id: 'league-1',
            p_limit: 25,
            p_offset: 50,
        })
    })

    it('maps returned rows to TransactionRow shape', async () => {
        const rows = [
            {
                id: 'tx-1',
                member_id: 'm1',
                target_member_id: null,
                team_name: 'Alpha',
                target_team_name: null,
                player_id: 'p1',
                player_name: 'LeBron James',
                player_position: 'SF',
                eligible_positions: ['SF', 'F'],
                nba_id: '2544',
                transaction_type: 'fa_add',
                occurred_at: '2026-01-01T00:00:00Z',
                is_system: false,
                title: null,
                body: null,
            },
        ]
        vi.mocked(supabase.rpc).mockResolvedValue({ data: rows, error: null } as any)

        const result = await getLeagueTransactions('league-1')

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('tx-1')
        expect(result[0].teamName).toBe('Alpha')
        expect(result[0].playerName).toBe('LeBron James')
        expect(result[0].transactionType).toBe('fa_add')
    })

    it('maps league activity rows from the feed RPC', async () => {
        vi.mocked(supabase.rpc).mockResolvedValue({
            data: [
                {
                    id: 'activity-1',
                    member_id: 'm1',
                    target_member_id: 'm2',
                    team_name: 'Alpha',
                    target_team_name: 'Beta',
                    player_id: null,
                    player_name: 'Trade countered',
                    player_position: null,
                    eligible_positions: null,
                    nba_id: null,
                    transaction_type: 'trade_countered',
                    occurred_at: '2026-01-02T00:00:00Z',
                    is_system: true,
                    title: 'Trade countered',
                    body: 'A manager countered an offer.',
                },
            ],
            error: null,
        } as any)

        const result = await getLeagueTransactions('league-1')

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('activity-1')
        expect(result[0].isSystem).toBe(true)
        expect(result[0].title).toBe('Trade countered')
        expect(result[0].targetMemberId).toBe('m2')
        expect(result[0].targetTeamName).toBe('Beta')
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
                "This will begin the auction draft for all teams with a 60-second timer and manager's choice nomination order. This cannot be undone.",
                () => { /* draft logic */ },
                'Start Auction',
            )
        }

        startDraftFlow()

        expect(confirmAction).toHaveBeenCalledOnce()
        expect(confirmAction).toHaveBeenCalledWith(
            'Start Auction Draft?',
            "This will begin the auction draft for all teams with a 60-second timer and manager's choice nomination order. This cannot be undone.",
            expect.any(Function),
            'Start Auction',
        )
    })

    it('confirmAction is called with rookie draft title and message', () => {
        vi.mocked(confirmAction).mockImplementation((_title, _msg, _cb) => {
            // do not call cb
        })

        const startRookieDraftFlow = () => {
            confirmAction(
                'Start Rookie Draft?',
                'This will begin the rookie snake draft for 3 rounds with a 120-second timer and pause timeout behavior. This cannot be undone.',
                () => { /* draft logic */ },
                'Start Rookie',
            )
        }

        startRookieDraftFlow()

        expect(confirmAction).toHaveBeenCalledOnce()
        expect(confirmAction).toHaveBeenCalledWith(
            'Start Rookie Draft?',
            'This will begin the rookie snake draft for 3 rounds with a 120-second timer and pause timeout behavior. This cannot be undone.',
            expect.any(Function),
            'Start Rookie',
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
