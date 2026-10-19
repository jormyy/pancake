import { afterEach, describe, expect, it, vi } from 'vitest'

const realtime = vi.hoisted(() => {
    const callbacks: { config: Record<string, unknown>; callback: (payload: unknown) => void }[] = []
    let statusCallback: ((status: 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR') => void) | undefined
    const channel = {
        on: vi.fn((_kind, config, callback) => {
            callbacks.push({ config, callback })
            return channel
        }),
        subscribe: vi.fn((callback) => {
            statusCallback = callback
            return channel
        }),
    }
    return {
        callbacks,
        channel,
        channelFactory: vi.fn(() => channel),
        removeChannel: vi.fn(),
        emitStatus: (status: 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR') => statusCallback?.(status),
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
    subscribeToTableChanges,
    unsubscribeFromTableChanges,
} from '@/lib/realtime'

afterEach(async () => {
    await unsubscribeFromTableChanges(realtime.channel as never)
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    realtime.callbacks.length = 0
})

describe('realtime subscriptions', () => {
    it('preserves each watch filter and callback', () => {
        const tradesChanged = vi.fn()
        const itemsChanged = vi.fn()
        subscribeToTableChanges('trade-test', { mode: 'per-watch', watches: [
            { table: 'trades', filter: 'league_id=eq.league-1', onChange: tradesChanged },
            { table: 'trade_items', event: 'UPDATE', onChange: itemsChanged },
        ] })

        expect(realtime.channelFactory).toHaveBeenCalledWith('trade-test', { config: { private: true } })
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
