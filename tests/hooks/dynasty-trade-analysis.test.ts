import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDynastyTradeAnalysis } from '@/hooks/use-dynasty-trade-analysis'

const mocks = vi.hoisted(() => ({
    getCurrentSeason: vi.fn(),
    getDynastyDecisionInputs: vi.fn(),
}))

vi.mock('@/lib/shared/season', () => ({ getCurrentSeason: mocks.getCurrentSeason }))
vi.mock('@/lib/dynasty-decisions', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/dynasty-decisions')>()
    return { ...actual, getDynastyDecisionInputs: mocks.getDynastyDecisionInputs }
})
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const row = {
    player_id: 'player-1', display_name: 'Player One', age: 24, dynasty_rank: 8,
    rank_change: 1, injury_status: null, avg_fantasy_points: 42,
    projection_fantasy_points: 44, years_exp: 3, ranking_source: 'rankings',
    ranking_fetched_at: null, projection_source: 'projections', projection_fetched_at: null,
}

const baseInput = {
    enabled: true,
    leagueId: 'league-a',
    memberId: 'member-a',
    scoringSettings: { points: 1 },
    teams: 12,
    faabBudget: 100,
    strategy: 'overall' as const,
    participants: [
        { memberId: 'member-a', roster: [{ players: { id: 'player-1', display_name: 'Player One' } }], picks: [] },
        { memberId: 'member-b', roster: [], picks: [] },
    ],
    items: [{ kind: 'player' as const, fromMemberId: 'member-a', toMemberId: 'member-b', playerId: 'player-1' }],
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDynastyDecisionInputs.mockResolvedValue([row])
})

describe('dynasty trade analysis season identity', () => {
    it('uses the active league season instead of the wall clock year', async () => {
        mocks.getCurrentSeason.mockResolvedValue({ seasonYear: 2042 })
        let latest!: ReturnType<typeof useDynastyTradeAnalysis>
        const Probe = () => {
            latest = useDynastyTradeAnalysis(baseInput as unknown as Parameters<typeof useDynastyTradeAnalysis>[0])
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await flush() })

        expect(mocks.getDynastyDecisionInputs).toHaveBeenCalledWith(expect.objectContaining({
            leagueId: 'league-a', memberId: 'member-a', seasonYear: 2042,
        }))
        expect(latest.analysis?.assets.map((asset) => asset.assetId)).toEqual(['player-1'])
        await act(async () => { renderer.unmount() })
    })

    it('does not commit a season lookup from the prior league', async () => {
        const first = deferred<{ seasonYear: number }>()
        mocks.getCurrentSeason.mockImplementation((leagueId: string) =>
            leagueId === 'league-a' ? first.promise : Promise.resolve({ seasonYear: 2050 }))
        let latest!: ReturnType<typeof useDynastyTradeAnalysis>
        const Probe = ({ leagueId }: { leagueId: string }) => {
            latest = useDynastyTradeAnalysis({ ...baseInput, leagueId } as unknown as Parameters<typeof useDynastyTradeAnalysis>[0])
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { leagueId: 'league-a' })) })
        await act(async () => { renderer.update(React.createElement(Probe, { leagueId: 'league-b' })); await flush() })
        await act(async () => { first.resolve({ seasonYear: 2042 }); await first.promise })

        expect(latest.analysis?.assets.map((asset) => asset.assetId)).toEqual(['player-1'])
        expect(mocks.getDynastyDecisionInputs).toHaveBeenCalledWith(expect.objectContaining({
            leagueId: 'league-b', seasonYear: 2050,
        }))
        expect(mocks.getDynastyDecisionInputs).not.toHaveBeenCalledWith(expect.objectContaining({
            leagueId: 'league-a', seasonYear: 2042,
        }))
        await act(async () => { renderer.unmount() })
    })
})
