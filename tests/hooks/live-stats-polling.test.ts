import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Request budget and cadence of the shared live-stats poll: reads per snapshot,
// no polling while the page is hidden, an immediate catch-up on return, and
// reuse of a snapshot the poll would not yet have refreshed.

const state = vi.hoisted(() => ({
    counts: new Map<string, number>(),
    fixtures: {} as Record<string, Record<string, unknown>[]>,
    failGames: false,
    visibility: 'visible',
    visibilityListeners: [] as (() => void)[],
}))

vi.mock('@/lib/supabase', async () => {
    const fake = (await import('../helpers/fake-supabase')).createFakeSupabase(state.counts, state.fixtures)
    return {
        supabase: {
            ...fake,
            from: (table: string) => {
                if (table === 'nba_games' && state.failGames) throw new Error('games offline')
                return fake.from(table)
            },
        },
    }
})
vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-05', endOfETDayUTC: () => '2026-10-06T04:00:00.000Z' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { document?: unknown }).document = {
    get visibilityState() { return state.visibility },
    addEventListener: (event: string, listener: () => void) => {
        if (event === 'visibilitychange') state.visibilityListeners.push(listener)
    },
}

const TODAY = '2026-10-05'
const game = (id: string, status: string) => ({
    id, nba_game_id: `00225${id}`, home_team: `H${id}`, away_team: `A${id}`, home_score: 0, away_score: 0,
    status, game_status_text: status, game_date: TODAY, game_time: '2026-10-05T23:30:00Z', started_at: null,
})

const reads = () => (state.counts.get('nba_games') ?? 0) + (state.counts.get('player_game_stats') ?? 0)
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0) }) }
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const setVisibility = async (visibility: 'visible' | 'hidden') => {
    state.visibility = visibility
    await act(async () => {
        for (const listener of state.visibilityListeners) listener()
        await vi.advanceTimersByTimeAsync(0)
    })
}

let useLiveStats: typeof import('@/hooks/use-live-stats').useLiveStats
let renderer: ReactTestRenderer | null
let silentRefreshes: number
let latest: ReturnType<typeof useLiveStats>
const onSilentRefresh = () => { silentRefreshes += 1 }
const Probe = () => {
    latest = useLiveStats(TODAY, onSilentRefresh)
    return null
}
const mount = async () => {
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await flush()
}
const unmount = () => {
    act(() => renderer?.unmount())
    renderer = null
}

beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-05T23:45:00Z'))
    vi.resetModules()
    ;({ useLiveStats } = await import('@/hooks/use-live-stats'))
    state.counts.clear()
    state.fixtures.nba_games = [game('1', 'Scheduled'), game('2', 'Scheduled')]
    state.fixtures.player_game_stats = []
    state.failGames = false
    state.visibility = 'visible'
    state.visibilityListeners.length = 0
    silentRefreshes = 0
    renderer = null
})

afterEach(() => {
    if (renderer) unmount()
    vi.useRealTimers()
})

describe('live stats snapshot', () => {
    it('reads the slate once and box scores once per snapshot', async () => {
        await mount()

        expect(state.counts.get('nba_games')).toBe(1)
        expect(state.counts.get('player_game_stats')).toBe(1)
        expect([...latest.teamMatchups.keys()].sort()).toEqual(['A1', 'A2', 'H1', 'H2'])
        expect(latest.todaysGames.map((row) => row.id)).toEqual(['1', '2'])
        expect([...latest.startedTeams].sort()).toEqual(['A1', 'A2', 'H1', 'H2'])
    })

    it('polls once a minute with no game live and every 15 s with one live', async () => {
        await mount()
        state.counts.clear()
        await advance(60_000)
        expect(reads()).toBe(2)

        state.fixtures.nba_games = [game('1', 'InProgress'), game('2', 'Scheduled')]
        await advance(60_000)
        state.counts.clear()
        silentRefreshes = 0
        await advance(60_000)
        expect(reads()).toBe(8)
        expect(silentRefreshes).toBe(4)
    })

    it('does not poll while the page is hidden', async () => {
        state.fixtures.nba_games = [game('1', 'InProgress')]
        await mount()
        await setVisibility('hidden')
        state.counts.clear()
        silentRefreshes = 0

        await advance(5 * 60_000)

        expect(reads()).toBe(0)
        expect(silentRefreshes).toBe(0)
    })

    it('catches up at once when the page returns after a missed tick', async () => {
        state.fixtures.nba_games = [game('1', 'InProgress')]
        await mount()
        await setVisibility('hidden')
        await advance(2 * 60_000)
        state.counts.clear()
        silentRefreshes = 0

        await setVisibility('visible')

        expect(reads()).toBe(2)
        expect(silentRefreshes).toBe(1)
    })

    it('does not refetch on a return inside the cadence', async () => {
        await mount()
        await setVisibility('hidden')
        await advance(10_000)
        state.counts.clear()

        await setVisibility('visible')

        expect(reads()).toBe(0)
    })

    it('reuses a snapshot the poll would not yet have refreshed when the screen remounts', async () => {
        await mount()
        unmount()
        state.counts.clear()

        await advance(30_000)
        await mount()
        expect(reads()).toBe(0)

        unmount()
        await advance(31_000)
        await mount()
        expect(reads()).toBe(2)
    })

    it('keeps the 15 s freshness while a game is live', async () => {
        state.fixtures.nba_games = [game('1', 'InProgress')]
        await mount()
        unmount()
        state.counts.clear()

        await advance(16_000)
        await mount()

        expect(reads()).toBe(2)
    })

    it('retries on the next mount after a failed read and keeps the last good values', async () => {
        await mount()
        unmount()
        state.failGames = true
        await advance(61_000)
        await mount()
        expect([...latest.teamMatchups.keys()].sort()).toEqual(['A1', 'A2', 'H1', 'H2'])
        unmount()

        state.failGames = false
        state.counts.clear()
        await advance(1_000)
        await mount()

        expect(state.counts.get('nba_games')).toBe(1)
    })
})
