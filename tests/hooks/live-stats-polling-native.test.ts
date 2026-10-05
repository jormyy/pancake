import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Native counterpart of live-stats-polling: a backgrounded app does not poll,
// and returning to the foreground catches up at once.

const state = vi.hoisted(() => ({
    counts: new Map<string, number>(),
    fixtures: {} as Record<string, Record<string, unknown>[]>,
    appState: 'active',
    appStateListeners: [] as ((next: string) => void)[],
}))

vi.mock('@/lib/supabase', async () => ({
    supabase: (await import('../helpers/fake-supabase')).createFakeSupabase(state.counts, state.fixtures),
}))
vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    AppState: {
        get currentState() { return state.appState },
        addEventListener: (event: string, listener: (next: string) => void) => {
            if (event === 'change') state.appStateListeners.push(listener)
            return { remove: vi.fn() }
        },
    },
}))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-05', endOfETDayUTC: () => '2026-10-06T04:00:00.000Z' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TODAY = '2026-10-05'
const reads = () => (state.counts.get('nba_games') ?? 0) + (state.counts.get('player_game_stats') ?? 0)
const setAppState = async (next: 'active' | 'background') => {
    state.appState = next
    await act(async () => {
        for (const listener of state.appStateListeners) listener(next)
        await vi.advanceTimersByTimeAsync(0)
    })
}

let renderer: ReactTestRenderer | null = null
let silentRefreshes = 0

beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-05T23:45:00Z'))
    vi.resetModules()
    const { useLiveStats } = await import('@/hooks/use-live-stats')
    state.counts.clear()
    state.fixtures.nba_games = [{
        id: '1', nba_game_id: '002251', home_team: 'LAL', away_team: 'BOS', home_score: 50, away_score: 48,
        status: 'InProgress', game_status_text: 'Q2', game_date: TODAY, game_time: '2026-10-05T23:30:00Z', started_at: null,
    }]
    state.fixtures.player_game_stats = []
    state.appState = 'active'
    state.appStateListeners.length = 0
    silentRefreshes = 0
    const Probe = () => {
        useLiveStats(TODAY, () => { silentRefreshes += 1 })
        return null
    }
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
})

afterEach(() => {
    act(() => renderer?.unmount())
    vi.useRealTimers()
})

describe('live stats on native', () => {
    it('does not poll while the app is in the background, then catches up', async () => {
        await setAppState('background')
        state.counts.clear()
        await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000) })
        expect(reads()).toBe(0)
        expect(silentRefreshes).toBe(0)

        await setAppState('active')
        expect(reads()).toBe(2)
        expect(silentRefreshes).toBe(1)
    })
})
