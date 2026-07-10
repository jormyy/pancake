import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    getRosterStatsMaps: vi.fn(),
    maybeSingle: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
    supabase: {
        from: vi.fn(() => ({
            select: vi.fn(() => ({
                eq: vi.fn(() => ({ maybeSingle: mocks.maybeSingle })),
            })),
        })),
    },
}))
vi.mock('@/lib/roster-stats', () => ({ getRosterStatsMaps: mocks.getRosterStatsMaps }))

import { getTradeById } from '@/lib/trades'

beforeEach(() => {
    vi.clearAllMocks()
    mocks.maybeSingle.mockResolvedValue({
        data: {
            id: 'trade-a',
            league_id: 'league-a',
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

describe('trade read enrichment', () => {
    it('returns canonical trade data when optional averages fail', async () => {
        mocks.getRosterStatsMaps.mockRejectedValue(new Error('averages offline'))
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const trade = await getTradeById('trade-a', 'member-a')

        expect(trade?.routedItems).toEqual([expect.objectContaining({ kind: 'player', playerId: 'player-a' })])
        expect(warn).toHaveBeenCalledWith('Could not load optional trade player averages.', expect.any(Error))
    })
})
