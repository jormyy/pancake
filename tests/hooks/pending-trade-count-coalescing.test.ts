import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePendingTradeCount } from '@/hooks/use-pending-trade-count'
import { clearPersistentCaches } from '@/lib/persistent-cache'
import { sessionOwner, setSessionOwner } from '@/lib/session-cache-registry'

type Owner = 'a' | 'b' | null
type CountArgs = { p_member_id: string; p_league_id: string }
type CountResponse = { data: number | null; error: Error | null }
type Subscription = { watches: { table: string; filter?: string }[]; onChange: () => void }
const boundary = vi.hoisted(() => ({
    owner: 'a' as Owner, path: '/', counts: { a: 3, b: 7 }, rpc: vi.fn(), from: vi.fn(),
    subscriptions: [] as Subscription[], unsubscribe: vi.fn(), delay: 50, failures: 0,
    active: 0, maxActive: 0, events: { trades: 0, trade_participants: 0 },
}))
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))
vi.mock('expo-router', () => ({ usePathname: () => boundary.path }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: boundary.owner ? { id: `user-${boundary.owner}` } : null }) }))
vi.mock('@/contexts/league-context', () => ({
    useLeagueContext: () => ({
        current: boundary.owner ? { id: `member-${boundary.owner}` } : null,
        currentLeague: boundary.owner ? { id: `league-${boundary.owner}` } : null,
    }),
}))
// Keep the real getPendingIncomingTradeCount body: this boundary counts its actual RPCs.
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: boundary.rpc, from: boundary.from } }))
vi.mock('@/lib/realtime', () => ({
    subscribeToTableChanges: (_name: string, subscription: Subscription) => {
        boundary.subscriptions.push(subscription)
        return {}
    },
    unsubscribeFromTableChanges: boundary.unsubscribe, reportRealtimeCleanup: vi.fn(),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let renderer: ReactTestRenderer | null
let browser: EventTarget
let latest: number
let snapshots: { at: number; owner: Owner; count: number }[]
const Probe = ({ owner, path }: { owner: Owner; path: string }) => {
    const userId = owner ? `user-${owner}` : null
    if (sessionOwner() !== userId) { clearPersistentCaches(); setSessionOwner(userId) }
    boundary.owner = owner
    boundary.path = path
    latest = usePendingTradeCount()
    snapshots.push({ at: Date.now(), owner, count: latest })
    return null
}
const tree = (owner: Owner = boundary.owner, path = boundary.path) => React.createElement(Probe, { owner, path })
const advance = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 5) {
        await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(5, ms - elapsed)) })
    }
}
const mount = async () => {
    await act(async () => { renderer = create(tree()) })
    await advance(100)
    boundary.rpc.mockClear()
    boundary.maxActive = 0
    snapshots = []
}
const event = async (table: 'trades' | 'trade_participants' = 'trades') => {
    const subscription = boundary.subscriptions.at(-1)!
    expect(subscription.watches).toContainEqual({ table, filter: `league_id=eq.league-${boundary.owner}` })
    boundary.events[table] += 1
    await act(async () => { subscription.onChange() })
}
const burst = async (spaced: boolean) => {
    for (let index = 0; index < 20; index++) {
        if (spaced) boundary.counts.a = index + 4
        await event('trades')
        await event('trade_participants')
        if (spaced) await advance(5)
    }
}
const waitForRead = async () => {
    for (let elapsed = 0; elapsed < 350 && boundary.rpc.mock.calls.length === 0; elapsed += 5) await advance(5)
    expect(boundary.rpc.mock.calls.length).toBeGreaterThan(0)
}
const report = (workload: string, signalAt: number, count: number, owner: Owner = 'a', maximumLatency?: number) => {
    const visibleAt = snapshots.find((snapshot) => snapshot.at >= signalAt && snapshot.owner === owner && snapshot.count === count)?.at
    const measured = {
        workload, countRpcs: boundary.rpc.mock.calls.length, maxConcurrent: boundary.maxActive,
        latencyMs: maximumLatency ?? (visibleAt == null ? null : visibleAt - signalAt), badgeRenders: snapshots.length,
    }
    console.info(`TRADE_BADGE_MEASUREMENT ${JSON.stringify(measured)}`)
    return measured
}

beforeEach(() => {
    setSessionOwner('user-a')
    clearPersistentCaches()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    boundary.owner = 'a'
    boundary.path = '/'
    boundary.counts = { a: 3, b: 7 }
    boundary.subscriptions = []
    boundary.delay = 50
    boundary.failures = 0
    boundary.active = 0
    boundary.maxActive = 0
    boundary.events = { trades: 0, trade_participants: 0 }
    boundary.unsubscribe.mockReset().mockResolvedValue(undefined)
    boundary.from.mockReset().mockImplementation(() => { throw new Error('Badge must use the count RPC, not a trade page') })
    boundary.rpc.mockReset().mockImplementation((name: string, args: CountArgs) => {
        expect(name).toBe('get_pending_trade_count')
        const owner = args.p_member_id === 'member-a' ? 'a' : 'b'
        expect(args.p_league_id).toBe(`league-${owner}`)
        const count = boundary.counts[owner]
        const delay = boundary.delay
        const fail = boundary.failures > 0
        if (fail) boundary.failures -= 1
        boundary.delay = 50
        boundary.active += 1
        boundary.maxActive = Math.max(boundary.maxActive, boundary.active)
        return new Promise<CountResponse>((resolve) => {
            setTimeout(() => {
                boundary.active -= 1
                resolve({ data: fail ? null : count, error: fail ? new Error('network') : null })
            }, delay)
        })
    })
    renderer = null
    latest = -1
    snapshots = []
    browser = new EventTarget()
    vi.stubGlobal('window', browser)
})
afterEach(async () => {
    await act(async () => { renderer?.unmount() })
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

it('merges 20 trade and 20 participant events within 100 ms into one count RPC', async () => {
    await mount()
    const signalAt = Date.now()
    await burst(true)
    await advance(500)
    const measured = report('20-trades+20-participants/100ms', signalAt, 23)
    expect(latest).toBe(23)
    expect(boundary.events).toEqual({ trades: 20, trade_participants: 20 })
    expect(measured.countRpcs).toBe(1)
    expect(measured.maxConcurrent).toBe(1)
    expect(measured.latencyMs).toBeLessThanOrEqual(300)
})

it('queues one follow-up for a burst during a held 500 ms count read', async () => {
    await mount()
    boundary.counts.a = 10
    boundary.delay = 500
    await event()
    await waitForRead()
    await advance(100)
    boundary.counts.a = 12
    const signalAt = Date.now()
    await burst(false)
    await advance(600)
    const measured = report('40-events/during-500ms-read', signalAt, 12)
    expect(latest).toBe(12)
    expect(measured.countRpcs).toBe(2)
    expect(measured.maxConcurrent).toBe(1)
    expect(measured.latencyMs).toBe(450)
})

it('merges route change and focus during a held count read into one follow-up', async () => {
    await mount()
    boundary.delay = 500
    await event()
    await waitForRead()
    await advance(100)
    boundary.counts.a = 0
    const signalAt = Date.now()
    await act(async () => { renderer!.update(tree('a', '/trades')); browser.dispatchEvent(new Event('focus')) })
    await advance(600)
    const measured = report('route+focus/during-500ms-read', signalAt, 0)
    expect(latest).toBe(0)
    expect(measured.countRpcs).toBe(2)
    expect(measured.maxConcurrent).toBe(1)
    expect(measured.latencyMs).toBe(450)
})

it('keeps route and focus catch-up when there is no pending read', async () => {
    await mount()
    boundary.counts.a = 0
    const signalAt = Date.now()
    await act(async () => { renderer!.update(tree('a', '/trades')); browser.dispatchEvent(new Event('focus')) })
    await advance(500)
    const measured = report('route+focus/idle', signalAt, 0)
    expect(latest).toBe(0)
    expect(measured.countRpcs).toBe(1)
    expect(measured.latencyMs).toBeLessThanOrEqual(300)
})

it('shows all 73 incoming offers from the authoritative RPC, without reading a page', async () => {
    const offers = Array.from({ length: 73 }, (_, index) => ({ id: `offer-${index}`, recipient: 'member-a' }))
    boundary.counts.a = offers.length
    const signalAt = Date.now()
    await act(async () => { renderer = create(tree()) })
    await advance(100)
    const measured = report('73-incoming-offers/startup', signalAt, 73)
    expect(latest).toBe(73)
    expect(boundary.from).not.toHaveBeenCalled()
    expect(boundary.rpc).toHaveBeenCalledExactlyOnceWith('get_pending_trade_count', {
        p_member_id: 'member-a', p_league_id: 'league-a',
    })
    expect(measured.latencyMs).toBe(50)
})

it('keeps the last count after failure and retries after the existing two-second delay', async () => {
    await mount()
    boundary.failures = 1
    boundary.counts.a = 47
    const signalAt = Date.now()
    await event()
    await advance(500)
    expect(latest).toBe(3)
    expect(boundary.rpc).toHaveBeenCalledTimes(1)
    await advance(2000)
    const measured = report('failed-read/automatic-retry', signalAt, 47)
    expect(latest).toBe(47)
    expect(measured.countRpcs).toBe(2)
    expect(measured.maxConcurrent).toBe(1)
    expect(measured.latencyMs).toBeLessThanOrEqual(2350)
})

it('limits retries to two, then lets a new focus signal recover the count', async () => {
    await mount()
    boundary.failures = 3
    await event()
    await advance(10000)
    expect(latest).toBe(3)
    expect(boundary.rpc).toHaveBeenCalledTimes(3)
    boundary.counts.a = 9
    await act(async () => { browser.dispatchEvent(new Event('focus')) })
    await advance(500)
    expect(latest).toBe(9)
    expect(boundary.rpc).toHaveBeenCalledTimes(4)
})

it('fences old callbacks and held results across account switch and sign-out', async () => {
    await mount()
    const oldCallback = boundary.subscriptions.at(-1)!.onChange
    boundary.delay = 500
    await event()
    await waitForRead()
    await advance(50)
    boundary.delay = 500
    const switchedAt = Date.now()
    await act(async () => { renderer!.update(tree('b')) })
    const firstOtherOwner = snapshots.find((snapshot) => snapshot.owner === 'b')!
    await advance(50)
    await act(async () => { oldCallback(); oldCallback() })
    await advance(600)
    const otherCount = latest
    const otherVisibleAt = snapshots.find((snapshot) => snapshot.owner === 'b' && snapshot.count === 7)?.at
    const currentCallback = boundary.subscriptions.at(-1)!.onChange
    boundary.delay = 500
    const previousCalls = boundary.rpc.mock.calls.length
    await event()
    for (let elapsed = 0; elapsed < 350 && boundary.rpc.mock.calls.length === previousCalls; elapsed += 5) await advance(5)
    await advance(50)
    await act(async () => { renderer!.update(tree(null)); currentCallback() })
    await advance(600)
    const measured = report('account-switch/sign-out-pending', switchedAt, 7, 'b')
    expect(firstOtherOwner.count).toBe(0)
    expect(otherCount).toBe(7)
    expect(otherVisibleAt! - switchedAt).toBe(500)
    expect(latest).toBe(0)
    expect(measured.countRpcs).toBe(3)
})

it('never postpones the window under events every 100 ms for five seconds', async () => {
    await mount()
    const signalAt = Date.now()
    const signals: { at: number; count: number }[] = []
    for (let index = 0; index < 50; index++) {
        boundary.counts.a = index + 4
        signals.push({ at: Date.now(), count: boundary.counts.a })
        await event()
        await event('trade_participants')
        await advance(100)
    }
    await advance(500)
    const maxLatency = Math.max(...signals.map((signal) => {
        const visible = snapshots.find((snapshot) => snapshot.owner === 'a' && snapshot.at >= signal.at && snapshot.count >= signal.count)
        return visible ? visible.at - signal.at : Infinity
    }))
    const measured = report('continuous-100-events/5s', signalAt + 4900, 53, 'a', maxLatency)
    expect(latest).toBe(53)
    expect(measured.countRpcs).toBeLessThanOrEqual(20)
    expect(measured.maxConcurrent).toBe(1)
    expect(measured.latencyMs).toBeLessThanOrEqual(300)
})

it('cancels a queued window, removes focus, and rejects callbacks after unmount', async () => {
    await mount()
    const callback = boundary.subscriptions.at(-1)!.onChange
    await event()
    await act(async () => { renderer!.unmount(); renderer = null })
    await act(async () => { callback(); browser.dispatchEvent(new Event('focus')) })
    await advance(1000)
    expect(boundary.rpc).not.toHaveBeenCalled()
    expect(boundary.unsubscribe).toHaveBeenCalledTimes(1)
})

it('clears retry timers on owner change and unmount', async () => {
    await mount()
    boundary.failures = 1
    await event()
    await advance(500)
    await act(async () => { renderer!.update(tree('b')) })
    await advance(100)
    const calls = boundary.rpc.mock.calls.length
    await advance(7000)
    expect(boundary.rpc).toHaveBeenCalledTimes(calls)
    boundary.failures = 1
    await event()
    await advance(500)
    await act(async () => { renderer!.unmount(); renderer = null })
    const afterUnmount = boundary.rpc.mock.calls.length
    await advance(7000)
    expect(boundary.rpc).toHaveBeenCalledTimes(afterUnmount)
})

it('handles React effect replay and a callback arriving during promise settlement', async () => {
    await act(async () => { renderer = create(React.createElement(React.StrictMode, null, tree())) })
    await advance(500)
    expect(latest).toBe(3)
    await act(async () => { renderer!.unmount(); renderer = null })
    boundary.subscriptions = []
    await mount()
    let release!: (response: CountResponse) => void
    const response = new Promise<CountResponse>((resolve) => { release = resolve })
    boundary.rpc.mockReturnValueOnce(response)
    await event()
    await waitForRead()
    boundary.counts.a = 17
    const callback = boundary.subscriptions.at(-1)!.onChange
    void response.then(() => { queueMicrotask(callback) })
    await act(async () => { release({ data: 3, error: null }) })
    await advance(500)
    expect(latest).toBe(17)
    expect(boundary.rpc).toHaveBeenCalledTimes(2)
})
