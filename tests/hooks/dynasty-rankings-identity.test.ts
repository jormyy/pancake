import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDynastyRankings } from '@/hooks/use-dynasty-rankings'

const mocks = vi.hoisted(() => ({
    getCurrentSeason: vi.fn(),
    getDynastyDecisionInputs: vi.fn(),
    getUnmatchedRookieRankings: vi.fn(),
    readPersistentCache: vi.fn(),
    writePersistentCache: vi.fn(),
}))

vi.mock('@react-navigation/native', () => ({ useFocusEffect: vi.fn() }))
vi.mock('@/hooks/use-debounced-value', () => ({ useDebouncedValue: (value: string) => value }))
vi.mock('@/lib/shared/season', () => ({
    getCurrentSeason: mocks.getCurrentSeason,
    currentSeasonYear: () => 2026,
}))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: mocks.readPersistentCache,
    writePersistentCache: mocks.writePersistentCache,
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

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    let reject!: (cause: unknown) => void
    const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

const scoringSettings = { points: 1 }
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const decisionRow = (leagueId: string, overrides: Record<string, unknown> = {}) => ({
    player_id: `player-${leagueId}`, display_name: `Player ${leagueId}`, age: 24,
    dynasty_rank: 8, rank_change: 1, injury_status: null, avg_fantasy_points: 42,
    projection_fantasy_points: 44, years_exp: 3, ranking_source: 'rankings',
    ranking_fetched_at: null, projection_source: 'projections', projection_fetched_at: null,
    nba_team: 'LAL', position: 'G', eligible_positions: ['G'], games_played: 50,
    avg_three_pointers_made: 2, avg_points: 20, avg_rebounds: 5, avg_assists: 5,
    avg_steals: 1, avg_blocks: 1, avg_turnovers: 2, headshot_url: null, nba_id: null,
    contend_rank: null, rebuild_rank: null, rookie_rank: null,
    ...overrides,
})

beforeEach(() => {
    vi.clearAllMocks()
    mocks.readPersistentCache.mockReturnValue(null)
    mocks.getUnmatchedRookieRankings.mockResolvedValue([])
})

describe('dynasty rankings identity', () => {
    it('sorts strategy views by league value when published order disagrees', async () => {
        mocks.getCurrentSeason.mockResolvedValue({ seasonYear: 2026 })
        mocks.getDynastyDecisionInputs.mockResolvedValue([
            decisionRow('source-first', {
                display_name: 'Source First', dynasty_rank: 1, contend_rank: 1, rebuild_rank: 1,
                age: 25, avg_fantasy_points: 5, projection_fantasy_points: 5,
            }),
            decisionRow('league-first', {
                display_name: 'League First', dynasty_rank: 400, contend_rank: 400, rebuild_rank: 400,
                age: 25, avg_fantasy_points: 65, projection_fantasy_points: 65,
            }),
        ])
        let latest!: ReturnType<typeof useDynastyRankings>
        const Probe = () => {
            latest = useDynastyRankings({
                userId: 'user', memberId: 'member', leagueId: 'league',
                scoringSettings, teamCount: 12,
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await flush() })

        expect(latest.players.slice(0, 2).map((player) => player.displayName)).toEqual(['League First', 'Source First'])
        await act(async () => { latest.setView('contend'); await flush() })
        expect(latest.players.slice(0, 2).map((player) => player.displayName)).toEqual(['League First', 'Source First'])
        await act(async () => { latest.setView('rebuild'); await flush() })
        expect(latest.players.slice(0, 2).map((player) => player.displayName)).toEqual(['League First', 'Source First'])
        await act(async () => { renderer.unmount() })
    })

    it('keeps unmatched published rookies in the rookie view', async () => {
        mocks.getCurrentSeason.mockResolvedValue({ seasonYear: 2026 })
        mocks.getDynastyDecisionInputs.mockResolvedValue([])
        mocks.getUnmatchedRookieRankings.mockResolvedValue([
            {
                id: 'rookie-46', source_rank: 46, source_player_name: 'Michael Ajayi', source_team: null,
                source_positions: [], age: 22, fetched_at: '2026-08-17T00:00:00Z',
            },
            {
                id: 'rookie-49', source_rank: 49, source_player_name: 'Nick Boyd', source_team: null,
                source_positions: [], age: 23, fetched_at: '2026-08-17T00:00:00Z',
            },
            {
                id: 'rookie-52', source_rank: 52, source_player_name: 'Aaron Nkrumah', source_team: null,
                source_positions: [], age: 20, fetched_at: '2026-08-17T00:00:00Z',
            },
        ])
        let latest!: ReturnType<typeof useDynastyRankings>
        const Probe = () => {
            latest = useDynastyRankings({
                userId: 'user', memberId: 'member', leagueId: 'league', scoringSettings, teamCount: 12,
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await flush() })
        await act(async () => { latest.setView('rookies-picks'); await flush() })

        expect(latest.players.filter((player) => !player.isDraftPick).map((player) => player.displayName)).toEqual([
            'Michael Ajayi', 'Nick Boyd', 'Aaron Nkrumah',
        ])
        await act(async () => { renderer.unmount() })
    })

    it('hides prior-league rows before the next season lookup settles', async () => {
        const secondSeason = deferred<{ seasonYear: number }>()
        mocks.getCurrentSeason.mockImplementation((leagueId: string) => leagueId === 'league-a'
            ? Promise.resolve({ seasonYear: 2042 })
            : secondSeason.promise)
        mocks.getDynastyDecisionInputs.mockImplementation(({ leagueId }: { leagueId: string }) =>
            Promise.resolve([decisionRow(leagueId)]))
        let latest!: ReturnType<typeof useDynastyRankings>
        const Probe = ({ leagueId }: { leagueId: string }) => {
            latest = useDynastyRankings({
                userId: 'user', memberId: `member-${leagueId}`, leagueId,
                scoringSettings, teamCount: 12,
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { leagueId: 'league-a' })); await flush() })
        expect(latest.players.map((player) => player.displayName)).toEqual(['Player league-a'])

        await act(async () => { renderer.update(React.createElement(Probe, { leagueId: 'league-b' })) })
        expect(latest.players).toEqual([])
        await act(async () => { secondSeason.resolve({ seasonYear: 2050 }); await secondSeason.promise; await flush() })
        expect(latest.players.map((player) => player.displayName)).toEqual(['Player league-b'])
        await act(async () => { renderer.unmount() })
    })

    it('keeps prior-league rows hidden when the next season lookup fails', async () => {
        const secondSeason = deferred<{ seasonYear: number }>()
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        mocks.getCurrentSeason.mockImplementation((leagueId: string) => leagueId === 'league-a'
            ? Promise.resolve({ seasonYear: 2042 })
            : secondSeason.promise)
        mocks.getDynastyDecisionInputs.mockResolvedValue([decisionRow('league-a')])
        let latest!: ReturnType<typeof useDynastyRankings>
        const Probe = ({ leagueId }: { leagueId: string }) => {
            latest = useDynastyRankings({
                userId: 'user', memberId: `member-${leagueId}`, leagueId,
                scoringSettings, teamCount: 12,
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { leagueId: 'league-a' })); await flush() })
        await act(async () => { renderer.update(React.createElement(Probe, { leagueId: 'league-b' })) })
        await act(async () => { secondSeason.reject(new Error('season failed')); try { await secondSeason.promise } catch {} })

        expect(latest.players).toEqual([])
        expect(latest.error?.message).toBe('season failed')
        await act(async () => { renderer.unmount() })
        consoleError.mockRestore()
    })
})
