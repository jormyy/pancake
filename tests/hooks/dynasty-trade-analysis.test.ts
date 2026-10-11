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
    player_id: 'player-1', display_name: 'Player One', age: 24, five_year_rank: 8,
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
    participants: [
        { memberId: 'member-a', roster: [{ players: { id: 'player-1', display_name: 'Player One' } }], picks: [] },
        { memberId: 'member-b', roster: [], picks: [] },
    ],
    items: [{ kind: 'player' as const, fromMemberId: 'member-a', toMemberId: 'member-b', playerId: 'player-1' }],
}

beforeEach(() => {
    vi.resetAllMocks()
    mocks.getDynastyDecisionInputs.mockResolvedValue([row])
})

describe('dynasty trade analysis season identity', () => {
    it.each([false, true])('rejects partial historical analysis when the used pick is missing (reverse=%s)', async (reverse) => {
        mocks.getCurrentSeason.mockResolvedValue({ seasonYear: 2042 })
        let latest!: ReturnType<typeof useDynastyTradeAnalysis>
        let renderer!: ReactTestRenderer
        const Probe = ({ includePick }: { includePick: boolean }) => {
            const from = reverse ? 'member-b' : 'member-a', to = reverse ? 'member-a' : 'member-b'
            latest = useDynastyTradeAnalysis({ ...baseInput, items: [
                { ...baseInput.items[0], fromMemberId: from, toMemberId: to },
                ...(includePick ? [{ kind: 'pick', fromMemberId: to, toMemberId: from, pickId: 'used-pick' }] : []),
            ] } as unknown as Parameters<typeof useDynastyTradeAnalysis>[0])
            return null
        }
        await act(async () => { renderer = create(React.createElement(Probe, { includePick: true })); await flush() })
        expect(latest.analysis).toBeNull()
        expect(latest.error).toMatch(/pick.*unavailable/i)
        await act(async () => { renderer.update(React.createElement(Probe, { includePick: false })); await flush() })
        expect(latest.error).toBeNull()
        expect(latest.analysis?.assets.map(asset => asset.assetId)).toEqual(['player-1'])
        await act(async () => { renderer.unmount() })
    })

    it('never exposes provisional analysis during a same-team player change or failed return', async () => {
        mocks.getCurrentSeason.mockResolvedValue({ seasonYear: 2042 })
        const pending = deferred<typeof row[]>()
        mocks.getDynastyDecisionInputs.mockResolvedValueOnce([row]).mockReturnValueOnce(pending.promise)
            .mockRejectedValueOnce(new Error('forecast unavailable'))
        const observations: { playerId: string; analysis: unknown; loading: boolean }[] = []
        let renderer!: ReactTestRenderer
        const Probe = ({ playerId }: { playerId: string }) => {
            const result = useDynastyTradeAnalysis({ ...baseInput,
                participants: [{ memberId: 'member-a', picks: [], roster: [row.player_id, 'player-2'].map(id => ({ players: { id, display_name: id } })) }, baseInput.participants[1]],
                items: [{ ...baseInput.items[0], playerId }],
            } as unknown as Parameters<typeof useDynastyTradeAnalysis>[0])
            observations.push({ playerId, analysis: result.analysis, loading: result.loading })
            return null
        }
        await act(async () => { renderer = create(React.createElement(Probe, { playerId: 'player-1' })); await flush() })
        expect(observations.at(-1)?.analysis).not.toBeNull()
        observations.length = 0
        await act(async () => { renderer.update(React.createElement(Probe, { playerId: 'player-2' })); await flush() })
        expect(observations.every(result => result.analysis === null)).toBe(true)
        await act(async () => { pending.resolve([{ ...row, player_id: 'player-2', display_name: 'Player Two' }]); await pending.promise; await flush() })
        expect(observations.at(-1)?.analysis).not.toBeNull()
        observations.length = 0
        await act(async () => { renderer.update(React.createElement(Probe, { playerId: 'player-1' })); await flush() })
        expect(observations.every(result => result.analysis === null)).toBe(true)
        await act(async () => { renderer.unmount() })
    })
    it('keeps a successful roster-only forecast usable when no ranking row exists', async () => {
        mocks.getCurrentSeason.mockResolvedValue({ seasonYear: 2042 })
        mocks.getDynastyDecisionInputs.mockResolvedValue([])
        let latest!: ReturnType<typeof useDynastyTradeAnalysis>
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(() => {
            latest = useDynastyTradeAnalysis(baseInput as unknown as Parameters<typeof useDynastyTradeAnalysis>[0])
            return null
        })); await flush() })
        expect(latest.loading).toBe(false)
        expect(latest.error).toBeNull()
        expect(latest.analysis?.assets.map(asset => asset.assetId)).toEqual(['player-1'])
        await act(async () => { renderer.unmount() })
    })
    it('hides prior analysis on the first render in another league', async () => {
        mocks.getCurrentSeason.mockImplementation((leagueId: string) => leagueId === 'league-a'
            ? Promise.resolve({ seasonYear: 2042 }) : Promise.reject(new Error('offline')))
        const observed: { leagueId: string; analysis: unknown; seasonYear: number | null }[] = []
        let renderer!: ReactTestRenderer
        const Probe = ({ leagueId }: { leagueId: string }) => {
            const result = useDynastyTradeAnalysis({ ...baseInput, leagueId } as unknown as Parameters<typeof useDynastyTradeAnalysis>[0])
            observed.push({ leagueId, analysis: result.analysis, seasonYear: result.seasonYear })
            return null
        }
        await act(async () => { renderer = create(React.createElement(Probe, { leagueId: 'league-a' })); await flush() })
        expect(observed.at(-1)?.analysis).not.toBeNull()
        await act(async () => { renderer.update(React.createElement(Probe, { leagueId: 'league-b' })); await flush() })
        expect(observed.filter((row) => row.leagueId === 'league-b').every((row) => row.analysis == null && row.seasonYear == null)).toBe(true)
        await act(async () => { renderer.unmount() })
    })
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
        expect(latest.seasonYear).toBe(2042)
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
