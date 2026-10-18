import { clearSessionCaches, setSessionOwner } from '@/lib/session-cache-registry'
import React, { useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMatchupData } from '@/hooks/use-matchup-data'
import { notifyLeagueChange, setLeagueChangesConnected } from '@/lib/league-changes'

const boundary = vi.hoisted(() => ({ focused: true, online: true, matchup: vi.fn(), lineup: vi.fn(), cache: new Map<string, unknown>() }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => boundary.focused, useFocusEffect: (callback: () => void | (() => void)) => {
    const focused = boundary.focused
    useEffect(() => focused ? callback() : undefined, [callback, focused])
} }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => boundary.online }))
vi.mock('@/lib/scoring', () => ({ getMyMatchup: boundary.matchup, getLeagueWeekMatchups: async () => [] }))
vi.mock('@/lib/lineup', () => ({
    getWeeklyLineup: boundary.lineup, getWeekDays: async () => [{ date: '2026-10-18' }],
    clampDateToWeek: (date: string) => date, invalidateCachedRoster: vi.fn(),
}))
vi.mock('@/lib/shared/week', () => ({ getSeasonWeekDates: async () => ['2026-10-18'], invalidateWeekNumberCache: vi.fn() }))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache: vi.fn() }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-18' }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: (key: string) => boundary.cache.get(key), writePersistentCache: (key: string, value: unknown) => { boundary.cache.set(key, value) } }))
vi.mock('@/lib/realtime', () => ({
    subscribeToTableChanges: () => ({}), disposeTableChangeSubscription: async () => {}, reportRealtimeCleanup: vi.fn(),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const member = { id: 'member' }, user = { id: 'user' }, league = { id: 'league' }
const matchup = { id: 'matchup', seasonId: 'season', seasonYear: 2027, weekNumber: 1, myMemberId: 'member', opponentMemberId: 'other', myPoints: 4 }
let latest: ReturnType<typeof useMatchupData>, screen: ReactTestRenderer, browser: EventTarget, page: EventTarget, hidden: boolean
const Probe = () => { latest = useMatchupData(member, user, league); return null }
const mount = async () => { await act(async () => { screen = create(React.createElement(Probe)) }) }
const update = async () => { await act(async () => { screen.update(React.createElement(Probe)) }) }
beforeEach(() => {
    clearSessionCaches()
    setSessionOwner('user')
    boundary.cache.clear()
    vi.useFakeTimers()
    boundary.focused = true; boundary.online = true; hidden = false
    boundary.matchup.mockReset().mockResolvedValue(matchup)
    boundary.lineup.mockReset().mockResolvedValue({ starters: [], bench: [], ir: [], taxi: [], benchSlots: 10 })
    browser = new EventTarget(); page = new EventTarget()
    Object.defineProperty(page, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' })
    vi.stubGlobal('window', browser); vi.stubGlobal('document', page)
    vi.stubGlobal('navigator', { get onLine() { return boundary.online } })
    setLeagueChangesConnected('league', false)
})
afterEach(async () => {
    await act(async () => { screen?.unmount() })
    setLeagueChangesConnected('league', false)
    setSessionOwner(null)
    vi.useRealTimers(); vi.unstubAllGlobals()
})

it.each(['hidden', 'offline'])('defers %s initial matchup reads and catches up once', async mode => {
    hidden = mode === 'hidden'; boundary.online = mode !== 'offline'
    await mount()
    expect(boundary.matchup).not.toHaveBeenCalled()
    expect(boundary.lineup).not.toHaveBeenCalled()
    hidden = false; boundary.online = true
    await update()
    await act(async () => { page.dispatchEvent(new Event('visibilitychange')); browser.dispatchEvent(new Event('focus')) })
    expect(boundary.matchup).toHaveBeenCalledOnce()
    expect(latest.matchup?.myPoints).toBe(4)
})

it('reuses a fresh route return but catches up a hidden lineup change', async () => {
    setLeagueChangesConnected('league', true)
    await mount()
    boundary.focused = false; await update()
    boundary.focused = true; await update()
    expect(boundary.matchup).toHaveBeenCalledOnce()
    hidden = true
    await act(async () => { page.dispatchEvent(new Event('visibilitychange')) })
    boundary.matchup.mockResolvedValue({ ...matchup, myPoints: 9 })
    await act(async () => { notifyLeagueChange('league', { topic: 'lineup', scopes: null }); await vi.advanceTimersByTimeAsync(500) })
    expect(boundary.matchup).toHaveBeenCalledOnce()
    hidden = false
    await act(async () => { page.dispatchEvent(new Event('visibilitychange')); browser.dispatchEvent(new Event('focus')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(boundary.matchup).toHaveBeenCalledTimes(2)
    expect(latest.matchup?.myPoints).toBe(9)
})

it('resumes before a suspended response settles and ignores that response', async () => {
    let release!: (value: typeof matchup) => void
    boundary.matchup.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    await mount()
    hidden = true
    await act(async () => { page.dispatchEvent(new Event('visibilitychange')) })
    boundary.matchup.mockResolvedValue({ ...matchup, myPoints: 12 })
    hidden = false
    await act(async () => { page.dispatchEvent(new Event('visibilitychange')) })
    expect(latest.matchup?.myPoints).toBe(12)
    await act(async () => { release(matchup) })
    expect(latest.matchup?.myPoints).toBe(12)
})

it('keeps inactive routes silent on browser resume', async () => {
    await mount()
    boundary.focused = false; await update()
    const reads = boundary.matchup.mock.calls.length
    await act(async () => { browser.dispatchEvent(new Event('focus')); page.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await latest.refreshSilently() })
    expect(boundary.matchup).toHaveBeenCalledTimes(reads)
    expect(boundary.lineup).toHaveBeenCalledTimes(2)
})

it('keeps a forced refresh pending until its authoritative follow-up finishes', async () => {
    let release!: (value: typeof matchup) => void
    boundary.matchup.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    await mount()
    let settled = false
    let refresh!: Promise<void>
    await act(async () => { refresh = latest.refresh().then(() => { settled = true }) })
    expect(settled).toBe(false)
    boundary.matchup.mockResolvedValue({ ...matchup, myPoints: 16 })
    await act(async () => { release(matchup); await refresh })
    expect(latest.matchup?.myPoints).toBe(16)
    expect(boundary.matchup).toHaveBeenCalledTimes(2)
})


it('consumes initial catch-up when a route remounts with the same runtime receipt', async () => {
    setLeagueChangesConnected('league', true)
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    await act(async () => { screen.unmount() })
    boundary.matchup.mockClear(); boundary.lineup.mockClear()
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(latest.matchup?.myPoints).toBe(4)
    expect(boundary.matchup).not.toHaveBeenCalled()
    expect(boundary.lineup).not.toHaveBeenCalled()
})

it('rejects a held response after the session changes away and returns', async () => {
    let release!: (value: typeof matchup) => void
    boundary.matchup.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    await mount()
    setSessionOwner('other')
    setSessionOwner('user')
    await act(async () => { release(matchup) })
    expect(latest.matchup).toBeUndefined()
    await act(async () => { await latest.refresh() })
    expect(latest.matchup?.myPoints).toBe(4)
})
