import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'
import type { RealtimePostgresUpdatePayload } from '@supabase/supabase-js'
import { useMatchupData } from '@/hooks/use-matchup-data'
import type { TableChangeWatch } from '@/lib/realtime-config'

const mocks = vi.hoisted(() => ({ getMyMatchup: vi.fn(), subscriptions: [] as { watches: TableChangeWatch[] }[] }))
vi.mock('@react-navigation/native', () => ({ useFocusEffect: vi.fn() }))
vi.mock('@/lib/scoring', () => ({ getMyMatchup: mocks.getMyMatchup, getLeagueWeekMatchups: async () => [] }))
vi.mock('@/lib/lineup', () => ({
    clampDateToWeek: () => '2026-07-09', getWeekDays: async () => [],
    getWeeklyLineup: async () => ({ starters: [], bench: [], ir: [], taxi: [] }), invalidateCachedRoster: vi.fn(),
}))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-07-09' }))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache: vi.fn() }))
vi.mock('@/lib/shared/week', () => ({ invalidateWeekNumberCache: vi.fn() }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: vi.fn(), writePersistentCache: vi.fn() }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/lib/realtime', () => ({
    debounceRealtimeRefresh: () => ({ trigger: vi.fn(), cancel: vi.fn() }),
    disposeTableChangeSubscription: async () => {}, reportRealtimeCleanup: vi.fn(),
    subscribeToTableChanges: (_name: string, subscription: { watches: TableChangeWatch[] }) => {
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
    mocks.subscriptions.length = 0
    mocks.getMyMatchup.mockImplementation(async (member: string) => ({
        id: `match-${member.slice(-1)}`, weekNumber: 1, myMemberId: member, opponentMemberId: 'opponent',
        myPoints: 200, opponentPoints: 200, seasonId: `season-${member}`, seasonYear: 2026, isFinalized: false,
    }))
})
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
