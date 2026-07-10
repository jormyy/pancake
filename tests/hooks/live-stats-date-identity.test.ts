import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLiveStats } from '@/hooks/use-live-stats'

const mocks = vi.hoisted(() => ({
    getLivePlayerStats: vi.fn(),
    getStartedTeams: vi.fn(),
    getTeamMatchups: vi.fn(),
}))

vi.mock('@/lib/games', () => ({
    getTodaysGames: vi.fn(async () => []),
    getLivePlayerStats: mocks.getLivePlayerStats,
}))
vi.mock('@/lib/lineup', () => ({
    getStartedTeams: mocks.getStartedTeams,
    getTeamMatchups: mocks.getTeamMatchups,
}))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => 'today' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}

afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
})

describe('useLiveStats date identity', () => {
    it('does not expose the previous date snapshot on the switch render', async () => {
        const nextTeams = deferred<Set<string>>()
        mocks.getLivePlayerStats.mockResolvedValue(new Map())
        mocks.getTeamMatchups.mockResolvedValue(new Map())
        mocks.getStartedTeams.mockImplementation((date: string) =>
            date === 'date-a' ? Promise.resolve(new Set(['LAL'])) : nextTeams.promise)
        const snapshots: { date: string; teams: string[] }[] = []
        const Probe = ({ date }: { date: string }) => {
            const result = useLiveStats(date)
            snapshots.push({ date, teams: [...result.startedTeams] })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { date: 'date-a' })); await Promise.resolve() })
        expect(snapshots.at(-1)?.teams).toEqual(['LAL'])

        await act(async () => { renderer.update(React.createElement(Probe, { date: 'date-b' })) })
        expect(snapshots.find((snapshot) => snapshot.date === 'date-b')).toEqual({ date: 'date-b', teams: [] })
        await act(async () => { nextTeams.resolve(new Set(['BOS'])); await nextTeams.promise })
        expect(snapshots.at(-1)).toEqual({ date: 'date-b', teams: ['BOS'] })
        await act(async () => { renderer.unmount() })
    })

    it('notifies silent refresh listeners only for today', async () => {
        vi.useFakeTimers()
        mocks.getLivePlayerStats.mockResolvedValue(new Map())
        mocks.getTeamMatchups.mockResolvedValue(new Map())
        mocks.getStartedTeams.mockResolvedValue(new Set())
        const todayRefresh = vi.fn()
        const historicalRefresh = vi.fn()
        const Probe = () => {
            useLiveStats('today', todayRefresh)
            useLiveStats('historical', historicalRefresh)
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })
        await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
        expect(todayRefresh).toHaveBeenCalledOnce()
        expect(historicalRefresh).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount(); await vi.advanceTimersByTimeAsync(15_000) })
    })
})
