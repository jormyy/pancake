import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { type FallbackTableChangeWatch, type TableChangeWatch } from '@/lib/realtime-config'
export { scopeWatchesToLeague, type FallbackTableChangeWatch, type TableChangeWatch } from '@/lib/realtime-config'

type TableChangeSubscription =
    | { mode: 'per-watch'; watches: TableChangeWatch[] }
    | { mode: 'fallback'; watches: FallbackTableChangeWatch[]; onChange: () => void }

export function subscribeToTableChanges(
    channelName: string,
    subscription: TableChangeSubscription,
): RealtimeChannel {
    const channel = supabase.channel(channelName, { config: { private: true } })
    const register = (watch: FallbackTableChangeWatch, onChange: TableChangeWatch['onChange']) => {
        channel.on(
            'postgres_changes',
            {
                event: watch.event ?? '*',
                schema: 'public',
                table: watch.table,
                ...(watch.filter ? { filter: watch.filter } : {}),
            },
            onChange,
        )
    }
    if (subscription.mode === 'per-watch') {
        for (const watch of subscription.watches) register(watch, watch.onChange)
    } else {
        for (const watch of subscription.watches) register(watch, subscription.onChange)
    }
    return channel.subscribe()
}

export function debounceRealtimeRefresh(onChange: () => void, delayMs = 250) {
    let timer: ReturnType<typeof setTimeout> | null = null
    const trigger = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
            timer = null
            onChange()
        }, delayMs)
    }
    const cancel = () => {
        if (!timer) return
        clearTimeout(timer)
        timer = null
    }
    return { trigger, cancel }
}

export function unsubscribeFromTableChanges(channel: RealtimeChannel) {
    supabase.removeChannel(channel)
}

export function disposeTableChangeSubscription(
    channel: RealtimeChannel,
    refreshes: { cancel: () => void }[],
) {
    for (const refresh of refreshes) refresh.cancel()
    unsubscribeFromTableChanges(channel)
}
