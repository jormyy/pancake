import React, { useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMatchupData } from '@/hooks/use-matchup-data'
import { resolveHomeSurface } from '@/lib/home-surface'
import { clearSessionCaches, setSessionOwner } from '@/lib/session-cache-registry'

const state = vi.hoisted(() => ({ read: vi.fn(), cache: new Map<string, unknown>() }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true, useFocusEffect: (callback: () => void | (() => void)) => useEffect(callback, [callback]) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/lib/scoring', () => ({ getMyMatchup: state.read, getLeagueWeekMatchups: async () => [] }))
vi.mock('@/lib/lineup', () => ({ getWeeklyLineup: vi.fn(), getWeekDays: vi.fn(), clampDateToWeek: vi.fn(), invalidateCachedRoster: vi.fn() }))
vi.mock('@/lib/shared/week', () => ({ getSeasonWeekDates: vi.fn(), invalidateWeekNumberCache: vi.fn() }))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache: vi.fn() }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-18' }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: (key: string) => state.cache.get(key), writePersistentCache: (key: string, value: unknown) => state.cache.set(key, value) }))
vi.mock('@/lib/realtime', () => ({ subscribeToTableChanges: () => ({}), disposeTableChangeSubscription: async () => {}, reportRealtimeCleanup: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const user = { id: 'user' }, member = { id: 'member' }
let view: ReactTestRenderer
let frames: string[]
let latest!: ReturnType<typeof useMatchupData>
function Probe({ leagueId = 'a', validated = true }: { leagueId?: string; validated?: boolean }) {
    const value = useMatchupData(member, user, { id: leagueId }, validated)
    latest = value
    const surface = resolveHomeSurface({ leagueStatus: 'active', hasMatchup: Boolean(value.matchup), loading: value.matchupLoading, error: value.error, emptyConfirmed: value.emptyConfirmed })
    frames.push(surface)
    return React.createElement('notice', { surface })
}
beforeEach(() => {
    clearSessionCaches()
    setSessionOwner(user.id)
    state.cache.clear()
    state.read.mockReset().mockResolvedValue(null)
    frames = []
})
afterEach(async () => {
    await act(async () => view?.unmount())
    setSessionOwner(null)
    vi.restoreAllMocks()
})
it('restores the settled empty notice in every frame through ten back/forward remounts', async () => {
    await act(async () => { view = create(React.createElement(Probe)) })
    expect(frames.at(-1)).toBe('empty')
    for (let cycle = 0; cycle < 10; cycle += 1) {
        await act(async () => view.unmount())
        frames = []
        await act(async () => { view = create(React.createElement(Probe)) })
        expect(frames, `navigation ${cycle + 1}`).toEqual(expect.arrayContaining(['empty']))
        expect(frames.every(frame => frame === 'empty'), `blank frame on navigation ${cycle + 1}: ${frames}`).toBe(true)
    }
    expect(state.read).toHaveBeenCalledOnce()
})
it('restores the empty notice on league A to B to A without a blank frame', async () => {
    await act(async () => { view = create(React.createElement(Probe)) })
    await act(async () => view.update(React.createElement(Probe, { leagueId: 'b' })))
    expect(frames.at(-1)).toBe('empty')
    frames = []
    await act(async () => view.update(React.createElement(Probe, { leagueId: 'a' })))
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every(frame => frame === 'empty'), `league return frames: ${frames}`).toBe(true)
    expect(state.read).toHaveBeenCalledTimes(2)
})
it('keeps a validated same-day empty answer visible during membership revalidation', async () => {
    await act(async () => { view = create(React.createElement(Probe)) })
    await act(async () => view.unmount())
    frames = []
    await act(async () => { view = create(React.createElement(Probe, { validated: false })) })
    expect(frames.every(frame => frame === 'empty'), `membership restore frames: ${frames}`).toBe(true)
})

it('keeps a persisted empty answer during a slow recheck and a failed background read', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    await act(async () => { view = create(React.createElement(Probe)) })
    await act(async () => view.unmount())
    clearSessionCaches()
    now.mockReturnValue(32_000)
    let fail!: (error: Error) => void
    state.read.mockReturnValue(new Promise((_, reject) => { fail = reject }))
    frames = []
    await act(async () => { view = create(React.createElement(Probe)) })
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every(frame => frame === 'empty'), `pending frames: ${frames}`).toBe(true)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => fail(new Error('offline')))
    expect(frames.every(frame => frame === 'empty'), `failed refresh frames: ${frames}`).toBe(true)
    expect(latest.error).toBe('Failed to load matchup')
})
