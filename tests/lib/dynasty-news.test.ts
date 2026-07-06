import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/shared/season', () => ({ getActiveSeasonId: vi.fn() }))

import { supabase } from '@/lib/supabase'
import { getActiveSeasonId } from '@/lib/shared/season'
import { getMyDynastyNews } from '@/lib/dynasty'

const mockFrom = vi.mocked(supabase.from)
const mockGetActiveSeasonId = vi.mocked(getActiveSeasonId)

function queryResult(data: unknown, error: unknown = null) {
    const chain: any = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        in: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve({ data, error }).then(resolve, reject),
    }
    return chain
}

describe('getMyDynastyNews', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns no news without an active season', async () => {
        mockGetActiveSeasonId.mockResolvedValue(null)

        await expect(getMyDynastyNews('member-1', 'league-1')).resolves.toEqual([])

        expect(mockFrom).not.toHaveBeenCalled()
    })

    it('filters dynasty news to current roster player ids', async () => {
        mockGetActiveSeasonId.mockResolvedValue('season-1')
        const rosterQuery = queryResult([
            { player_id: 'player-1' },
            { player_id: 'player-2' },
            { player_id: 'player-1' },
            { player_id: null },
        ])
        const newsQuery = queryResult([
            {
                id: 'news-1',
                title: 'Player update',
                summary: 'Rotation changed',
                source: 'Beat',
                url: 'https://example.test/news',
                published_at: '2026-06-30T00:00:00Z',
                players: { display_name: 'Roster Player', nba_team: 'OKC', nba_id: '203999' },
            },
        ])
        mockFrom.mockImplementation((table: string) => {
            if (table === 'roster_players') return rosterQuery
            if (table === 'dynasty_news') return newsQuery
            throw new Error(`Unexpected table ${table}`)
        })

        const result = await getMyDynastyNews('member-1', 'league-1', 12)

        expect(rosterQuery.eq).toHaveBeenCalledWith('member_id', 'member-1')
        expect(rosterQuery.eq).toHaveBeenCalledWith('league_id', 'league-1')
        expect(rosterQuery.eq).toHaveBeenCalledWith('league_season_id', 'season-1')
        expect(newsQuery.in).toHaveBeenCalledWith('player_id', ['player-1', 'player-2'])
        expect(newsQuery.limit).toHaveBeenCalledWith(12)
        expect(result).toEqual([
            {
                id: 'news-1',
                title: 'Player update',
                summary: 'Rotation changed',
                source: 'Beat',
                url: 'https://example.test/news',
                publishedAt: '2026-06-30T00:00:00Z',
                playerName: 'Roster Player',
                playerTeam: 'OKC',
                playerNbaId: '203999',
            },
        ])
    })
})
