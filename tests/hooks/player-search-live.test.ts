import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useVisiblePlayerRows } from '@/hooks/use-player-search'
import { notifyLeagueChange, leagueChangeReceiver } from '@/lib/league-changes'
import { playerRow } from '../helpers/fixtures'

const mocks = vi.hoisted(() => ({ read: vi.fn(), native: null as ((value: string) => void) | null }))
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: (_: string, listener: (value: string) => void) => { mocks.native = listener; return { remove: vi.fn() } } } }))
vi.mock('@shopify/flash-list', () => ({}))
vi.mock('@/lib/players', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/players')>(), getVisiblePlayerTotals: mocks.read }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/lineup', () => ({}))
vi.mock('@/lib/shared/week', () => ({}))
vi.mock('@/lib/persistent-cache', () => ({}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
let latest: ReturnType<typeof useVisiblePlayerRows>
let doc: EventTarget & { visibilityState: string }
const players = [playerRow({ id: 'a' }), playerRow({ id: 'b' }), playerRow({ id: 'offscreen' })]
const scoring = { points: 1 }
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
    mocks.read.mockReset().mockResolvedValue([{ player_id: 'a', totals: { points: 22, points_count: 2, games_played: 2 }, rounded_fantasy_average: null, game_status: 'Final', game_time: null, started_at: null }])
    await act(async () => { screen = create(React.createElement(Probe)) })
})
afterEach(async () => { await act(async () => screen.unmount()); vi.useRealTimers(); vi.unstubAllGlobals() })
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
