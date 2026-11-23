import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDynastyRankings, type DynastyRankingView } from '@/hooks/use-dynasty-rankings'

const mocks = vi.hoisted(() => ({
    getCurrentSeason: vi.fn(),
    getDynastyDecisionInputs: vi.fn(),
    getUnmatchedRookieRankings: vi.fn(),
}))

vi.mock('@react-navigation/native', () => ({ useFocusEffect: vi.fn() }))
vi.mock('@/lib/shared/season', () => ({
    getCurrentSeason: mocks.getCurrentSeason,
    currentSeasonYear: () => 2026,
}))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: () => null,
    writePersistentCache: vi.fn(),
}))
vi.mock('@/lib/dynasty-decisions', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/dynasty-decisions')>()
    return {
        ...actual,
        getDynastyDecisionInputs: mocks.getDynastyDecisionInputs,
        getUnmatchedRookieRankings: mocks.getUnmatchedRookieRankings,
    }
})
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const scoringSettings = { points: 1 }
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const publishedViews: { view: DynastyRankingView; rankField: string }[] = [
    { view: 'five-year', rankField: 'five_year_rank' },
    { view: 'three-year', rankField: 'three_year_rank' },
    { view: 'rookies-picks', rankField: 'rookie_rank' },
]

const leagueValueOrder = [
    { name: 'Best League Value', points: 70, ranks: [3, 2, 3] },
    { name: 'Middle League Value', points: 40, ranks: [1, 3, 2] },
    { name: 'Worst League Value', points: 5, ranks: [2, 1, 1] },
]

const decisionRow = ({ name, points, ranks }: typeof leagueValueOrder[number]) => ({
    player_id: `player-${name}`, display_name: name, age: 21, rank_change: 0, injury_status: null,
    avg_fantasy_points: points, projection_fantasy_points: points, years_exp: 0, ranking_source: 'hashtagbasketball.com',
    ranking_fetched_at: null, projection_source: 'projections', projection_fetched_at: null,
    nba_team: 'LAL', position: 'G', eligible_positions: ['G'], games_played: 50,
    avg_three_pointers_made: 2, avg_points: points / 2, avg_rebounds: 5, avg_assists: 5,
    avg_steals: 1, avg_blocks: 1, avg_turnovers: 2, headshot_url: null, nba_id: null,
    ...Object.fromEntries(publishedViews.map(({ rankField }, index) => [rankField, ranks[index]])),
})

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCurrentSeason.mockResolvedValue({ seasonYear: 2026 })
    mocks.getUnmatchedRookieRankings.mockResolvedValue([])
    mocks.getDynastyDecisionInputs.mockResolvedValue(leagueValueOrder.map(decisionRow))
})

describe('Dynasty Hub order', () => {
    it('lists every published view in its source rank order, not by league value', async () => {
        let latest!: ReturnType<typeof useDynastyRankings>
        const Probe = () => {
            latest = useDynastyRankings({
                userId: 'user', memberId: 'member', leagueId: 'league', scoringSettings, teamCount: 12,
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await flush() })

        for (const [index, { view }] of publishedViews.entries()) {
            await act(async () => { latest.setView(view); await flush() })
            const published = [...leagueValueOrder]
                .sort((left, right) => left.ranks[index] - right.ranks[index])
                .map(({ name }) => name)
            const shown = latest.players.filter((player) => !player.isDraftPick)
            expect({ view, order: shown.map((player) => player.displayName) }).toEqual({ view, order: published })
            expect(shown.map((player) => player.dynastyRank)).toEqual([1, 2, 3])
        }
        await act(async () => { renderer.unmount() })
    })
})
