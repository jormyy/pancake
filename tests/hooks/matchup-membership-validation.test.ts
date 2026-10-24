import { clearSessionCaches } from '@/lib/session-cache-registry'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMatchupData } from '@/hooks/use-matchup-data'
import { resolveHomeSurface } from '@/lib/home-surface'
import type { Matchup } from '@/lib/scoring'

const mocks = vi.hoisted(() => ({ getMyMatchup: vi.fn(), getWeekDays: vi.fn(), readPersistentCache: vi.fn(), writePersistentCache: vi.fn() }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true, useFocusEffect: vi.fn() }))
vi.mock('@/lib/scoring', () => ({ getMyMatchup: mocks.getMyMatchup, getLeagueWeekMatchups: vi.fn(async () => []) }))
vi.mock('@/lib/lineup', () => ({ clampDateToWeek: (date: string) => date, getWeekDays: mocks.getWeekDays, getWeeklyLineup: vi.fn(async () => ({ starters: [], bench: [], ir: [], taxi: [] })) }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-14' }))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache: vi.fn() }))
vi.mock('@/lib/shared/week', () => ({ getSeasonWeekDates: async () => [], invalidateWeekNumberCache: vi.fn() }))
vi.mock('@/lib/persistent-cache', () => mocks)
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/lib/realtime', () => ({ debounceRealtimeRefresh: () => ({ trigger: vi.fn(), cancel: vi.fn() }), disposeTableChangeSubscription: vi.fn(), reportRealtimeCleanup: vi.fn(), subscribeToTableChanges: vi.fn(() => ({})) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'))
    clearSessionCaches()
    vi.clearAllMocks()
    mocks.readPersistentCache.mockReturnValue(undefined)
    mocks.getMyMatchup.mockResolvedValue(null)
    mocks.getWeekDays.mockResolvedValue([])
})

afterEach(() => vi.useRealTimers())

const current = { id: 'member' }
const user = { id: 'user' }
const league = { id: 'league' }
const matchup: Matchup = {
    id: 'matchup', weekNumber: 1, myPoints: 0, opponentPoints: 0,
    myTeamName: 'Mine', opponentTeamName: 'Theirs', myUsername: 'me', opponentUsername: 'them',
    myWins: 0, myLosses: 0, opponentWins: 0, opponentLosses: 0, isFinalized: false,
    iWon: null, myMemberId: 'member', opponentMemberId: 'opponent', seasonId: 'season', seasonYear: 2026,
}
const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}
const surface = (data: ReturnType<typeof useMatchupData>) => resolveHomeSurface({
    leagueStatus: 'active', hasMatchup: Boolean(data.matchup), emptyConfirmed: data.emptyConfirmed,
    loading: data.matchupLoading, error: data.error,
})

describe('matchup membership validation', () => {
    it('reads in parallel and confirms the fresh null only when the same membership validates', async () => {
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = ({ validated }: { validated: boolean }) => {
            latest = useMatchupData(current, user, league, validated)
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { validated: false })) })
        await act(async () => { await latest.refresh() })
        expect(mocks.getMyMatchup).toHaveBeenCalledOnce()
        expect(mocks.writePersistentCache).not.toHaveBeenCalled()
        expect(latest.emptyConfirmed).toBe(false)
        expect(surface(latest)).toBe('loading')
        await act(async () => { renderer.update(React.createElement(Probe, { validated: true })) })
        expect(mocks.getMyMatchup).toHaveBeenCalledOnce()
        expect(latest.emptyConfirmed).toBe(true)
        expect(mocks.writePersistentCache).toHaveBeenCalledWith('pancake:home-matchup:v1:league:member', expect.objectContaining({ matchup: null }))
        await act(async () => { renderer.unmount() })
    })

    it('renders a positive answer before membership validation and week metadata finish', async () => {
        const days = deferred<[]>()
        mocks.getMyMatchup.mockResolvedValue(matchup)
        mocks.getWeekDays.mockReturnValue(days.promise)
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = () => { latest = useMatchupData(current, user, league, false); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        let request!: Promise<void>
        await act(async () => { request = latest.refresh(); await Promise.resolve() })
        expect(latest.matchup).toEqual(matchup)
        expect(surface(latest)).toBe('matchup')
        await act(async () => { days.resolve([]); await request; renderer.unmount() })
    })

    it('shows the error card when the parallel matchup read fails before membership validation', async () => {
        mocks.getMyMatchup.mockRejectedValue(new Error('offline'))
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = () => { latest = useMatchupData(current, user, league, false); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { await latest.refresh() })
        expect(surface(latest)).toBe('error')
        expect(latest.emptyConfirmed).toBe(false)
        await act(async () => { renderer.unmount() })
        consoleError.mockRestore()
    })

    it.each(['before', 'after'])('shows the error card when membership validation fails %s a null answer', async (order) => {
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = ({ error }: { error: Error | null }) => {
            latest = useMatchupData(current, user, league, false, error)
            return null
        }
        let renderer!: ReactTestRenderer
        const failure = new Error('offline')
        await act(async () => { renderer = create(React.createElement(Probe, { error: order === 'before' ? failure : null })) })
        await act(async () => { await latest.refresh() })
        await act(async () => { renderer.update(React.createElement(Probe, { error: failure })) })
        expect(surface(latest)).toBe('error')
        expect(mocks.writePersistentCache).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })

    it('retries a failed membership check before reading the matchup and recovers', async () => {
        const check = deferred<void>()
        const refreshMemberships = vi.fn(() => check.promise)
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = ({ validated, error }: { validated: boolean; error: Error | null }) => {
            latest = useMatchupData(current, user, league, validated, error, refreshMemberships)
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { validated: false, error: new Error('offline') })) })
        let request!: Promise<void>
        await act(async () => { request = latest.refresh(); await Promise.resolve() })
        expect(refreshMemberships).toHaveBeenCalledOnce()
        expect(mocks.getMyMatchup).not.toHaveBeenCalled()
        await act(async () => { renderer.update(React.createElement(Probe, { validated: true, error: null })) })
        mocks.getMyMatchup.mockResolvedValue(matchup)
        await act(async () => { check.resolve(); await request })
        expect(surface(latest)).toBe('matchup')
        expect(latest.error).toBeNull()
        await act(async () => { renderer.unmount() })
    })

    it('keeps confirmed empty visible throughout a pending refresh', async () => {
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = () => { latest = useMatchupData(current, user, league); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { await latest.refresh() })
        expect(surface(latest)).toBe('empty')
        const read = deferred<Matchup | null>()
        mocks.getMyMatchup.mockReturnValue(read.promise)
        let request!: Promise<void>
        await act(async () => { request = latest.refresh(); await Promise.resolve() })
        expect(surface(latest)).toBe('empty')
        await act(async () => { read.resolve(null); await request })
        expect(surface(latest)).toBe('empty')
        await act(async () => { renderer.unmount() })
    })

    it('does not let a retry for the former membership cancel the newly selected matchup read', async () => {
        const check = deferred<void>()
        const read = deferred<Matchup | null>()
        let latest!: ReturnType<typeof useMatchupData>
        const refreshMemberships = () => check.promise
        const Probe = ({ member, validated, error }: { member: { id: string }; validated: boolean; error: Error | null }) => {
            latest = useMatchupData(member, user, league, validated, error, refreshMemberships)
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { member: current, validated: false, error: new Error('offline') })) })
        let oldRequest!: Promise<void>
        await act(async () => { oldRequest = latest.refresh(); await Promise.resolve() })
        const nextMember = { id: 'next-member' }
        await act(async () => { renderer.update(React.createElement(Probe, { member: nextMember, validated: true, error: null })) })
        mocks.getMyMatchup.mockReturnValue(read.promise)
        let nextRequest!: Promise<void>
        await act(async () => { nextRequest = latest.refresh(); await Promise.resolve() })
        await act(async () => { check.resolve(); await oldRequest })
        expect(mocks.getMyMatchup).toHaveBeenCalledOnce()
        await act(async () => { read.resolve({ ...matchup, myMemberId: nextMember.id }); await nextRequest })
        expect(latest.matchup?.myMemberId).toBe(nextMember.id)
        await act(async () => { renderer.unmount() })
    })

    it('does not treat a same-day null cache as a fresh server confirmation', async () => {
        mocks.readPersistentCache.mockReturnValue({ today: '2026-10-14', matchup: null })
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = () => { latest = useMatchupData({ id: 'member' }, { id: 'user' }, { id: 'league' }, true); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(latest.emptyConfirmed).toBe(false)
        await act(async () => { await latest.refresh() })
        expect(latest.emptyConfirmed).toBe(true)
        await act(async () => { renderer.unmount() })
    })

    it('shows a positive cached matchup before membership validation', async () => {
        mocks.readPersistentCache.mockReturnValue({ today: '2026-10-14', matchup: { id: 'cached' } })
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = () => { latest = useMatchupData({ id: 'member' }, { id: 'user' }, { id: 'league' }, false); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(latest.matchup?.id).toBe('cached')
        expect(latest.matchupLoading).toBe(false)
        await act(async () => { renderer.unmount() })
    })
})
