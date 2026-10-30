import { afterEach, describe, expect, it, vi } from 'vitest'

const realtime = vi.hoisted(() => {
    const callbacks: { kind: string; config: Record<string, unknown>; callback: (payload: unknown) => void }[] = []
    const statuses = new Map<string, (status: 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR') => void>()
    let topic = ''
    let statusCallback: ((status: 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR') => void) | undefined
    const channel = {
        on: vi.fn((kind, config, callback) => {
            callbacks.push({ kind, config, callback })
            return channel
        }),
        subscribe: vi.fn((callback) => {
            statusCallback = callback
            statuses.set(topic, callback)
            return channel
        }),
    }
    return {
        callbacks,
        channel,
        channelFactory: vi.fn((name: string) => { topic = name; return channel }),
        removeChannel: vi.fn(async () => undefined),
        emitStatus: (status: 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR') => statusCallback?.(status),
        topicStatus: (topic: string, status: 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR') => statuses.get(topic)?.(status),
    }
})

vi.mock('@/lib/supabase', () => ({
    supabase: {
        channel: realtime.channelFactory,
        removeChannel: realtime.removeChannel,
    },
}))

import {
    debounceRealtimeRefresh,
    disposeTableChangeSubscription,
    reportRealtimeCleanup,
    subscribeToTableChanges as subscribe,
    unsubscribeFromTableChanges,
} from '@/lib/realtime'

const handles: ReturnType<typeof subscribe>[] = []
function subscribeToTableChanges(...args: Parameters<typeof subscribe>) {
    const handle = subscribe(...args)
    handles.push(handle)
    return handle
}

afterEach(async () => {
    await Promise.allSettled(handles.splice(0).map(unsubscribeFromTableChanges))
    await unsubscribeFromTableChanges(realtime.channel as never)
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    realtime.callbacks.length = 0
})

describe('database broadcast subscriptions', () => {
    it('dispatches every coalesced hint and still accepts the original envelope', () => {
        const receive = vi.fn()
        subscribeToTableChanges('hints', { mode: 'per-watch', watches: [
            { table: 'league_change_hints', filter: 'league_id=eq.league-1', onChange: receive },
        ] })
        const first = { schema: 'public', table: 'league_change_hints', eventType: 'UPDATE', new: { topic: 'score', league_id: 'league-1' }, old: {}, commit_timestamp: '', errors: [] }
        const second = { ...first, eventType: 'DELETE', new: {}, old: { topic: 'version', league_id: 'league-1' } }
        realtime.callbacks[0].callback({ payload: { hints: [{ event: 'UPDATE', row: { topic: 'score' } }, null, {}, { event: 'DELETE', row: { topic: 'version' } }] } })
        expect(receive.mock.calls.map(([payload]) => payload)).toEqual([first, second])
        realtime.callbacks[0].callback({ payload: first })
        expect(receive).toHaveBeenLastCalledWith(first)
    })

    it('preserves the source league when a hint moves to another scope', () => {
        const receive = vi.fn()
        subscribeToTableChanges('hints', { mode: 'per-watch', watches: [
            { table: 'league_change_hints', filter: 'league_id=eq.previous-league', onChange: receive },
        ] })
        realtime.callbacks[0].callback({ payload: { hints: [{ event: 'UPDATE', row: { league_id: 'next-league', topic: 'score' } }] } })
        expect(receive.mock.calls[0][0].new.league_id).toBe('next-league')
    })

    it('shares a league connection while dispatching table and event filters independently', async () => {
        const roster = vi.fn(), trades = vi.fn()
        const first = subscribeToTableChanges('players', { mode: 'per-watch', watches: [
            { table: 'roster_players', filter: 'league_id=eq.league-1', onChange: roster },
        ] })
        const second = subscribeToTableChanges('trades', { mode: 'per-watch', watches: [
            { table: 'trades', event: 'UPDATE', filter: 'league_id=eq.league-1', onChange: trades },
        ] })
        expect(first).not.toBe(second)
        expect(realtime.channelFactory).toHaveBeenCalledExactlyOnceWith('l1:league:league-1', { config: { private: true } })
        expect(realtime.callbacks[0].kind).toBe('broadcast')
        const payload = { schema: 'public', table: 'roster_players', eventType: 'INSERT', new: { member_id: 'member' }, old: {} }
        realtime.callbacks[0].callback({ payload })
        expect(roster).toHaveBeenCalledExactlyOnceWith(payload)
        expect(trades).not.toHaveBeenCalled()
        realtime.callbacks[0].callback({ payload: { ...payload, table: 'trades' } })
        expect(trades).not.toHaveBeenCalled()
        realtime.callbacks[0].callback({ payload: { ...payload, table: 'trades', eventType: 'UPDATE' } })
        expect(trades).toHaveBeenCalledOnce()
        await unsubscribeFromTableChanges(first)
        expect(realtime.removeChannel).not.toHaveBeenCalled()
        await unsubscribeFromTableChanges(first)
        expect(realtime.removeChannel).not.toHaveBeenCalled()
        realtime.callbacks[0].callback({ payload })
        expect(roster).toHaveBeenCalledOnce()
        await unsubscribeFromTableChanges(second)
        expect(realtime.removeChannel).toHaveBeenCalledOnce()
    })

    it('covers every legacy publication table with a scoped broadcast', () => {
        const tables = ['draft_budgets', 'draft_picks', 'drafts', 'league_change_hints', 'league_members', 'leagues',
            'matchup_forecasts', 'nominations', 'roster_players', 'snake_draft_picks', 'trade_block_items', 'trade_items',
            'trade_participants', 'trade_vetos', 'trades', 'waiver_claims']
        const handlers = new Map<string, ReturnType<typeof vi.fn>>()
        for (const table of tables) {
            const onChange = vi.fn()
            handlers.set(table, onChange)
            const column = table === 'leagues' ? 'id' : table === 'waiver_claims' ? 'member_id'
                : ['draft_budgets', 'nominations', 'snake_draft_picks'].includes(table) ? 'draft_id' : 'league_id'
            subscribeToTableChanges(table, { mode: 'fallback', watches: [{ table, filter: `${column}=eq.scope` }], onChange })
        }
        subscribeToTableChanges('draft', { mode: 'fallback', watches: [{ table: 'drafts', filter: 'id=eq.scope' }], onChange: vi.fn() })
        subscribeToTableChanges('membership', { mode: 'fallback', watches: [{ table: 'league_members', filter: 'user_id=eq.scope' }], onChange: vi.fn() })
        expect(realtime.callbacks.every(entry => entry.kind === 'broadcast')).toBe(true)
        expect(realtime.channelFactory.mock.calls.map(([topic]) => topic).sort()).toEqual(['l1:draft:scope', 'l1:league:scope', 'l1:member:scope', 'l1:user:scope'])
        for (const table of tables) {
            for (const eventType of ['INSERT', 'UPDATE', 'DELETE']) {
                for (const callback of realtime.callbacks) callback.callback({ payload: { schema: 'public', table, eventType, new: {}, old: {} } })
            }
            expect(handlers.get(table)).toHaveBeenCalledTimes(3)
        }
    })

    it('reports ready only when every scope has joined and recovers after a scope disconnects', async () => {
        const onStatus = vi.fn(), onReconnect = vi.fn()
        subscribeToTableChanges('membership', { mode: 'fallback', watches: [
            { table: 'league_members', filter: 'user_id=eq.user' },
            { table: 'leagues', filter: 'id=eq.league' },
        ], onChange: vi.fn(), onStatus, onReconnect })
        realtime.topicStatus('l1:user:user', 'SUBSCRIBED')
        await Promise.resolve()
        expect(onStatus).not.toHaveBeenCalled()
        realtime.topicStatus('l1:league:league', 'SUBSCRIBED')
        await Promise.resolve()
        expect(onStatus).toHaveBeenLastCalledWith('SUBSCRIBED')
        expect(onReconnect).not.toHaveBeenCalled()
        realtime.topicStatus('l1:user:user', 'CHANNEL_ERROR')
        realtime.topicStatus('l1:user:user', 'SUBSCRIBED')
        await Promise.resolve()
        expect(onStatus.mock.calls).toEqual([['SUBSCRIBED'], ['CHANNEL_ERROR'], ['SUBSCRIBED']])
        expect(onReconnect).toHaveBeenCalledOnce()
    })

    it('waits for a departing connection before remounting the same topic', async () => {
        const options = { mode: 'fallback' as const, watches: [{ table: 'trades', filter: 'league_id=eq.league' }], onChange: vi.fn() }
        const first = subscribeToTableChanges('first', options)
        let resolve!: () => void
        realtime.removeChannel.mockReturnValueOnce(new Promise(done => { resolve = () => done(undefined) }))
        const removal = unsubscribeFromTableChanges(first)
        subscribeToTableChanges('second', options)
        expect(realtime.channelFactory).toHaveBeenCalledOnce()
        resolve()
        await removal
        expect(realtime.channelFactory).toHaveBeenCalledTimes(2)
    })
})

describe('realtime subscriptions', () => {
    it('preserves each watch filter and callback', () => {
        const tradesChanged = vi.fn()
        const itemsChanged = vi.fn()
        subscribeToTableChanges('trade-test', { mode: 'per-watch', watches: [
            { table: 'trades', filter: 'league_id=eq.league-1', onChange: tradesChanged },
            { table: 'trade_items', event: 'UPDATE', onChange: itemsChanged },
        ] })

        expect(realtime.channelFactory).toHaveBeenCalledWith(expect.stringMatching(/^trade-test:/), { config: { private: true } })
        expect(realtime.callbacks.map((entry) => entry.config)).toEqual([
            { event: '*', schema: 'public', table: 'trades', filter: 'league_id=eq.league-1' },
            { event: 'UPDATE', schema: 'public', table: 'trade_items' },
        ])
        realtime.callbacks[0].callback({ row: 1 })
        realtime.callbacks[1].callback({ row: 2 })
        expect(tradesChanged).toHaveBeenCalledWith({ row: 1 })
        expect(itemsChanged).toHaveBeenCalledWith({ row: 2 })
    })

    it('uses the required fallback for handler-free watches', () => {
        const refresh = vi.fn()
        subscribeToTableChanges('fallback-test', {
            mode: 'fallback',
            watches: [{ table: 'roster_players' }, { table: 'draft_picks' }],
            onChange: refresh,
        })

        realtime.callbacks.forEach((entry) => entry.callback({}))
        expect(refresh).toHaveBeenCalledTimes(2)
    })

    it('surfaces subscription lifecycle status', () => {
        const onStatus = vi.fn()
        subscribeToTableChanges('status-test', {
            mode: 'fallback',
            watches: [],
            onChange: vi.fn(),
            onStatus,
        })

        realtime.emitStatus('SUBSCRIBED')
        realtime.emitStatus('CHANNEL_ERROR')

        expect(onStatus.mock.calls).toEqual([['SUBSCRIBED'], ['CHANNEL_ERROR']])
    })

    it.each(['CHANNEL_ERROR', 'TIMED_OUT'] as const)('recovers missed changes after %s without fake row events', async (status) => {
        const changed = vi.fn()
        const reload = vi.fn()
        subscribeToTableChanges('recover', { mode: 'fallback', watches: [], onChange: changed, onReconnect: reload })
        realtime.emitStatus('SUBSCRIBED')
        expect(reload).not.toHaveBeenCalled()
        realtime.emitStatus(status)
        realtime.emitStatus('SUBSCRIBED')
        await Promise.resolve()
        expect(reload).toHaveBeenCalledTimes(1)
        realtime.emitStatus('SUBSCRIBED')
        expect(reload).toHaveBeenCalledTimes(1)
        expect(changed).not.toHaveBeenCalled()
    })

    it('recovers when the initial join fails and bounds failed reads to three attempts', async () => {
        vi.useFakeTimers()
        const reload = vi.fn(async () => false)
        subscribeToTableChanges('failed-first-join', { mode: 'fallback', watches: [], onChange: vi.fn(), onReconnect: reload })
        realtime.emitStatus('TIMED_OUT')
        realtime.emitStatus('SUBSCRIBED')
        await vi.advanceTimersByTimeAsync(60_000)
        expect(reload).toHaveBeenCalledTimes(3)
        realtime.emitStatus('SUBSCRIBED')
        await vi.advanceTimersByTimeAsync(60_000)
        expect(reload).toHaveBeenCalledTimes(3)
        realtime.emitStatus('CHANNEL_ERROR')
        realtime.emitStatus('SUBSCRIBED')
        await Promise.resolve()
        expect(reload).toHaveBeenCalledTimes(4)
    })

    it('queues one later recovery when the socket rejoins during a pending read', async () => {
        vi.useFakeTimers()
        let resolve!: () => void
        const reload = vi.fn<() => Promise<void>>().mockReturnValueOnce(new Promise(done => { resolve = done }))
        reload.mockResolvedValue(undefined)
        subscribeToTableChanges('overlap', { mode: 'fallback', watches: [], onChange: vi.fn(), onReconnect: reload })
        realtime.emitStatus('CHANNEL_ERROR')
        realtime.emitStatus('SUBSCRIBED')
        realtime.emitStatus('CHANNEL_ERROR')
        realtime.emitStatus('SUBSCRIBED')
        expect(reload).toHaveBeenCalledTimes(1)
        resolve()
        await vi.advanceTimersByTimeAsync(2_000)
        expect(reload).toHaveBeenCalledTimes(2)
    })

    it('cancels recovery listeners and retries even when channel removal fails', async () => {
        vi.useFakeTimers()
        const browser = new EventTarget()
        vi.stubGlobal('window', browser)
        const removeListener = vi.spyOn(browser, 'removeEventListener')
        const reload = vi.fn(async () => false)
        const channel = subscribeToTableChanges('dispose-recovery', { mode: 'fallback', watches: [], onChange: vi.fn(), onReconnect: reload })
        realtime.emitStatus('CHANNEL_ERROR')
        realtime.emitStatus('SUBSCRIBED')
        await Promise.resolve()
        realtime.removeChannel.mockRejectedValueOnce(new Error('Socket gone'))
        await expect(unsubscribeFromTableChanges(channel)).rejects.toThrow('Socket gone')
        realtime.emitStatus('SUBSCRIBED')
        browser.dispatchEvent(new Event('online'))
        await vi.advanceTimersByTimeAsync(60_000)
        expect(reload).toHaveBeenCalledTimes(1)
        expect(removeListener).toHaveBeenCalledWith('online', expect.any(Function))
    })

    it('debounces refreshes and cancels pending work during disposal', async () => {
        vi.useFakeTimers()
        const refresh = vi.fn()
        const debounced = debounceRealtimeRefresh(refresh, 100)
        const channel = subscribeToTableChanges('dispose-test', {
            mode: 'fallback',
            watches: [],
            onChange: refresh,
        })
        debounced.trigger()
        debounced.trigger()
        vi.advanceTimersByTime(99)
        expect(refresh).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(refresh).toHaveBeenCalledTimes(1)

        debounced.trigger()
        await disposeTableChangeSubscription(channel, [debounced])
        vi.runAllTimers()
        expect(refresh).toHaveBeenCalledTimes(1)
        expect(realtime.removeChannel).toHaveBeenCalledWith(channel)
    })

    it('surfaces asynchronous channel removal failures', async () => {
        const error = new Error('remove failed')
        realtime.removeChannel.mockRejectedValueOnce(error)
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

        reportRealtimeCleanup('test', unsubscribeFromTableChanges(realtime.channel as never))
        await Promise.resolve()
        await Promise.resolve()

        expect(consoleError).toHaveBeenCalledWith(
            'Could not clean up test realtime subscription.',
            error,
        )
    })
})

it('uses a different channel topic for duplicate mounts of the same watch', () => {
    for (let mount = 0; mount < 3; mount++) {
        subscribeToTableChanges('same-screen', { mode: 'fallback', watches: [{ table: 'trades' }], onChange: vi.fn() })
    }
    const topics = realtime.channelFactory.mock.calls.map(call => (call as unknown[])[0])
    expect(topics).toHaveLength(3)
    expect(new Set(topics).size).toBe(3)
    expect(topics.every(topic => typeof topic === 'string' && topic.startsWith('same-screen:'))).toBe(true)
})
