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

describe('trade read enrichment', () => {
    it('preserves saved taxi moves when reading a trade', async () => {
        const row = (await mocks.maybeSingle()).data
        row.trade_participants = [{
            member_id: 'member-a', accepted_at: null, is_initiator: true, sort_order: 0,
            league_members: { team_name: 'A' }, drop_player_ids: [],
            roster_moves: [{ playerId: 'rookie', destination: 'taxi' }],
        }]
        mocks.maybeSingle.mockResolvedValue({ data: row, error: null })
        mocks.getRosterStatsMaps.mockResolvedValue({ avgMap: new Map(), avgStatsMap: new Map() })
        expect((await getTradeById('trade-a', 'member-a'))?.participants[0].rosterMoves)
            .toEqual([{ playerId: 'rookie', destination: 'taxi' }])
    })

    it('returns canonical trade data when optional averages fail', async () => {
        mocks.getRosterStatsMaps.mockRejectedValue(new Error('averages offline'))
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const trade = await getTradeById('trade-a', 'member-a')

        expect(trade?.routedItems).toEqual([expect.objectContaining({ kind: 'player', playerId: 'player-a' })])
        expect(warn).toHaveBeenCalledWith('Could not load optional trade player averages.', expect.any(Error))
    })

    it('uses the sending roster in this season to identify inherited taxi tenure', async () => {
        const row = (await mocks.maybeSingle()).data
        row.trade_items[0].players.roster_players = [
            { league_season_id: 'season-old', member_id: 'member-a', is_on_taxi: true },
            { league_season_id: 'season-a', member_id: 'member-other', is_on_taxi: true },
            { league_season_id: 'season-a', member_id: 'member-a', is_on_taxi: false },
        ]
        mocks.maybeSingle.mockResolvedValue({ data: row, error: null })
        mocks.getRosterStatsMaps.mockResolvedValue({ avgMap: new Map(), avgStatsMap: new Map() })
        expect((await getTradeById('trade-a', 'member-a'))?.routedItems[0]).toMatchObject({ fromTaxi: false })
        row.trade_items[0].players.roster_players[2].is_on_taxi = true
        expect((await getTradeById('trade-a', 'member-a'))?.routedItems[0]).toMatchObject({ fromTaxi: true })
    })

})
