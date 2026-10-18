import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ stats: vi.fn(), games: vi.fn() }))
vi.mock('@/lib/games', () => ({ getLivePlayerStats: boundary.stats, getGameDay: boundary.games }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-18' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let useLiveStats: typeof import('@/hooks/use-live-stats').useLiveStats
let changes: typeof import('@/lib/league-changes')
let sessions: typeof import('@/lib/session-cache-registry')
let renderer: ReactTestRenderer | null
let latest: ReturnType<typeof useLiveStats>
const day = (status = 'InProgress') => ({ games: [{ status, home_team: 'NYK', away_team: 'BOS' }], startedTeams: new Set(['NYK']), teamMatchups: new Map() })
const Probe = ({ ids = ['one'], enabled = true, scope = 'owner' }: { ids?: string[]; enabled?: boolean; scope?: string }) => {
    latest = useLiveStats('2026-10-18', { enabled, scope, playerIds: ids, leagueId: 'league', seasonId: 'season' })
    return null
}
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(200) }) }
beforeEach(async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T12:00:00Z')); vi.resetModules(); vi.clearAllMocks()
    boundary.games.mockResolvedValue(day())
    boundary.stats.mockResolvedValue(new Map([['one', { points: 7 }]]))
    ;({ useLiveStats } = await import('@/hooks/use-live-stats'))
    changes = await import('@/lib/league-changes')
    sessions = await import('@/lib/session-cache-registry')
    changes.setLeagueChangesConnected('league', true)
    renderer = null
})
afterEach(() => { act(() => renderer?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals() })

it('does no disabled work and shares the date read across selected-player scopes', async () => {
    await act(async () => { renderer = create(React.createElement(Probe, { enabled: false })) })
    expect(boundary.games).not.toHaveBeenCalled()
    expect(boundary.stats).not.toHaveBeenCalled()
    await act(async () => { renderer!.update(React.createElement(Probe)) })
    await tick()
    await act(async () => { renderer!.update(React.createElement(Probe, { ids: ['two'], scope: 'other-display' })) })
    await tick()
    expect(boundary.games).toHaveBeenCalledOnce()
    expect(boundary.stats).toHaveBeenLastCalledWith('2026-10-18', ['two'])
    expect(boundary.stats).toHaveBeenCalledTimes(2)
})

it('refreshes a committed game change immediately but reuses games for stat-only changes', async () => {
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await tick()
    boundary.games.mockResolvedValue(day('Final'))
    await act(async () => { changes.notifyLeagueChange('league', { topic: 'game', scopes: [{ season_id: 'season', date: '2026-10-18' }] }) })
    await tick()
    expect(latest.todaysGames[0].status).toBe('Final')
    expect(boundary.games).toHaveBeenCalledTimes(2)
    await act(async () => { changes.notifyLeagueChange('league', { topic: 'stat', scopes: null }) })
    await tick()
    expect(boundary.games).toHaveBeenCalledTimes(2)
    expect(boundary.stats).toHaveBeenCalledTimes(3)
})

it('keeps a post-change game read separate from an older held response', async () => {
    let release!: (value: ReturnType<typeof day>) => void
    const held = new Promise<ReturnType<typeof day>>(resolve => { release = resolve })
    boundary.games.mockReturnValueOnce(held).mockResolvedValue(day('Final'))
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { changes.notifyLeagueChange('league', { topic: 'game', scopes: null }) })
    await tick()
    await act(async () => { release(day()); await held })
    await tick()
    expect(boundary.games).toHaveBeenCalledTimes(2)
    expect(latest.todaysGames[0].status).toBe('Final')
})

it('does not reuse successful game data after a session cache clear', async () => {
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await tick()
    await act(async () => { sessions.clearSessionCaches(); renderer!.unmount(); renderer = null })
    boundary.games.mockResolvedValue(day('Final'))
    await act(async () => { renderer = create(React.createElement(Probe, { scope: 'new-session' })) })
    await tick()
    expect(boundary.games).toHaveBeenCalledTimes(2)
    expect(latest.todaysGames[0].status).toBe('Final')
})
