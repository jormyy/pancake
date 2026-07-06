import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase before importing anything that uses it
vi.mock('@/lib/supabase', () => ({
    supabase: { from: vi.fn(), rpc: vi.fn() },
}))

vi.mock('@/lib/players', () => ({
    getEligiblePositions: vi.fn(() => []),
}))

import { supabase } from '@/lib/supabase'
import { getLeagueTransactions } from '@/lib/transactions'
import { LEAGUE_TABS, parseLeagueTab } from '@/lib/league/tabs'

beforeEach(() => {
    vi.clearAllMocks()
})

describe('parseLeagueTab', () => {
    it('accepts known league tabs and falls back to results', () => {
        for (const { key } of LEAGUE_TABS) {
            expect(parseLeagueTab(key)).toBe(key)
        }
        expect(parseLeagueTab('not-a-tab')).toBe('results')
        expect(parseLeagueTab(undefined)).toBe('results')
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
