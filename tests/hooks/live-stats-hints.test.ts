import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ stats: vi.fn(), games: vi.fn() }))
vi.mock('@/lib/games', () => ({ getLivePlayerStats: boundary.stats, getGameDay: boundary.games }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-18' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let useLiveStats: typeof import('@/hooks/use-live-stats').useLiveStats
let changes: typeof import('@/lib/league-changes')
let renderer: ReactTestRenderer | null
let latest: ReturnType<typeof useLiveStats>
const Probe = () => { latest = useLiveStats('2026-10-18', { scope: 'owner', playerIds: ['selected'], leagueId: 'league', seasonId: 'season' }); return null }
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
beforeEach(async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T12:00:00Z')); vi.resetModules(); vi.clearAllMocks()
    boundary.games.mockResolvedValue({ games: [{ status: 'InProgress', home_team: 'NYK' }], startedTeams: new Set(['NYK']), teamMatchups: new Map() })
    boundary.stats.mockResolvedValue(new Map([['selected', { points: 7 }]]))
    ;({ useLiveStats } = await import('@/hooks/use-live-stats'))
    changes = await import('@/lib/league-changes')
    renderer = null
})
afterEach(() => { act(() => renderer?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals() })
const mount = async () => { await act(async () => { renderer = create(React.createElement(Probe)) }) }
const signal = () => changes.notifyLeagueChange('league', { topic: 'stat', scopes: [{ season_id: 'season', date: '2026-10-18' }] })

it('uses committed stat hints while connected and retains a bounded polling fallback', async () => {
    await mount()
    changes.setLeagueChangesConnected('league', true)
    await advance(15_000)
    expect(boundary.stats).toHaveBeenCalledOnce()
    boundary.stats.mockResolvedValue(new Map([['selected', { points: 4 }]]))
    await act(async () => { signal(); signal() }); await advance(200)
    expect(boundary.stats).toHaveBeenCalledTimes(2)
    expect(boundary.stats).toHaveBeenLastCalledWith('2026-10-18', ['selected'])
    expect(latest.liveStats.get('selected')?.points).toBe(4)
    await advance(45_000)
    expect(boundary.stats).toHaveBeenCalledTimes(3)
    changes.setLeagueChangesConnected('league', false)
    await advance(15_000)
    expect(boundary.stats).toHaveBeenCalledTimes(4)
})

it('ignores hints for another league, season or day', async () => {
    await mount()
    await act(async () => {
        changes.notifyLeagueChange('other', { topic: 'stat', scopes: null })
        changes.notifyLeagueChange('league', { topic: 'stat', scopes: [{ season_id: 'old', date: '2026-10-18' }] })
        changes.notifyLeagueChange('league', { topic: 'stat', scopes: [{ season_id: 'season', date: '2026-10-17' }] })
    })
    await advance(200)
    expect(boundary.stats).toHaveBeenCalledOnce()
})

it('reads after an older in-flight response when a newer committed hint arrives', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    boundary.stats.mockImplementationOnce(async () => { await held; return new Map([['selected', { points: 999 }]]) })
    await mount()
    await act(async () => { signal() }); await advance(200)
    expect(boundary.stats).toHaveBeenCalledOnce()
    boundary.stats.mockResolvedValue(new Map([['selected', { points: 3 }]]))
    await act(async () => { release(); await held }); await advance(0)
    expect(boundary.stats).toHaveBeenCalledTimes(2)
    expect(latest.liveStats.get('selected')?.points).toBe(3)
})

it('joins visibility catch-up with a pending hint instead of reading twice', async () => {
    const page = new EventTarget(), events = new EventTarget()
    let hidden = false
    Object.defineProperty(page, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' })
    vi.stubGlobal('document', page); vi.stubGlobal('window', events); vi.stubGlobal('navigator', { onLine: true })
    await mount()
    changes.setLeagueChangesConnected('league', true)
    hidden = true
    await act(async () => { page.dispatchEvent(new Event('visibilitychange')); signal() })
    await advance(60_000)
    expect(boundary.stats).toHaveBeenCalledOnce()
    hidden = false
    await act(async () => { page.dispatchEvent(new Event('visibilitychange')) })
    await advance(200)
    expect(boundary.stats).toHaveBeenCalledTimes(2)
})
