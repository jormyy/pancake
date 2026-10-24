import { clearSessionCaches } from '@/lib/session-cache-registry'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMatchupData } from '@/hooks/use-matchup-data'
import type { Matchup } from '@/lib/scoring'

const mocks = vi.hoisted(() => ({ lineup: vi.fn(), cache: vi.fn(), matchup: vi.fn(), days: vi.fn(), online: true }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true, useFocusEffect: vi.fn() }))
vi.mock('@/lib/scoring', () => ({ getMyMatchup: mocks.matchup, getLeagueWeekMatchups: vi.fn() }))
vi.mock('@/lib/lineup', () => ({
    getWeeklyLineup: mocks.lineup, getWeekDays: mocks.days, clampDateToWeek: (date: string) => date, invalidateCachedRoster: vi.fn(),
}))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-16' }))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache: vi.fn() }))
vi.mock('@/lib/shared/week', () => ({ getSeasonWeekDates: async () => [], invalidateWeekNumberCache: vi.fn() }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: mocks.cache, writePersistentCache: vi.fn() }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => mocks.online }))
vi.mock('@/lib/realtime', () => ({
    debounceRealtimeRefresh: () => ({ trigger: vi.fn(), cancel: vi.fn() }),
    subscribeToTableChanges: vi.fn(), disposeTableChangeSubscription: vi.fn(), reportRealtimeCleanup: vi.fn(),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const match = (owner: string): Matchup => ({
    id: `match-${owner}`, weekNumber: 1, seasonId: 'season', seasonYear: 2027,
    myMemberId: `member-${owner}`, opponentMemberId: 'opponent', myTeamName: owner, opponentTeamName: 'Opponent',
    myUsername: owner, opponentUsername: 'opponent', myWins: 0, myLosses: 0, opponentWins: 0, opponentLosses: 0,
    myPoints: 0, opponentPoints: 0, isFinalized: false, iWon: null,
})
const lineup = (name: string) => ({
    starters: [], bench: [{ playerId: name, rosterPlayerId: name, displayName: name, position: 'PG',
        eligiblePositions: ['PG'], nbaTeam: 'BOS', injuryStatus: null, nbaId: null }],
    benchSlots: 1, ir: [], taxi: [],
})
const caches = Object.fromEntries(['a', 'b'].map((owner) => [owner, {
    today: '2026-10-16', selectedDate: '2026-10-19', matchup: match(owner), weekDays: [], leagueMatchups: [],
    myLineup: lineup(owner), oppLineup: lineup('opponent'),
}]))
let latest: ReturnType<typeof useMatchupData>
let renderer: ReactTestRenderer
const Probe = ({ owner }: { owner: string }) => {
    latest = useMatchupData({ id: `member-${owner}` }, { id: `user-${owner}` }, { id: `league-${owner}` })
    return null
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-16T12:00:00Z'))
    clearSessionCaches()
    vi.clearAllMocks()
    mocks.online = true
    mocks.cache.mockImplementation((key: string) => caches[key.endsWith('member-b') ? 'b' : 'a'])
    mocks.lineup.mockResolvedValue(lineup('fresh'))
    mocks.matchup.mockResolvedValue(match('a'))
    mocks.days.mockResolvedValue([])
})
afterEach(async () => { if (renderer) await act(async () => { renderer.unmount() }); vi.restoreAllMocks(); vi.useRealTimers() })

it('handles a failed background read, keeps the last lineup, and clears the retry state on recovery', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => { renderer = create(React.createElement(Probe, { owner: 'a' })) })
    log.mockClear()
    const previous = latest.myLineup
    mocks.lineup.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await act(async () => { await expect(latest.refreshSilently()).resolves.toBe(false) })
    expect(latest.myLineup).toBe(previous)
    expect(latest.lineupError).toBe(true)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ message: 'Failed to fetch' }))
    await act(async () => { await expect(latest.refreshSilently()).resolves.toBe(true) })
    expect(latest.myLineup?.bench[0].playerId).toBe('fresh')
    expect(latest.lineupError).toBe(false)
})

it('consumes an old owner failure without altering the current owner or reporting their lineup as failed', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let reject!: (error: Error) => void
    const pending = new Promise<ReturnType<typeof lineup>>((_resolve, fail) => { reject = fail })
    await act(async () => { renderer = create(React.createElement(Probe, { owner: 'a' })) })
    log.mockClear()
    mocks.lineup.mockReturnValueOnce(pending)
    let request!: Promise<boolean>
    await act(async () => { request = latest.refreshSilently() })
    await act(async () => { renderer.update(React.createElement(Probe, { owner: 'b' })) })
    await act(async () => {
        reject(new TypeError('Old request aborted'))
        await expect(request).resolves.toBe(false)
    })
    expect(latest.myLineup?.bench[0].playerId).toBe('b')
    expect(latest.lineupError).toBe(false)
    expect(log).not.toHaveBeenCalled()
})

it('shows a retry after an offline day selection and clears it after a successful read', async () => {
    await act(async () => { renderer = create(React.createElement(Probe, { owner: 'a' })) })
    mocks.online = false
    await act(async () => renderer.update(React.createElement(Probe, { owner: 'a' })))
    await act(async () => {
        latest.setSelectedDate('2026-10-20')
        await latest.loadLineups(latest.matchup!, '2026-10-20')
    })
    expect(latest.selectedDate).toBe('2026-10-20')
    expect(latest.myLineup).toBeNull()
    expect(latest.lineupLoading).toBe(false)
    expect(latest.lineupError).toBe(true)
    expect(mocks.lineup).not.toHaveBeenCalled()
    mocks.online = true
    await act(async () => renderer.update(React.createElement(Probe, { owner: 'a' })))
    await act(async () => { await latest.loadLineups(latest.matchup!, latest.selectedDate) })
    expect(latest.myLineup?.bench[0].playerId).toBe('fresh')
    expect(latest.lineupError).toBe(false)
})
