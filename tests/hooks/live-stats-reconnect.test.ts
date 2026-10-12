import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ online: true, hidden: false, revision: 0, failed: false, gate: null as Promise<void> | null }))
const mocks = vi.hoisted(() => ({ games: vi.fn(), stats: vi.fn() }))
vi.mock('@/lib/games', () => ({ getGameDay: mocks.games, getLivePlayerStats: mocks.stats }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-07' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let useLiveStats: typeof import('@/hooks/use-live-stats').useLiveStats
let renderer: ReactTestRenderer | null
let latest: ReturnType<typeof useLiveStats>
let events: EventTarget
let doc: EventTarget
const silent = vi.fn()
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0) }) }
const dispatch = async (name: string) => { await act(async () => { events.dispatchEvent(new Event(name)); await vi.advanceTimersByTimeAsync(0) }) }
const visible = async (hidden: boolean) => { state.hidden = hidden; await act(async () => { doc.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0) }) }
const mount = async () => { await act(async () => { renderer = create(React.createElement(() => { latest = useLiveStats('2026-10-07', silent); return null })) }); await flush() }
beforeEach(async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-07T12:00:00Z')); vi.resetModules(); vi.clearAllMocks()
    Object.assign(state, { online: true, hidden: false, revision: 0, failed: false, gate: null })
    events = new EventTarget(); doc = new EventTarget()
    Object.defineProperty(doc, 'visibilityState', { get: () => state.hidden ? 'hidden' : 'visible' })
    vi.stubGlobal('window', events); vi.stubGlobal('document', doc); vi.stubGlobal('navigator', { get onLine() { return state.online } })
    mocks.games.mockImplementation(async () => { const revision = state.revision; await state.gate; return { games: [{ id: 'game', status: 'InProgress', home_team: 'BOS', away_team: 'ATL', home_score: revision }], startedTeams: new Set(['BOS']), teamMatchups: new Map() } })
    mocks.stats.mockImplementation(async () => { const revision = state.revision; const failed = state.failed; await state.gate; if (failed) throw new Error('503'); return new Map([['player', { points: revision }]]) })
    ;({ useLiveStats } = await import('@/hooks/use-live-stats')); renderer = null
})
afterEach(() => { act(() => renderer?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals() })
describe('shared live reconnect', () => {
    it('loads an empty offline mount on online without waiting for idle polling', async () => {
        state.online = false; await mount(); expect(mocks.games).not.toHaveBeenCalled()
        state.online = true; state.revision = 37; await dispatch('online')
        expect(latest.liveStats.get('player')?.points).toBe(37); expect(latest.freshness).toBe('fresh'); expect(silent).toHaveBeenCalledOnce()
    })
    it('defers hidden online and mount work until one visible catchup', async () => {
        state.hidden = true; await mount(); await dispatch('online'); await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
        expect(mocks.games).not.toHaveBeenCalled(); expect(silent).not.toHaveBeenCalled()
        await visible(false); expect(mocks.games).toHaveBeenCalledOnce(); expect(silent).toHaveBeenCalledOnce()
    })
    it('coalesces overlapping online and focus events with one fanout', async () => {
        await mount(); mocks.games.mockClear(); mocks.stats.mockClear()
        await act(async () => { events.dispatchEvent(new Event('online')); events.dispatchEvent(new Event('online')); events.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0) })
        expect(mocks.games).toHaveBeenCalledOnce(); expect(mocks.stats).toHaveBeenCalledOnce(); expect(silent).toHaveBeenCalledOnce()
    })
    it('discards a pre-disconnect response and follows it with the new revision', async () => {
        let release!: () => void; state.gate = new Promise<void>(resolve => { release = resolve }); await mount()
        state.online = false; await dispatch('offline'); state.revision = 41; state.online = true; await dispatch('online')
        state.gate = null; await act(async () => { release(); await vi.advanceTimersByTimeAsync(0) })
        expect(mocks.games).toHaveBeenCalledTimes(2); expect(latest.liveStats.get('player')?.points).toBe(41); expect(silent).toHaveBeenCalledOnce()
    })
    it('keeps failed or offline data out of live authority and retries on focus', async () => {
        await mount(); state.online = false; await dispatch('offline'); expect(latest.liveTeams.size).toBe(0); expect(latest.freshness).toBe('offline')
        state.online = true; state.failed = true; await dispatch('online'); expect(latest.freshness).toBe('failed'); expect(latest.liveTeams.size).toBe(0)
        state.failed = false; state.revision = 91; await dispatch('focus'); expect(latest.freshness).toBe('fresh'); expect(latest.liveStats.get('player')?.points).toBe(91)
    })
    it('removes resume listeners and polling when the last consumer leaves', async () => {
        await mount(); act(() => renderer?.unmount()); renderer = null; mocks.games.mockClear()
        await dispatch('online'); await visible(false); await act(async () => { await vi.advanceTimersByTimeAsync(120000) })
        expect(mocks.games).not.toHaveBeenCalled(); expect(silent).not.toHaveBeenCalled()
    })
})
