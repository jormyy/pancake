import { clearSessionCaches } from '@/lib/session-cache-registry'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RealtimePostgresUpdatePayload } from '@supabase/supabase-js'
import { useMatchupData } from '@/hooks/use-matchup-data'
import { notifyLeagueChange } from '@/lib/league-changes'
import type { TableChangeWatch } from '@/lib/realtime-config'

type Subscription = { watches: TableChangeWatch[]; onReconnect?: () => Promise<void> }
const mocks = vi.hoisted(() => ({ getMyMatchup: vi.fn(), getWeeklyLineup: vi.fn(), invalidate: vi.fn(), subscriptions: [] as Subscription[] }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true, useFocusEffect: vi.fn() }))
vi.mock('@/lib/scoring', () => ({ getMyMatchup: mocks.getMyMatchup, getLeagueWeekMatchups: async () => [] }))
vi.mock('@/lib/lineup', () => ({
    clampDateToWeek: () => '2026-07-09', getWeekDays: async () => [],
    getWeeklyLineup: mocks.getWeeklyLineup, invalidateCachedRoster: mocks.invalidate,
}))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-07-09' }))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache: vi.fn() }))
vi.mock('@/lib/shared/week', () => ({ getSeasonWeekDates: async () => [], invalidateWeekNumberCache: vi.fn() }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: vi.fn(), writePersistentCache: vi.fn() }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/lib/realtime', () => ({
    debounceRealtimeRefresh: (refresh: () => void) => ({ trigger: refresh, cancel: vi.fn() }),
    disposeTableChangeSubscription: async () => {}, reportRealtimeCleanup: vi.fn(),
    subscribeToTableChanges: (_name: string, subscription: Subscription) => {
        mocks.subscriptions.push(subscription)
        return {}
    },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const identity = (id: string) => ({ member: { id: `member-${id}` }, user: { id: `user-${id}` }, league: { id: `league-${id}` } })
const owners = { a: identity('a'), b: identity('b') }
let latest: ReturnType<typeof useMatchupData>
const Probe = ({ owner }: { owner: keyof typeof owners }) => {
    const { member, user, league } = owners[owner]
    latest = useMatchupData(member, user, league)
    return null
}
type MatchupEventRow = {
    id: string
    week_number: number
    home_member_id: string
    home_points: number
    away_points: number
    is_finalized: boolean
    winner_member_id: string | null
}
const event = (id: string, points: number, second = 1): RealtimePostgresUpdatePayload<MatchupEventRow> => ({
    eventType: 'UPDATE', schema: 'public', table: 'matchups', errors: [],
    commit_timestamp: `2026-07-09T12:00:${String(second).padStart(2, '0')}Z`, old: {},
    new: { id: `match-${id}`, week_number: 1, home_member_id: `member-${id}`, home_points: points,
        away_points: 12, is_finalized: false, winner_member_id: null },
})
beforeEach(() => {
    clearSessionCaches()
    vi.clearAllMocks(); vi.useFakeTimers()
    mocks.subscriptions.length = 0
    mocks.getWeeklyLineup.mockResolvedValue({ starters: [], bench: [], ir: [], taxi: [], benchSlots: 3 })
    mocks.getMyMatchup.mockImplementation(async (member: string) => ({
        id: `match-${member.slice(-1)}`, weekNumber: 1, myMemberId: member, opponentMemberId: 'opponent',
        myPoints: 200, opponentPoints: 200, seasonId: `season-${member}`, seasonYear: 2026, isFinalized: false,
    }))
})
afterEach(() => vi.useRealTimers())
const mount = async () => {
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe, { owner: 'a' })) })
    await act(async () => { await latest.refresh() })
    return renderer
}

it('rejects retained callbacks after an owner and league switch (200 must not become 12)', async () => {
    const renderer = await mount()
    const old = mocks.subscriptions.at(-1)!.watches[0].onChange
    await act(async () => { renderer.update(React.createElement(Probe, { owner: 'b' })) })
    await act(async () => { await latest.refresh() })
    await act(async () => { old(event('a', 11)) })
    expect(latest.matchup?.id).toBe('match-b')
    expect(latest.matchup?.myPoints).toBe(200)
    await act(async () => { renderer.unmount() })
})

it('rejects an old subscription after the same owner changes matchup', async () => {
    const renderer = await mount()
    const old = mocks.subscriptions.at(-1)!.watches[0].onChange
    mocks.getMyMatchup.mockResolvedValue({ ...latest.matchup, id: 'replacement', myPoints: 200 })
    await act(async () => { await latest.refresh() })
    await act(async () => { old(event('a', 11)) })
    expect(latest.matchup?.id).toBe('replacement')
    expect(latest.matchup?.myPoints).toBe(200)
    await act(async () => { renderer.unmount() })
})

it('catches up missed scores and lineups, including a downward correction, without accepting a former owner', async () => {
    const renderer = await mount()
    const reconnect = mocks.subscriptions.at(-1)!.onReconnect!
    mocks.getMyMatchup.mockResolvedValue({ ...latest.matchup, myPoints: 100 })
    mocks.getWeeklyLineup.mockResolvedValue({ starters: [], bench: [{ playerId: 'incoming' }], ir: [], taxi: [], benchSlots: 3 })
    await act(async () => { await reconnect() })
    expect(latest.matchup?.myPoints).toBe(100)
    expect(latest.myLineup?.bench[0].playerId).toBe('incoming')
    expect(mocks.invalidate.mock.calls).toEqual([
        ['member-a', 'league-a', 'season-member-a'], ['opponent', 'league-a', 'season-member-a'],
    ])
    await act(async () => { renderer.update(React.createElement(Probe, { owner: 'b' })) })
    mocks.getMyMatchup.mockClear()
    await act(async () => { await reconnect() })
    expect(mocks.getMyMatchup).not.toHaveBeenCalled()
    await act(async () => { renderer.unmount() })
})

it('converges after duplicate and reversed deliveries, including a downward score correction', async () => {
    const renderer = await mount()
    const callback = mocks.subscriptions.at(-1)!.watches[0].onChange
    await act(async () => { callback(event('a', 300, 2)); callback(event('a', 300, 2)); callback(event('a', 250, 1)) })
    expect(latest.matchup?.myPoints).toBe(300)
    await act(async () => { callback(event('a', 100, 3)); callback(event('other', 999, 4)) })
    expect(latest.matchup?.myPoints).toBe(100)
    await act(async () => { renderer.unmount() })
    await act(async () => { callback(event('a', 999, 5)) })
    expect(latest.matchup?.myPoints).toBe(100)
})


it('reconciles a compact deletion hint and invalidates both visible rosters', async () => {
    const player = { playerId: 'removed', rosterPlayerId: 'roster-removed', displayName: 'Removed',
        position: 'PG', eligiblePositions: ['PG'], nbaTeam: null, injuryStatus: null, nbaId: null }
    mocks.getWeeklyLineup.mockResolvedValue({ starters: [], bench: [player], ir: [], taxi: [], benchSlots: 3 })
    const renderer = await mount()
    expect(latest.myLineup?.bench[0].playerId).toBe('removed')
    mocks.getWeeklyLineup.mockResolvedValue({ starters: [], bench: [], ir: [], taxi: [], benchSlots: 3 })
    await act(async () => {
        notifyLeagueChange('league-a', { topic: 'lineup', scopes: [{ season_id: 'season-member-a', member_id: 'member-a', date: '2026-07-09' }] })
        await vi.advanceTimersByTimeAsync(200)
    })
    expect(latest.myLineup?.bench).toEqual([])
    expect(mocks.invalidate.mock.calls).toEqual([
        ['member-a', 'league-a', 'season-member-a'], ['opponent', 'league-a', 'season-member-a'],
    ])
    await act(async () => { renderer.unmount() })
})

it('ignores another team and stops observing a former owner league', async () => {
    const renderer = await mount()
    mocks.getWeeklyLineup.mockClear()
    await act(async () => {
        notifyLeagueChange('league-a', { topic: 'lineup', scopes: [{ season_id: 'season-member-a', member_id: 'unrelated', date: '2026-07-09' }] })
        await vi.advanceTimersByTimeAsync(200)
    })
    expect(mocks.getWeeklyLineup).not.toHaveBeenCalled()
    await act(async () => { renderer.update(React.createElement(Probe, { owner: 'b' })) })
    await act(async () => { await latest.refresh() })
    mocks.getWeeklyLineup.mockClear()
    await act(async () => {
        notifyLeagueChange('league-a', { topic: 'catchup', scopes: null })
        await vi.advanceTimersByTimeAsync(200)
    })
    expect(mocks.getWeeklyLineup).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
    await act(async () => { renderer.unmount() })
})

it('shares a successful post-join initial read, but rereads after a later stream catch-up', async () => {
    const changes = await import('@/lib/league-changes')
    changes.setLeagueChangesConnected('league-a', true)
    const renderer = await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(mocks.getWeeklyLineup).toHaveBeenCalledTimes(2)
    await act(async () => {
        changes.notifyLeagueChange('league-a', { topic: 'catchup', scopes: null })
        await vi.advanceTimersByTimeAsync(200)
    })
    expect(mocks.getWeeklyLineup).toHaveBeenCalledTimes(4)
    await act(async () => { renderer.unmount() })
    changes.setLeagueChangesConnected('league-a', false)
})
