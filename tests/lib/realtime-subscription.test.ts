import { afterEach, describe, expect, it, vi } from 'vitest'

const realtime = vi.hoisted(() => {
    const callbacks: { config: Record<string, unknown>; callback: (payload: unknown) => void }[] = []
    const channel = {
        on: vi.fn((_kind, config, callback) => {
            callbacks.push({ config, callback })
            return channel
        }),
        subscribe: vi.fn(() => channel),
    }
    return {
        callbacks,
        channel,
        channelFactory: vi.fn(() => channel),
        removeChannel: vi.fn(),
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

afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
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
