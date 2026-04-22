import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase before importing anything that uses it
vi.mock('@/lib/supabase', () => ({
    supabase: { from: vi.fn() },
}))
vi.mock('@/lib/shared/season', () => ({
    getCurrentSeason: vi.fn(),
    getCurrentSeasonId: vi.fn(),
    getActiveSeasonId: vi.fn(),
    currentSeasonYear: vi.fn(),
}))

import { supabase } from '@/lib/supabase'
import { getCurrentSeason } from '@/lib/shared/season'
import { getLeagueStandings } from '@/lib/scoring'

function q(data: any, error: any = null) {
    const result = { data, error }
    const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        single: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve(result),
        insert: () => q(data, error),
        update: () => q(data, error),
        then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
    }
    return chain
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCurrentSeason).mockResolvedValue({ id: 'season-1', seasonYear: 2026 })
})

describe('getLeagueStandings', () => {
    it('returns empty array when no active season', async () => {
        vi.mocked(getCurrentSeason).mockResolvedValue(null)
        const result = await getLeagueStandings('league-1')
        expect(result).toEqual([])
    })

    it('calculates wins and losses from finalized matchups', async () => {
        const members = [
            { id: 'm1', team_name: 'Alpha' },
            { id: 'm2', team_name: 'Beta' },
        ]
        const matchups = [
            {
                home_member_id: 'm1',
                away_member_id: 'm2',
                home_points: 120,
                away_points: 100,
                winner_member_id: 'm1',
                is_finalized: true,
            },
        ]

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'league_members') return q(members) as any
            if (table === 'matchups') return q(matchups) as any
            return q(null) as any
        })

        const standings = await getLeagueStandings('league-1')

        const alpha = standings.find((s) => s.memberId === 'm1')!
        const beta = standings.find((s) => s.memberId === 'm2')!

        expect(alpha.wins).toBe(1)
        expect(alpha.losses).toBe(0)
        expect(beta.wins).toBe(0)
        expect(beta.losses).toBe(1)
    })

    it('accumulates points for and against', async () => {
        const members = [
            { id: 'm1', team_name: 'Alpha' },
            { id: 'm2', team_name: 'Beta' },
        ]
        const matchups = [
            {
                home_member_id: 'm1',
                away_member_id: 'm2',
                home_points: 130,
                away_points: 110,
                winner_member_id: 'm1',
                is_finalized: true,
            },
            {
                home_member_id: 'm2',
                away_member_id: 'm1',
                home_points: 120,
                away_points: 115,
                winner_member_id: 'm2',
                is_finalized: true,
            },
        ]

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'league_members') return q(members) as any
            if (table === 'matchups') return q(matchups) as any
            return q(null) as any
        })

        const standings = await getLeagueStandings('league-1')
        const alpha = standings.find((s) => s.memberId === 'm1')!

        expect(alpha.pointsFor).toBe(130 + 115)
        expect(alpha.pointsAgainst).toBe(110 + 120)
    })

    it('sorts by wins descending, then pointsFor as tiebreaker', async () => {
        const members = [
            { id: 'm1', team_name: 'Alpha' },
            { id: 'm2', team_name: 'Beta' },
            { id: 'm3', team_name: 'Gamma' },
        ]
        // m1 and m2 both have 1 win — m2 has more points
        const matchups = [
            {
                home_member_id: 'm1', away_member_id: 'm3',
                home_points: 100, away_points: 90, winner_member_id: 'm1', is_finalized: true,
            },
            {
                home_member_id: 'm2', away_member_id: 'm3',
                home_points: 120, away_points: 80, winner_member_id: 'm2', is_finalized: true,
            },
        ]

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'league_members') return q(members) as any
            if (table === 'matchups') return q(matchups) as any
            return q(null) as any
        })

        const standings = await getLeagueStandings('league-1')
        expect(standings[0].memberId).toBe('m2') // more points
        expect(standings[1].memberId).toBe('m1')
        expect(standings[2].memberId).toBe('m3')
    })

    it('ignores non-finalized matchups for win/loss calculation', async () => {
        const members = [{ id: 'm1', team_name: 'Alpha' }, { id: 'm2', team_name: 'Beta' }]
        const matchups = [
            {
                home_member_id: 'm1', away_member_id: 'm2',
                home_points: 110, away_points: 90, winner_member_id: null, is_finalized: false,
            },
        ]

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'league_members') return q(members) as any
            if (table === 'matchups') return q(matchups) as any
            return q(null) as any
        })

        const standings = await getLeagueStandings('league-1')
        expect(standings.every((s) => s.wins === 0 && s.losses === 0)).toBe(true)
    })

    it('tracks max single-week score per team', async () => {
        const members = [{ id: 'm1', team_name: 'Alpha' }, { id: 'm2', team_name: 'Beta' }]
        const matchups = [
            {
                home_member_id: 'm1', away_member_id: 'm2',
                home_points: 150, away_points: 120, winner_member_id: 'm1', is_finalized: true,
            },
            {
                home_member_id: 'm1', away_member_id: 'm2',
                home_points: 110, away_points: 140, winner_member_id: 'm2', is_finalized: true,
            },
        ]

        vi.mocked(supabase.from).mockImplementation((table: string) => {
            if (table === 'league_members') return q(members) as any
            if (table === 'matchups') return q(matchups) as any
            return q(null) as any
        })

        const standings = await getLeagueStandings('league-1')
        const alpha = standings.find((s) => s.memberId === 'm1')!
        expect(alpha.maxPointsFor).toBe(150)
    })
})
