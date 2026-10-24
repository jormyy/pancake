import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const reads = vi.hoisted(() => ({ games: vi.fn(), stats: vi.fn() }))
vi.mock('@/lib/games', () => ({ getGameDay: reads.games, getLivePlayerStats: reads.stats }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-24' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer | undefined
beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-24T18:00:00Z'))
    reads.games.mockReset().mockResolvedValue({
        games: [{ status: 'InProgress', home_team: 'DEN', away_team: 'LAL' }, { status: 'Final', home_team: 'BOS', away_team: 'NYK' }],
        startedTeams: new Set(['DEN', 'LAL', 'BOS', 'NYK']), teamMatchups: new Map(),
    })
    reads.stats.mockReset().mockResolvedValue(new Map())
})
afterEach(async () => { await act(async () => screen?.unmount()); vi.useRealTimers() })

it('shares only a fresh slate from the current league, date, and session without another read', async () => {
    const { useLiveStats, readCachedLiveTeams } = await import('@/hooks/use-live-stats')
    const { setSessionOwner } = await import('@/lib/session-cache-registry')
    setSessionOwner('current-manager')
    const Probe = () => { useLiveStats('2026-10-24', { scope: 'matchup', leagueId: 'league', playerIds: [] }); return null }
    expect(readCachedLiveTeams('league')).toBeNull()
    await act(async () => { screen = create(React.createElement(Probe)) })
    expect(readCachedLiveTeams('league')).toEqual(new Set(['DEN', 'LAL']))
    expect(readCachedLiveTeams('another-league')).toBeNull()
    expect(reads.games).toHaveBeenCalledOnce()
    expect(reads.stats).not.toHaveBeenCalled()
    await act(async () => screen?.unmount())
    screen = undefined
    vi.setSystemTime(new Date('2026-10-24T18:02:00Z'))
    expect(readCachedLiveTeams('league')).toBeNull()
    vi.setSystemTime(new Date('2026-10-24T18:00:00Z'))
    setSessionOwner('another-manager')
    expect(readCachedLiveTeams('league')).toBeNull()
    expect(reads.games).toHaveBeenCalledOnce()
})
