import { notifyLeagueChange } from '@/lib/league-changes'
import { clearSessionCaches } from '@/lib/session-cache-registry'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMatchupData } from '@/hooks/use-matchup-data'
import { useLineupActions } from '@/hooks/use-lineup-actions'
import type { Matchup } from '@/lib/scoring'
import type { LineupSlot } from '@/lib/lineup'

const {
    getLeagueWeekMatchups, getMyMatchup, getWeekDays, getWeeklyLineup, readPersistentCache,
    invalidateSeasonCache, invalidateWeekNumberCache, online, write, clock, cacheWrite,
} = vi.hoisted(() => ({
    getLeagueWeekMatchups: vi.fn(),
    getMyMatchup: vi.fn(),
    getWeekDays: vi.fn(),
    getWeeklyLineup: vi.fn(),
    readPersistentCache: vi.fn(),
    invalidateSeasonCache: vi.fn(),
    invalidateWeekNumberCache: vi.fn(),
    online: { value: true },
    clock: { today: '2026-07-09' },
    cacheWrite: vi.fn(),
    write: vi.fn(),
}))

vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true, useFocusEffect: vi.fn() }))
vi.mock('@/lib/scoring', () => ({ getLeagueWeekMatchups, getMyMatchup }))
vi.mock('@/lib/lineup', async () => ({
    planLineupMove: (await import('@/lib/lineup/movePlan')).planLineupMove,
    setPlayerSlotMoves: write, autoSetLineup: vi.fn(),
    clampDateToWeek: (date: string, days: { date: string }[]) => days.some(day => day.date === date) ? date : days[0]?.date ?? '2026-07-09',
    getWeekDays,
    getWeeklyLineup,
}))
vi.mock('@/lib/roster', () => ({ activateRosterPlayerWithLineup: vi.fn(), toggleIR: vi.fn() }))
vi.mock('@/lib/alert', () => ({ showAlert: vi.fn(), showSuccess: vi.fn(), confirmAction: vi.fn() }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => clock.today }))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache }))
vi.mock('@/lib/shared/week', () => ({ getSeasonWeekDates: async () => [], invalidateWeekNumberCache }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache, writePersistentCache: cacheWrite }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => online.value }))
vi.mock('@/lib/realtime', () => ({
    debounceRealtimeRefresh: () => ({ trigger: vi.fn(), cancel: vi.fn() }),
    disposeTableChangeSubscription: vi.fn(),
    reportRealtimeCleanup: vi.fn(),
    subscribeToTableChanges: vi.fn(() => ({})),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

const matchup: Matchup = {
    id: 'matchup', weekNumber: 1, myPoints: 0, opponentPoints: 0,
    myTeamName: 'Mine', opponentTeamName: 'Theirs', myUsername: 'me', opponentUsername: 'them',
    myWins: 0, myLosses: 0, opponentWins: 0, opponentLosses: 0, isFinalized: false,
    iWon: null, myMemberId: 'member-a', opponentMemberId: 'member-b', seasonId: 'season', seasonYear: 2026,
}
const lineup = (id: string) => ({
    starters: [] as LineupSlot[], bench: [{
        rosterPlayerId: `roster-${id}`, playerId: id, displayName: id, position: 'PG',
        eligiblePositions: ['PG'], nbaTeam: 'LAL', injuryStatus: null, nbaId: null,
    }], benchSlots: 1, ir: [], taxi: [],
})

beforeEach(() => {
    clearSessionCaches()
    vi.clearAllMocks()
    readPersistentCache.mockReturnValue(undefined)
    getLeagueWeekMatchups.mockResolvedValue([])
    getWeekDays.mockResolvedValue([{ date: '2026-07-09' }])
    online.value = true
    clock.today = '2026-07-09'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-09T12:00:00Z'))
})

afterEach(() => vi.useRealTimers())

describe('useMatchupData date ownership', () => {
    it.each([undefined, -1, 0.5])('refreshes an old saved lineup with unknown bench capacity %s', async (benchSlots) => {
        readPersistentCache.mockReturnValue({
            today: '2026-07-09', selectedDate: '2026-07-09', matchup, weekDays: [], leagueMatchups: [],
            myLineup: { ...lineup('old-mine'), benchSlots }, oppLineup: lineup('old-opponent'),
        })
        getMyMatchup.mockResolvedValue(matchup)
        getWeeklyLineup.mockResolvedValue({ ...lineup('fresh'), benchSlots: 3 })
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = () => { latest = useMatchupData({ id: 'member-a' }, { id: 'user' }, { id: 'league' }); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(latest.myLineup).toBeNull()
        expect(latest.matchupLoading).toBe(true)
        await act(async () => { await latest.refresh() })
        expect(latest.myLineup?.benchSlots).toBe(3)
        expect(latest.error).toBeNull()
        await act(async () => { renderer.unmount() })
    })

    it('retains a saved lineup with a known zero bench capacity', async () => {
        const empty = { starters: [], bench: [], benchSlots: 0, ir: [], taxi: [] }
        readPersistentCache.mockReturnValue({ today: '2026-07-09', matchup, myLineup: empty, oppLineup: empty })
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = () => { latest = useMatchupData({ id: 'member-a' }, { id: 'user' }, { id: 'league' }); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(latest.myLineup?.benchSlots).toBe(0)
        expect(latest.matchupLoading).toBe(false)
        await act(async () => { renderer.unmount() })
    })

    it('retains a cached matchup when a refresh fails', async () => {
        readPersistentCache.mockReturnValue({
            today: '2026-07-09', selectedDate: '2026-07-09', matchup, weekDays: [], leagueMatchups: [],
            myLineup: lineup('cached-mine'), oppLineup: lineup('cached-opp'),
        })
        getMyMatchup.mockRejectedValue(new Error('offline'))
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = () => {
            latest = useMatchupData({ id: 'member-a' }, { id: 'user' }, { id: 'league' })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })

        await act(async () => { await latest.refresh() })

        expect(latest.matchup?.id).toBe('matchup')
        expect(latest.myLineup?.bench[0]?.playerId).toBe('cached-mine')
        expect(latest.error).toBe('Failed to load matchup')
        await act(async () => { renderer.unmount() })
    })

    it('reloads cached matchup data after the network reconnects', async () => {
        readPersistentCache.mockReturnValue({
            today: '2026-07-09', selectedDate: '2026-07-09', matchup, weekDays: [], leagueMatchups: [],
            myLineup: lineup('cached-mine'), oppLineup: lineup('cached-opp'),
        })
        getMyMatchup.mockResolvedValue({ ...matchup, myPoints: 77.7, opponentPoints: 66.6 })
        getWeeklyLineup.mockResolvedValue(lineup('fresh'))
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = ({ tick }: { tick: number }) => {
            latest = useMatchupData({ id: 'member-a' }, { id: 'user' }, { id: 'league' })
            return React.createElement('probe', { tick })
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { tick: 0 })) })

        online.value = false
        await act(async () => { renderer.update(React.createElement(Probe, { tick: 1 })) })
        online.value = true
        await act(async () => {
            renderer.update(React.createElement(Probe, { tick: 2 }))
            await Promise.resolve()
        })

        expect(getMyMatchup).toHaveBeenCalledTimes(1)
        expect(invalidateSeasonCache).toHaveBeenCalledWith('league')
        expect(invalidateWeekNumberCache).toHaveBeenCalledTimes(1)
        expect(latest.matchup?.myPoints).toBe(77.7)
        expect(latest.matchup?.opponentPoints).toBe(66.6)
        await act(async () => { renderer.unmount() })
    })

    it('does not let an old action reload cancel or overwrite the selected day', async () => {
        readPersistentCache.mockReturnValue({
            today: '2026-07-09', selectedDate: '2026-07-09', matchup, weekDays: [], leagueMatchups: [],
            myLineup: lineup('old-mine'), oppLineup: lineup('old-opp'),
        })
        const mine = deferred<ReturnType<typeof lineup>>()
        const opponent = deferred<ReturnType<typeof lineup>>()
        getWeeklyLineup.mockImplementation((memberId: string, _leagueId: string, _seasonId: string, _week: number, date: string) => {
            expect(date).toBe('2026-07-10')
            return memberId === 'member-a' ? mine.promise : opponent.promise
        })
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = () => {
            latest = useMatchupData({ id: 'member-a' }, { id: 'user' }, { id: 'league' })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        let currentLoad!: Promise<unknown>
        await act(async () => {
            latest.setSelectedDate('2026-07-10')
            currentLoad = latest.loadLineups(matchup, '2026-07-10')
            await latest.loadMyLineup(matchup, '2026-07-09')
        })
        expect(getWeeklyLineup).toHaveBeenCalledTimes(2)
        await act(async () => {
            mine.resolve(lineup('new-mine'))
            opponent.resolve(lineup('new-opp'))
            await currentLoad
        })

        expect(latest.selectedDate).toBe('2026-07-10')
        expect(latest.myLineup?.bench[0]?.playerId).toBe('new-mine')
        expect(latest.oppLineup?.bench[0]?.playerId).toBe('new-opp')
        await act(async () => { renderer.unmount() })
    })

    it('never shows the previous day under a newly picked day whose lineup failed to load', async () => {
        readPersistentCache.mockReturnValue({
            today: '2026-07-09', selectedDate: '2026-07-09', matchup, weekDays: [], leagueMatchups: [],
            myLineup: lineup('day-09-mine'), oppLineup: lineup('day-09-opp'),
        })
        getWeeklyLineup.mockRejectedValue(new Error('network'))
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = () => {
            latest = useMatchupData({ id: 'member-a' }, { id: 'user' }, { id: 'league' })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => {
            latest.setSelectedDate('2026-07-10')
            await latest.loadLineups(matchup, '2026-07-10')
        })

        expect(latest.selectedDate).toBe('2026-07-10')
        expect(latest.myLineup).toBeNull()
        expect(latest.oppLineup).toBeNull()
        expect(latest.lineupError).toBe(true)

        getWeeklyLineup.mockResolvedValue(lineup('day-10'))
        await act(async () => { await latest.loadLineups(matchup, '2026-07-10') })
        expect(latest.myLineup?.bench[0]?.playerId).toBe('day-10')
        expect(latest.lineupError).toBe(false)
        await act(async () => { renderer.unmount() })
    })

    it('invalidates an in-flight matchup read when the resource identity becomes empty', async () => {
        const pending = deferred<Matchup | null>()
        getMyMatchup.mockReturnValue(pending.promise)
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = ({ active }: { active: boolean }) => {
            latest = useMatchupData(
                active ? { id: 'member-a' } : null,
                active ? { id: 'user' } : null,
                active ? { id: 'league' } : null,
            )
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { active: true })) })
        let request!: Promise<void>
        await act(async () => { request = latest.refresh(); await Promise.resolve() })
        await act(async () => { renderer.update(React.createElement(Probe, { active: false })) })
        await act(async () => { pending.resolve(matchup); await request })

        expect(latest.matchup).toBeUndefined()
        expect(getWeekDays).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })

    it('hides cached matchup state on the first render for a new owner key', async () => {
        readPersistentCache.mockImplementation((key: string) => key.includes('league-a') ? {
            today: '2026-07-09', selectedDate: '2026-07-09', matchup, weekDays: [], leagueMatchups: [],
            myLineup: lineup('old-mine'), oppLineup: lineup('old-opp'),
        } : undefined)
        const snapshots: { requested: string; matchupId?: string; mine?: string; loading: boolean; refId?: string }[] = []
        const Probe = ({ memberId, leagueId }: { memberId: string; leagueId: string }) => {
            const value = useMatchupData({ id: memberId }, { id: `user-${leagueId}` }, { id: leagueId })
            snapshots.push({
                requested: leagueId,
                matchupId: value.matchup?.id,
                mine: value.myLineup?.bench[0]?.playerId,
                loading: value.matchupLoading,
                refId: value.matchupRef.current?.id,
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { memberId: 'member-a', leagueId: 'league-a' })) })
        await act(async () => {
            renderer.update(React.createElement(Probe, { memberId: 'member-b', leagueId: 'league-b' }))
        })

        expect(snapshots.find((snapshot) => snapshot.requested === 'league-b')).toEqual({
            requested: 'league-b',
            matchupId: undefined,
            mine: undefined,
            loading: true,
            refId: undefined,
        })
        await act(async () => { renderer.unmount() })
    })
})

it('hides old-day players and blocks a move until the selected day arrives', async () => {
    const oldLineup = { ...lineup('old-player'), starters: [{ slotType: 'PG', player: null }] }
    readPersistentCache.mockReturnValue({ today: '2026-07-09', selectedDate: '2026-07-09', matchup,
        weekDays: [], leagueMatchups: [], myLineup: oldLineup, oppLineup: oldLineup })
    const read = deferred<ReturnType<typeof lineup>>()
    getWeeklyLineup.mockReturnValue(read.promise)
    let latest!: ReturnType<typeof useMatchupData>
    let actions!: ReturnType<typeof useLineupActions>
    const Probe = () => {
        latest = useMatchupData({ id: 'member-a' }, { id: 'user' }, { id: 'league' })
        actions = useLineupActions({
            actionContext: { memberId: 'member-a', leagueId: 'league', seasonId: 'season', weekNumber: 1, seasonYear: 2026 },
            myLineup: latest.myLineup, selectedDate: latest.selectedDate, league: { roster_size: 20 },
            startedTeams: new Set(), reloadLineup: async () => {},
        })
        return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    let pending!: Promise<unknown>
    try {
        await act(async () => { latest.setSelectedDate('2026-07-10'); pending = latest.loadLineups(matchup, '2026-07-10') })
        const visibleWhilePending = latest.myLineup
        await act(async () => { await actions.handleTap({ kind: 'bench', index: 0 }) })
        await act(async () => { await actions.handleTap({ kind: 'starter', index: 0 }) })
        const writesWhilePending = write.mock.calls.length
        await act(async () => { read.resolve({ ...lineup('new-player'), starters: [{ slotType: 'PG', player: null }] }); await pending })
        expect(writesWhilePending).toBe(0)
        expect(visibleWhilePending).toBeNull()
        expect(latest.myLineup?.bench[0]?.playerId).toBe('new-player')
        await act(async () => { await actions.handleTap({ kind: 'bench', index: 0 }) })
        await act(async () => { await actions.handleTap({ kind: 'starter', index: 0 }) })
        expect(write).toHaveBeenCalledWith(expect.objectContaining({ gameDate: '2026-07-10' }), [{ playerId: 'new-player', slotType: 'PG' }])
    } finally { await act(async () => { renderer.unmount() }) }
})

it.each(['resolve', 'reject'] as const)('keeps the chosen day when the old refresh read finishes with %s', async (outcome) => {
    readPersistentCache.mockReturnValue({ today: '2026-07-09', selectedDate: '2026-07-09', matchup,
        weekDays: [], leagueMatchups: [], myLineup: lineup('old'), oppLineup: lineup('old') })
    getMyMatchup.mockResolvedValue(matchup)
    getWeekDays.mockResolvedValue([{ date: '2026-07-09' }, { date: '2026-07-10' }])
    const read = deferred<ReturnType<typeof lineup>>()
    getWeeklyLineup.mockImplementation((_member, _league, _season, _week, date) => date === '2026-07-09' ? read.promise : Promise.resolve(lineup('chosen-day')))
    let latest!: ReturnType<typeof useMatchupData>
    const Probe = () => { latest = useMatchupData({ id: 'member-a' }, { id: 'user' }, { id: 'league' }); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    let pending!: Promise<void>
    await act(async () => { pending = latest.refresh() })
    await act(async () => { latest.setSelectedDate('2026-07-10'); await latest.loadLineups(matchup, '2026-07-10') })
    await act(async () => {
        if (outcome === 'resolve') read.resolve(lineup('refresh-old-day'))
        else read.reject(new Error('Old day read failed'))
        await pending
    })
    expect(latest.selectedDate).toBe('2026-07-10')
    expect(latest.myLineup?.bench[0]?.playerId).toBe('chosen-day')
    expect(latest.error).toBeNull()
    await act(async () => { renderer.unmount() })
})


it('starts the lineup read while the matchup names and records are still pending', async () => {
    const pending = deferred<Matchup>()
    getMyMatchup.mockImplementationOnce((_member, _league, onContext) => {
        onContext(matchup)
        return pending.promise
    })
    getWeeklyLineup.mockResolvedValue(lineup('prepared'))
    let latest!: ReturnType<typeof useMatchupData>
    const Probe = () => { latest = useMatchupData({ id: 'member-a' }, { id: 'user' }, { id: 'league' }); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    let refresh!: Promise<void>
    await act(async () => { refresh = latest.refresh() })
    expect(getWeeklyLineup).toHaveBeenCalledTimes(2)
    expect(latest.matchup).toBeUndefined()
    await act(async () => { pending.resolve(matchup); await refresh })
    expect(latest.myLineup?.bench[0].playerId).toBe('prepared')
    expect(getWeeklyLineup).toHaveBeenCalledTimes(2)
    await act(async () => { renderer.unmount() })
})

it.each(['refresh', 'silent', 'focus', 'visibility', 'online'] as const)('rolls a retained Home selection to the new ET day on %s', async (trigger) => {
    const browser = new EventTarget()
    const page = new EventTarget()
    vi.stubGlobal('window', browser)
    vi.stubGlobal('document', page)
    readPersistentCache.mockReturnValue({ today: clock.today, selectedDate: '2026-07-10', matchup,
        weekDays: [], leagueMatchups: [], myLineup: lineup('old'), oppLineup: lineup('old') })
    getMyMatchup.mockResolvedValue(matchup)
    getWeekDays.mockResolvedValue([{ date: '2026-07-09' }, { date: '2026-07-10' }, { date: '2026-07-11' }])
    getWeeklyLineup.mockImplementation((_member, _league, _season, _week, date) => Promise.resolve(lineup(date)))
    let latest!: ReturnType<typeof useMatchupData>
    const Probe = () => { latest = useMatchupData({ id: 'member-a' }, { id: 'user' }, { id: 'league' }); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    try {
        if (trigger === 'online') {
            online.value = false
            await act(async () => { renderer.update(React.createElement(Probe)) })
        }
        clock.today = '2026-07-11'
        vi.setSystemTime(new Date('2026-07-11T12:00:00Z'))
        await act(async () => {
            if (trigger === 'refresh') await latest.refresh()
            else if (trigger === 'silent') await latest.refreshSilently()
            else if (trigger === 'online') { online.value = true; renderer.update(React.createElement(Probe)) }
            else (trigger === 'focus' ? browser : page).dispatchEvent(new Event(trigger === 'focus' ? 'focus' : 'visibilitychange'))
        })
        expect(latest.selectedDate).toBe('2026-07-11')
        expect(latest.myLineup?.bench[0].playerId).toBe('2026-07-11')
        expect(cacheWrite).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ today: '2026-07-11', selectedDate: '2026-07-11' }))
    } finally {
        await act(async () => { renderer.unmount() })
        vi.unstubAllGlobals()
    }
})

it('rolls Home over at ET midnight without a browser event and repeats the next night', async () => {
    vi.setSystemTime(new Date('2026-07-10T03:59:59.900Z'))
    getMyMatchup.mockResolvedValue(matchup)
    getWeekDays.mockResolvedValue([{ date: '2026-07-09' }, { date: '2026-07-10' }, { date: '2026-07-11' }])
    getWeeklyLineup.mockImplementation((_member, _league, _season, _week, date) => Promise.resolve(lineup(date)))
    let latest!: ReturnType<typeof useMatchupData>
    const Probe = () => { latest = useMatchupData({ id: 'member-a' }, { id: 'user' }, { id: 'league' }); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    try {
        await act(async () => { await latest.refresh() })
        clock.today = '2026-07-10'
        await act(async () => { await vi.advanceTimersByTimeAsync(101) })
        expect(latest.selectedDate).toBe('2026-07-10')
        expect(latest.myLineup?.bench[0].playerId).toBe('2026-07-10')
        clock.today = '2026-07-11'
        await act(async () => { await vi.advanceTimersByTimeAsync(86_400_000) })
        expect(latest.selectedDate).toBe('2026-07-11')
    } finally { await act(async () => { renderer.unmount() }) }
})

it('rereads today when an old-day read crosses midnight before saving the cache', async () => {
    getMyMatchup.mockResolvedValue(matchup)
    getWeekDays.mockResolvedValue([{ date: '2026-07-09' }, { date: '2026-07-10' }])
    const oldRead = deferred<ReturnType<typeof lineup>>()
    getWeeklyLineup.mockImplementation((_member, _league, _season, _week, date) => date === '2026-07-09' ? oldRead.promise : Promise.resolve(lineup(date)))
    let latest!: ReturnType<typeof useMatchupData>
    const Probe = () => { latest = useMatchupData({ id: 'member-a' }, { id: 'user' }, { id: 'league' }); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    try {
        let pending!: Promise<void>
        await act(async () => { pending = latest.refresh() })
        clock.today = '2026-07-10'
        await act(async () => { oldRead.resolve(lineup('yesterday')); await pending })
        expect(latest.selectedDate).toBe('2026-07-10')
        expect(latest.myLineup?.bench[0].playerId).toBe('2026-07-10')
        expect(cacheWrite).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ today: '2026-07-10', selectedDate: '2026-07-10' }))
    } finally { await act(async () => { renderer.unmount() }) }
})

it('keeps refresh authority stable when user and member objects have the same IDs', async () => {
    let latest!: ReturnType<typeof useMatchupData>
    const Probe = () => { latest = useMatchupData({ id: 'member-a' }, { id: 'user' }, { id: 'league' }); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    try {
        const refresh = latest.refresh
        await act(async () => { renderer.update(React.createElement(Probe)) })
        expect(latest.refresh).toBe(refresh)
    } finally { await act(async () => { renderer.unmount() }) }
})

it('rolls over when a change hint names the new day instead of the old selection', async () => {
    readPersistentCache.mockReturnValue({ today: clock.today, selectedDate: clock.today, matchup,
        weekDays: [], leagueMatchups: [], myLineup: lineup('yesterday'), oppLineup: lineup('yesterday') })
    getMyMatchup.mockResolvedValue(matchup)
    getWeekDays.mockResolvedValue([{ date: '2026-07-09' }, { date: '2026-07-10' }])
    getWeeklyLineup.mockImplementation((_member, _league, _season, _week, date) => Promise.resolve(lineup(date)))
    let latest!: ReturnType<typeof useMatchupData>
    const Probe = () => { latest = useMatchupData({ id: 'member-a' }, { id: 'user' }, { id: 'league' }); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    try {
        clock.today = '2026-07-10'
        await act(async () => {
            notifyLeagueChange('league', { topic: 'lineup', scopes: [{ season_id: 'season', member_id: 'member-a', date: clock.today }] })
            await vi.advanceTimersByTimeAsync(200)
        })
        expect(latest.selectedDate).toBe('2026-07-10')
        expect(latest.myLineup?.bench[0].playerId).toBe('2026-07-10')
    } finally { await act(async () => { renderer.unmount() }) }
})

it('never stamps the previous week as today when a matchup read crosses midnight', async () => {
    getMyMatchup.mockResolvedValueOnce(matchup).mockResolvedValue({ ...matchup, id: 'next-matchup', weekNumber: 2 })
    getWeekDays.mockImplementation((week: number) => Promise.resolve([{ date: week === 1 ? '2026-07-09' : '2026-07-10' }]))
    const oldRead = deferred<ReturnType<typeof lineup>>()
    getWeeklyLineup.mockImplementation((_member, _league, _season, _week, date) => date === '2026-07-09' ? oldRead.promise : Promise.resolve(lineup(date)))
    let latest!: ReturnType<typeof useMatchupData>
    const Probe = () => { latest = useMatchupData({ id: 'member-a' }, { id: 'user' }, { id: 'league' }); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    try {
        let pending!: Promise<void>
        await act(async () => { pending = latest.refresh() })
        clock.today = '2026-07-10'
        await act(async () => { oldRead.resolve(lineup('yesterday')); await pending })
        expect(cacheWrite.mock.calls.every(([, value]) => value.today !== '2026-07-10' || value.selectedDate === '2026-07-10')).toBe(true)
        expect(latest.matchup?.id).toBe('next-matchup')
        expect(latest.selectedDate).toBe('2026-07-10')
    } finally { await act(async () => { renderer.unmount() }) }
})
