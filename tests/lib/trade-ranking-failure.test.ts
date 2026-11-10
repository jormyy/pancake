import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    getRosterStatsMaps: vi.fn(),
    maybeSingle: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
    supabase: { from: vi.fn((table: string) => {
        if (table === 'trades') return { select: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }) }
        const rankingQuery = {
            select: () => rankingQuery,
            eq: () => rankingQuery,
            in: () => rankingQuery,
            order: () => rankingQuery,
            then: (resolve: (result: unknown) => unknown) => Promise.resolve(resolve({ data: null, error: new Error('rankings read timed out') })),
        }
        return rankingQuery
    }) },
}))
vi.mock('@/lib/roster-stats', () => ({ getRosterStatsMaps: mocks.getRosterStatsMaps }))

import { getTradeById } from '@/lib/trades'

beforeEach(() => {
    vi.clearAllMocks()
    mocks.maybeSingle.mockResolvedValue({
        data: {
            id: 'trade-a',
            league_id: 'league-a',
            league_season_id: 'season-a',
            status: 'pending',
            proposed_at: '2026-07-10T00:00:00Z',
            proposer_member_id: 'member-a',
            recipient_member_id: 'member-b',
            proposer: { team_name: 'A' },
            recipient: { team_name: 'B' },
            trade_items: [{
                side: 'proposer',
                player_id: 'player-a',
                pick_id: null,
                from_member_id: 'member-a',
                to_member_id: 'member-b',
                faab_amount: 0,
                players: {
                    display_name: 'Player A',
                    position: 'PG',
                    eligible_positions: ['PG'],
                    nba_team: 'LAL',
                    nba_id: '1',
                    injury_status: null,
                    years_exp: 2,
                },
                draft_picks: null,
            }],
        },
        error: null,
    })
})

it('preserves canonical trade when ranking enrichment fails', async () => {
    mocks.getRosterStatsMaps.mockResolvedValue({ avgMap: new Map(), avgStatsMap: new Map() })
    const result = await getTradeById('trade-a', 'member-a')
    expect(result).toMatchObject({ id: 'trade-a', routedItems: [{ kind: 'player', playerId: 'player-a' }] })
})
