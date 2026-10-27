import { clearSessionCaches } from '@/lib/session-cache-registry'
import React, { useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LeagueProvider, useLeagueContext } from '@/contexts/league-context'
import { useMatchupData } from '@/hooks/use-matchup-data'
import type { LeagueMembership } from '@/types/app'

type Subscription = { watches: { table: string; filter?: string }[]; onChange?: () => void }
const boundary = vi.hoisted(() => ({
    owner: 'a' as string | null, online: true, visibility: 'visible',
    users: { a: { id: 'a' }, b: { id: 'b' } } as Record<string, { id: string }>,
    server: new Map<string, LeagueMembership[]>(), cache: new Map<string, unknown>(),
    subscriptions: [] as Subscription[], fetch: vi.fn(), matchup: vi.fn(),
    nextDelay: 50, failNext: false,
}))
vi.mock('@/hooks/use-matchup-data', () => ({ useMatchupData: () => ({}) }))
vi.mock('@/lib/cache/screen-cache', () => ({ clearScreenViews: () => {} }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: boundary.owner ? boundary.users[boundary.owner] : null }) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => boundary.online }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true, useFocusEffect: (callback: () => void) => useEffect(callback, [callback]) }))
vi.mock('@/lib/league', () => ({ fetchUserLeagues: boundary.fetch }))
vi.mock('@/lib/scoring', () => ({ getMyMatchup: boundary.matchup, getLeagueWeekMatchups: async () => [] }))
vi.mock('@/lib/lineup', () => ({
    getWeekDays: async () => [], getWeeklyLineup: async () => ({ starters: [], bench: [], ir: [], taxi: [] }),
    clampDateToWeek: () => '2026-10-13', invalidateCachedRoster: vi.fn(),
}))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-13' }))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache: vi.fn() }))
vi.mock('@/lib/shared/week', () => ({ getSeasonWeekDates: async () => [], invalidateWeekNumberCache: vi.fn() }))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: (key: string) => boundary.cache.get(key),
    writePersistentCache: (key: string, value: unknown) => { boundary.cache.set(key, value) },
    removePersistentCache: (key: string) => { boundary.cache.delete(key) },
}))
vi.mock('@/lib/realtime', () => ({
    subscribeToTableChanges: (_name: string, subscription: Subscription) => {
        boundary.subscriptions.push(subscription)
        return {}
    },
    unsubscribeFromTableChanges: async () => {}, reportRealtimeCleanup: vi.fn(),
    debounceRealtimeRefresh: () => ({ trigger: vi.fn(), cancel: vi.fn() }), disposeTableChangeSubscription: async () => {},
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rowsFor = (owner: string): LeagueMembership[] => [1, 2].map((index) => ({
    id: `${owner}-${index}`, team_name: `team-${owner}-${index}`, role: 'manager',
    leagues: {
        id: `league-${owner}-${index}`, name: `League ${index}`, status: 'active', invite_code: null,
        commissioner_id: owner, auction_budget: 200, scoring_settings: { pts: 1 }, playoff_start_week: 20,
        roster_size: 20, ir_slots: 2,
    },
}))
const membershipKey = (owner: string) => `pancake:league-memberships:v1:${owner}`
const selectionKey = (owner: string) => `pancake:selected-league:v1:${owner}`
type Snapshot = { at: number; current: string | null; name: string | null; role: string | null; rows: LeagueMembership[] }
let snapshots: Snapshot[]
let latest: ReturnType<typeof useLeagueContext>
let renderer: ReactTestRenderer | null
let browser: EventTarget
let page: EventTarget
let start: number
let pendingEvents: { at: number; name: string }[]
let latencies: number[]
const ContextProbe = React.memo(function ContextProbe() {
    latest = useLeagueContext()
    const snapshot = { at: Date.now(), current: latest.current?.id ?? null, name: latest.current?.team_name ?? null,
        role: latest.current?.role ?? null, rows: latest.memberships }
    snapshots.push(snapshot)
    const visible = pendingEvents.filter((event) => event.name === snapshot.name)
    if (visible.length) {
        // A newer row also satisfies earlier events in the same batch.
        const through = pendingEvents.lastIndexOf(visible.at(-1)!)
        latencies.push(...pendingEvents.splice(0, through + 1).map((event) => snapshot.at - event.at))
    }
    return null
})
const MatchupProbe = React.memo(function MatchupProbe() {
    const { current, currentLeague } = useLeagueContext()
    useMatchupData(current, boundary.owner ? boundary.users[boundary.owner] : null, currentLeague)
    return null
})
const children = React.createElement(React.Fragment, null, React.createElement(ContextProbe), React.createElement(MatchupProbe))
const tree = () => React.createElement(LeagueProvider, null, children)
const advance = async (ms: number) => {
    // Commit React after each timer boundary, rather than batching a five-second stream into one render.
    for (let elapsed = 0; elapsed < ms; elapsed += 5) {
        await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(5, ms - elapsed)) })
    }
}
const mount = async () => {
    await act(async () => { renderer = create(tree()) })
    await advance(100)
    boundary.fetch.mockClear()
    boundary.matchup.mockClear()
    snapshots = []
    start = Date.now()
}
const membershipSubscription = () => boundary.subscriptions.findLast(subscription => subscription.watches.some(watch => watch.table === 'league_members'))!
const ownEvent = async () => {
    const subscription = membershipSubscription()
    // One own-member UPDATE matches the user filter and its league's member filter.
    await act(async () => { subscription.onChange?.(); subscription.onChange?.() })
}
const changeTeam = (version: number) => {
    const name = `version-${version}`
    boundary.server.get('a')![1].team_name = name
    pendingEvents.push({ at: Date.now(), name })
}
const report = (workload: string, extra: Record<string, number | null> = {}) => {
    const result = {
        workload, membershipQueries: boundary.fetch.mock.calls.length, getMyMatchup: boundary.matchup.mock.calls.length,
        contextRenders: snapshots.length, maxLatencyMs: latencies.length ? Math.max(...latencies) : null,
        unsettledEvents: pendingEvents.length, elapsedMs: Date.now() - start, ...extra,
    }
    console.info(`MEMBERSHIP_MEASUREMENT ${JSON.stringify(result)}`)
    return result
}

beforeEach(() => {
    clearSessionCaches()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'))
    boundary.owner = 'a'
    boundary.online = true
    boundary.visibility = 'visible'
    boundary.subscriptions = []
    boundary.server = new Map([['a', rowsFor('a')], ['b', rowsFor('b')]])
    boundary.cache = new Map<string, unknown>([[membershipKey('a'), structuredClone(rowsFor('a'))], [selectionKey('a'), 'a-2']])
    boundary.nextDelay = 50
    boundary.failNext = false
    snapshots = []
    pendingEvents = []
    latencies = []
    renderer = null
    browser = new EventTarget()
    page = new EventTarget()
    Object.defineProperty(page, 'visibilityState', { get: () => boundary.visibility })
    vi.stubGlobal('window', browser)
    vi.stubGlobal('document', page)
    vi.stubGlobal('navigator', { get onLine() { return boundary.online } })
    boundary.fetch.mockReset().mockImplementation((owner: string) => {
        const rows = structuredClone(boundary.server.get(owner) ?? [])
        const delay = boundary.nextDelay
        const fail = boundary.failNext
        boundary.nextDelay = 50
        boundary.failNext = false
        return new Promise<LeagueMembership[]>((resolve, reject) => {
            setTimeout(() => fail ? reject(new Error('offline')) : resolve(rows), delay)
        })
    })
    boundary.matchup.mockReset().mockImplementation(() => new Promise<null>((resolve) => { setTimeout(() => resolve(null), 10) }))
})
afterEach(async () => {
    await act(async () => { renderer?.unmount() })
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

it('bounds a burst of 20 own-member events within 100 ms', async () => {
    await mount()
    for (let index = 0; index < 20; index++) {
        changeTeam(index)
        await ownEvent()
        await advance(5)
    }
    await advance(500)
    const measured = report('burst-20/100ms')
    expect(latest.current?.team_name).toBe('version-19')
    expect(measured.membershipQueries).toBe(1)
    expect(measured.maxLatencyMs).toBeLessThanOrEqual(300)
    expect(measured.unsettledEvents).toBe(0)
})

it('has a maximum wait under continuous events every 100 ms for five seconds', async () => {
    await mount()
    for (let index = 0; index < 50; index++) {
        changeTeam(index)
        await ownEvent()
        await advance(100)
    }
    await advance(500)
    const measured = report('continuous-50/5s')
    expect(latest.current?.team_name).toBe('version-49')
    expect(measured.membershipQueries).toBeLessThanOrEqual(20)
    expect(measured.maxLatencyMs).toBeLessThanOrEqual(350)
    expect(measured.unsettledEvents).toBe(0)
})

it('queues one follow-up for events during a held 500 ms read and awaits authoritative results', async () => {
    await mount()
    boundary.nextDelay = 500
    let settled = false
    let request!: Promise<void>
    await act(async () => { request = latest.refresh().then(() => { settled = true }) })
    await advance(100)
    changeTeam(1)
    await ownEvent()
    await advance(400)
    const settledBeforeTail = settled
    await advance(100)
    await request
    const measured = report('event-during-500ms-read')
    expect(latest.current?.team_name).toBe('version-1')
    expect(measured.membershipQueries).toBe(2)
    expect(settledBeforeTail).toBe(false)
    expect(settled).toBe(true)
    expect(measured.maxLatencyMs).toBe(450)
})

it('defers hidden updates and merges online, focus and visible catch-up signals', async () => {
    await mount()
    boundary.visibility = 'hidden'
    boundary.online = false
    await act(async () => { renderer!.update(tree()); page.dispatchEvent(new Event('visibilitychange')) })
    for (let index = 0; index < 20; index++) {
        changeTeam(index)
        await ownEvent()
        await advance(5)
    }
    await advance(500)
    const hiddenQueries = boundary.fetch.mock.calls.length
    pendingEvents = []
    latencies = []
    const resumedAt = Date.now()
    boundary.online = true
    boundary.visibility = 'visible'
    await act(async () => {
        renderer!.update(tree())
        browser.dispatchEvent(new Event('online'))
        browser.dispatchEvent(new Event('focus'))
        page.dispatchEvent(new Event('visibilitychange'))
    })
    await advance(500)
    const visibleAt = snapshots.find((snapshot) => snapshot.at >= resumedAt && snapshot.name === 'version-19')?.at
    const resumeLatencyMs = visibleAt == null ? null : visibleAt - resumedAt
    const measured = report('hidden-20/resume-3-signals', { hiddenQueries, resumeLatencyMs })
    expect(latest.current?.team_name).toBe('version-19')
    expect(hiddenQueries).toBe(0)
    expect(measured.membershipQueries).toBe(1)
    expect(resumeLatencyMs).toBeLessThanOrEqual(300)
})

it('reuses identical rows, then applies a role change, removal and confirmed empty result', async () => {
    await mount()
    const original = latest.memberships
    for (let index = 0; index < 20; index++) { await ownEvent(); await advance(500) }
    const identical = { queries: boundary.fetch.mock.calls.length, matchup: boundary.matchup.mock.calls.length, renders: snapshots.length }
    const retained = latest.memberships === original
    let changedAt = Date.now()
    boundary.server.get('a')![1].role = 'commissioner'
    await ownEvent()
    await advance(500)
    const roleLatency = snapshots.find((snapshot) => snapshot.at >= changedAt && snapshot.role === 'commissioner')!.at - changedAt
    expect(latest.isCommissioner).toBe(true)
    changedAt = Date.now()
    boundary.server.set('a', [boundary.server.get('a')![0]])
    await ownEvent()
    await advance(500)
    const removalLatency = snapshots.find((snapshot) => snapshot.at >= changedAt && snapshot.current === 'a-1')!.at - changedAt
    expect(latest.current?.id).toBe('a-1')
    expect(boundary.cache.get(selectionKey('a'))).toBe('a-1')
    changedAt = Date.now()
    boundary.server.set('a', [])
    await ownEvent()
    await advance(500)
    const emptyLatency = snapshots.find((snapshot) => snapshot.at >= changedAt && snapshot.rows.length === 0)!.at - changedAt
    report('identical-20/role/removal/empty', {
        identicalQueries: identical.queries, identicalMatchup: identical.matchup, identicalRenders: identical.renders,
        maxChangeLatencyMs: Math.max(roleLatency, removalLatency, emptyLatency),
    })
    expect(latest.current).toBeNull()
    expect(latest.membershipStatus).toBe('empty')
    expect(boundary.cache.has(membershipKey('a'))).toBe(false)
    expect(boundary.cache.has(selectionKey('a'))).toBe(false)
    expect(retained).toBe(true)
    expect(identical.matchup).toBe(0)
    expect(identical.renders).toBe(0)
})

it('fences account switch, sign-out and retained callbacks while reads are pending', async () => {
    await mount()
    const oldCallback = membershipSubscription().onChange!
    boundary.nextDelay = 500
    await act(async () => { void latest.refresh() })
    await advance(50)
    boundary.owner = 'b'
    boundary.cache.clear() // Auth owns cache clearing; the real-auth startup tests cover that boundary.
    boundary.nextDelay = 500
    const switchedAt = Date.now()
    await act(async () => { renderer!.update(tree()) })
    const firstOtherOwner = snapshots.at(-1)!
    await advance(50)
    await act(async () => { oldCallback(); oldCallback() })
    await advance(600)
    const newOwner = latest.current?.id
    const newOwnerAt = snapshots.find((snapshot) => snapshot.at >= switchedAt && snapshot.current === 'b-1')?.at
    expect(firstOtherOwner.rows.every((row) => !row.id.startsWith('a'))).toBe(true)
    const newCallback = membershipSubscription().onChange!
    boundary.nextDelay = 500
    await act(async () => { void latest.refresh() })
    await advance(50)
    boundary.owner = null
    boundary.cache.clear()
    await act(async () => { renderer!.update(tree()); newCallback() })
    await advance(600)
    report('account-switch/sign-out-pending', { ownerVisibleLatencyMs: newOwnerAt == null ? null : newOwnerAt - switchedAt })
    expect(newOwner).toBe('b-1')
    expect(latest.memberships).toEqual([])
    expect(latest.current).toBeNull()
    expect(boundary.cache.size).toBe(0)
})

it('keeps cached rows and selection on a failed read, then retries successfully', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
        await mount()
        boundary.failNext = true
        await act(async () => { membershipSubscription().onChange!() })
        await advance(500)
        const afterFailure = { id: latest.current?.id, error: latest.membershipError?.message, selection: boundary.cache.get(selectionKey('a')) }
        changeTeam(1)
        await ownEvent()
        await advance(500)
        const measured = report('failed-read/retry')
        expect(afterFailure).toEqual({ id: 'a-2', error: 'offline', selection: 'a-2' })
        expect(latest.current?.team_name).toBe('version-1')
        expect(latest.membershipError).toBeNull()
        expect(measured.membershipQueries).toBe(2)
    } finally { log.mockRestore() }
})

it('cancels a queued timer and fences pending results on unmount', async () => {
    await mount()
    await ownEvent()
    await act(async () => { renderer!.unmount(); renderer = null })
    const afterUnmount = boundary.fetch.mock.calls.length
    await advance(1000)
    expect(boundary.fetch).toHaveBeenCalledTimes(afterUnmount)
    expect(boundary.cache.get(selectionKey('a'))).toBe('a-2')
})

it('restores after React replays effect setup and cleanup', async () => {
    await act(async () => { renderer = create(React.createElement(React.StrictMode, null, tree())) })
    await advance(500)
    expect(latest.current?.id).toBe('a-2')
    changeTeam(1)
    await ownEvent()
    await advance(500)
    expect(latest.current?.team_name).toBe('version-1')
})

it('fences a held read after unmount without writing it to the cache', async () => {
    await mount()
    changeTeam(1)
    boundary.nextDelay = 500
    await act(async () => { void latest.refresh() })
    await act(async () => { renderer!.unmount(); renderer = null })
    await advance(600)
    expect(boundary.cache.get(membershipKey('a'))).toEqual(rowsFor('a'))
})

it('ignores a disposed league subscription even when its owner is unchanged', async () => {
    await mount()
    const disposedCallback = membershipSubscription().onChange!
    boundary.server.set('a', [boundary.server.get('a')![0]])
    await ownEvent()
    await advance(500)
    const queries = boundary.fetch.mock.calls.length
    await act(async () => { disposedCallback() })
    await advance(500)
    expect(boundary.fetch).toHaveBeenCalledTimes(queries)
    expect(latest.current?.id).toBe('a-1')
})

it('keeps unchanged members while applying nested league settings and row order changes', async () => {
    await mount()
    const original = latest.memberships
    boundary.server.get('a')![1].leagues.scoring_settings = { pts: 2 }
    await ownEvent()
    await advance(500)
    const reusedOtherMember = latest.memberships[0] === original[0]
    expect(latest.currentLeague?.scoring_settings).toEqual({ pts: 2 })
    const changed = latest.memberships
    boundary.server.get('a')!.reverse()
    await ownEvent()
    await advance(500)
    expect(latest.memberships.map((row) => row.id)).toEqual(['a-2', 'a-1'])
    expect(latest.current?.id).toBe('a-2')
    expect(reusedOtherMember).toBe(true)
    expect(latest.memberships[0]).toBe(changed[1])
})

it('does not lose a callback that arrives as a read promise settles', async () => {
    await mount()
    let release!: (rows: LeagueMembership[]) => void
    const response = new Promise<LeagueMembership[]>((resolve) => { release = resolve })
    boundary.fetch.mockReturnValueOnce(response)
    await act(async () => { void latest.refresh() })
    const callback = membershipSubscription().onChange!
    changeTeam(1)
    void response.then(() => { queueMicrotask(callback) })
    await act(async () => { release(rowsFor('a')) })
    await advance(500)
    expect(latest.current?.team_name).toBe('version-1')
    expect(boundary.fetch).toHaveBeenCalledTimes(2)
})
