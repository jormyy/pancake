import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { notifyLeagueChange, setLeagueChangesConnected } from '@/lib/league-changes'
import { usePlayerScreenData } from '@/hooks/use-player-screen-data'

const state = vi.hoisted(() => ({
    focused: true, player: vi.fn(), seasons: vi.fn(), averages: vi.fn(), games: vi.fn(),
    points: vi.fn(), transactions: vi.fn(), projection: vi.fn(), today: vi.fn(), write: vi.fn(),
}))
vi.mock('@react-navigation/native', async () => {
    const { useEffect } = await import('react')
    return { useFocusEffect: (callback: React.EffectCallback) => {
        const focused = state.focused
        useEffect(() => focused ? callback() : undefined, [callback, focused])
    } }
})
vi.mock('@/lib/players', () => ({ getPlayer: state.player, getAvailableSeasons: state.seasons, getPlayerSeasonAveragesFromView: state.averages, getPlayerGameLog: state.games, getPlayerFantasyPoints: state.points, getPlayerTransactionHistory: state.transactions }))
vi.mock('@/lib/projections', () => ({ getPlayerProjection: state.projection }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => undefined, writePersistentCache: state.write }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: () => 2026 }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-18' }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: state.today }) }) }) }) } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let hidden: boolean
let online: boolean
let doc: EventTarget
let events: EventTarget
let renderer: ReactTestRenderer | undefined
let latest: ReturnType<typeof usePlayerScreenData>
const Probe = ({ owner = 'actor', authorized = true }: { owner?: string; authorized?: boolean }) => {
    latest = usePlayerScreenData('player', 'league', { ownerKey: owner, authorized })
    return null
}
const reads = () => [state.player, state.seasons, state.averages, state.games, state.points, state.transactions, state.projection, state.today].map(read => read.mock.calls.length)
const changeVisibility = async (value: boolean) => { hidden = value; await act(async () => { doc.dispatchEvent(new Event('visibilitychange')) }) }
beforeEach(() => {
    vi.clearAllMocks()
    state.focused = true
    hidden = false
    online = true
    doc = new EventTarget()
    events = new EventTarget()
    Object.defineProperty(doc, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' })
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', events)
    vi.stubGlobal('navigator', { get onLine() { return online } })
    state.player.mockResolvedValue({ id: 'player', display_name: 'Current', nba_team: 'LAL' })
    state.seasons.mockResolvedValue([2026, 2025])
    state.averages.mockResolvedValue({ games_played: 4 })
    state.games.mockResolvedValue({ games: [{ gameId: 'first' }], hasMore: true })
    state.points.mockResolvedValue([])
    state.transactions.mockResolvedValue([])
    state.projection.mockResolvedValue(null)
    state.today.mockResolvedValue({ data: null, error: null })
})
afterEach(async () => { await act(async () => { renderer?.unmount() }); renderer = undefined; vi.unstubAllGlobals() })

it('defers every hidden or offline detail loader and catches up only the current player', async () => {
    hidden = true
    online = false
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(reads()).toEqual(Array(8).fill(0))
    await changeVisibility(false)
    expect(reads()).toEqual(Array(8).fill(0))
    online = true
    await act(async () => { events.dispatchEvent(new Event('online')) })
    expect(reads()).toEqual(Array(8).fill(1))
    expect(latest.player?.display_name).toBe('Current')
})

it('releases held reads on suspension, fences late responses and never reloads an inactive route', async () => {
    let release!: (player: { id: string; display_name: string; nba_team: string }) => void
    state.player.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await changeVisibility(true)
    await act(async () => { release({ id: 'player', display_name: 'Late', nba_team: 'LAL' }) })
    expect(latest.player).toBeNull()
    state.focused = false
    await act(async () => { renderer!.update(React.createElement(Probe)) })
    await changeVisibility(false)
    expect(state.player).toHaveBeenCalledTimes(1)
    state.focused = true
    await act(async () => { renderer!.update(React.createElement(Probe)) })
    expect(state.player).toHaveBeenCalledTimes(2)
    expect(latest.player?.display_name).toBe('Current')
})

it('keeps the selected season, retries the failed page offset and stops reads after authority is removed', async () => {
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { latest.handleSeasonSelect(2025) })
    state.games.mockRejectedValueOnce(new Error('page unavailable'))
    await act(async () => { await latest.loadMoreGames() })
    expect(latest.gameLogError).toBe('page unavailable')
    await act(async () => { await latest.loadMoreGames() })
    expect(state.games).toHaveBeenLastCalledWith('player', 'LAL', 2025, 15, 1)
    await changeVisibility(true)
    await changeVisibility(false)
    expect(latest.selectedSeason).toBe(2025)
    await act(async () => { renderer!.update(React.createElement(Probe, { authorized: false })) })
    const before = reads()
    await act(async () => { await latest.loadMoreGames() })
    await changeVisibility(true)
    await changeVisibility(false)
    expect(reads()).toEqual(before)
    await act(async () => { renderer!.update(React.createElement(Probe, { owner: 'next', authorized: false })) })
    expect(latest.player).toBeNull()
})


it('starts one detail read after the initial marker baseline and ignores its covered catch-up', async () => {
    vi.useFakeTimers()
    Object.defineProperty(events, 'WebSocket', { value: function WebSocket() {} })
    setLeagueChangesConnected('league', false)
    try {
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(reads()).toEqual(Array(8).fill(0))
        await act(async () => {
            notifyLeagueChange('league', { topic: 'resources', scopes: null })
            setLeagueChangesConnected('league', true)
            notifyLeagueChange('league', { topic: 'catchup', scopes: null })
        })
        await act(async () => { await vi.advanceTimersByTimeAsync(250) })
        expect(reads()).toEqual(Array(8).fill(1))
    } finally { setLeagueChangesConnected('league', false); vi.useRealTimers() }
})
