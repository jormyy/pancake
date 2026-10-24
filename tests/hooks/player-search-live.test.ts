import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePlayerSearch, useVisiblePlayerRows } from '@/hooks/use-player-search'
import { notifyLeagueChange, leagueChangeReceiver } from '@/lib/league-changes'
import { playerRow } from '../helpers/fixtures'

const mocks = vi.hoisted(() => ({ read: vi.fn(), search: vi.fn(), teams: null as Set<string> | null, native: null as ((value: string) => void) | null }))
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: (_: string, listener: (value: string) => void) => { mocks.native = listener; return { remove: vi.fn() } } } }))
vi.mock('@shopify/flash-list', () => ({}))
vi.mock('@/hooks/use-live-stats', () => ({ readCachedLiveTeams: () => mocks.teams }))
vi.mock('@/lib/players', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/players')>(), getVisiblePlayerTotals: mocks.read, searchPlayers: mocks.search }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/lineup', () => ({ getWeekDays: async () => [] }))
vi.mock('@/lib/shared/week', () => ({ getCurrentWeekNumber: async () => 1 }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
let latest: ReturnType<typeof useVisiblePlayerRows>
let doc: EventTarget & { visibilityState: string }
const players = [playerRow({ id: 'a' }), playerRow({ id: 'b' }), playerRow({ id: 'offscreen' })]
const scoring = { points: 1 }
const owned = new Map()
const waivers = new Set<string>()
const SearchProbe = () => {
    const search = usePlayerSearch('league', owned, waivers, 'member', { ownerId: 'one', initialLiveStats: true, scoringSettings: scoring })
    latest = useVisiblePlayerRows(search.results.players, 'league', search.season.value, scoring, {
        enabled: true, ownerKey: JSON.stringify(['one', 'member', 'league']), initialTotals: search.results.totalsSnapshot,
    })
    return null
}
const Probe = ({ owner = 'one', enabled = true }: { owner?: string; enabled?: boolean }) => {
    latest = useVisiblePlayerRows(players, 'league', 2027, scoring, { enabled, ownerKey: owner })
    return null
}
const hint = () => notifyLeagueChange('league', { topic: 'player_stats', scopes: null })
const visible = async () => act(async () => latest.onViewableItemsChanged({ viewableItems: players.slice(0, 2).map(item => ({ item, isViewable: true })) }))
const tick = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
beforeEach(async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-24T18:00:00Z'))
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    vi.stubGlobal('document', doc)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    mocks.search.mockReset().mockResolvedValue(players)
    mocks.teams = null
    mocks.read.mockReset().mockResolvedValue([{ player_id: 'a', totals: { points: 22, points_count: 2, games_played: 2 }, rounded_fantasy_average: null, game_status: 'Final', game_time: null, started_at: null }])
    await act(async () => { screen = create(React.createElement(Probe)) })
})
afterEach(async () => { await act(async () => screen.unmount()); vi.useRealTimers(); vi.unstubAllGlobals() })
it('uses page totals without a second visible read until a later change hint', async () => {
    await act(async () => { screen.unmount(); screen = create(React.createElement(SearchProbe)) })
    expect(mocks.read).toHaveBeenCalledOnce()
    expect(latest.rows[0].avg_fantasy_points).toBe(11)
    await visible()
    await tick(500)
    await act(async () => latest.onViewableItemsChanged({ viewableItems: [{ item: players[2], isViewable: true }] }))
    await tick(60_000)
    expect(mocks.read).toHaveBeenCalledOnce()
    hint()
    await tick(300)
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(mocks.read).toHaveBeenLastCalledWith('league', ['offscreen'], expect.any(Number))
})

it('throttles a stats hint from the page read and refreshes only the current visible players', async () => {
    await act(async () => { screen.unmount(); screen = create(React.createElement(SearchProbe)) })
    await visible()
    hint()
    await tick(9999)
    expect(mocks.read).toHaveBeenCalledOnce()
    await tick(1)
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(mocks.read).toHaveBeenLastCalledWith('league', ['a', 'b'], expect.any(Number))
})

it('debounces bursts, reads only visible IDs and keeps their order', async () => {
    await visible()
    hint(); hint(); hint()
    await tick(299)
    expect(mocks.read).not.toHaveBeenCalled()
    await tick(1)
    expect(mocks.read).toHaveBeenCalledWith('league', ['a', 'b'], 2027)
    expect(latest.rows.map(row => row.id)).toEqual(['a', 'b', 'offscreen'])
    expect(latest.rows[0].avg_fantasy_points).toBe(11)
    hint(); hint()
    await tick(9999)
    expect(mocks.read).toHaveBeenCalledTimes(1)
    await tick(1)
    expect(mocks.read).toHaveBeenCalledTimes(2)
})
it('pauses hidden reads and refreshes on return', async () => {
    await visible(); await tick(300)
    await act(async () => { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')) })
    hint(); await tick(60_000)
    expect(mocks.read).toHaveBeenCalledTimes(1)
    await act(async () => { doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')) })
    await tick(300)
    expect(mocks.read).toHaveBeenCalledTimes(2)
})
it('pauses native background work and inactive tabs', async () => {
    await visible()
    await act(async () => mocks.native?.('background'))
    await tick(60_000)
    expect(mocks.read).not.toHaveBeenCalled()
    await act(async () => mocks.native?.('active'))
    await tick(300)
    expect(mocks.read).toHaveBeenCalledOnce()
    await act(async () => screen.update(React.createElement(Probe, { enabled: false })))
    hint(); await tick(60_000)
    expect(mocks.read).toHaveBeenCalledOnce()
})
it('keeps last numbers during refresh and rejects a late previous-owner result', async () => {
    await visible(); await tick(300)
    let finish!: (rows: unknown[]) => void
    mocks.read.mockReturnValue(new Promise(resolve => { finish = resolve }))
    hint(); await tick(10_000)
    expect(latest.rows[0].avg_fantasy_points).toBe(11)
    await act(async () => screen.update(React.createElement(Probe, { owner: 'two' })))
    await act(async () => finish([{ player_id: 'a', totals: { points: 999, games_played: 1 } }]))
    expect(latest.rows[0].avg_fantasy_points).toBeUndefined()
})
it('accepts the real stats hint without broad recovery', () => {
    const receive = vi.fn()
    const consume = leagueChangeReceiver('league', receive)
    expect(consume({ league_id: 'league', topic: 'player_stats', revision: 1, scopes: null, details: null })).toBe(true)
    expect(receive).toHaveBeenCalledWith({ topic: 'player_stats', scopes: null })
})

it('shows a known live game before visible-row reads and accepts its final status', async () => {
    mocks.teams = new Set([players[0].nba_team!])
    await act(async () => screen.update(React.createElement(Probe, { owner: 'known-game' })))
    expect(latest.rows[0].playing_now).toBe(true)
    expect(mocks.read).not.toHaveBeenCalled()
    await visible()
    await tick(300)
    expect(latest.rows[0].playing_now).toBe(false)
    expect(mocks.read).toHaveBeenCalledOnce()
})
