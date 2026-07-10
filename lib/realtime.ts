import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { type FallbackTableChangeWatch, type TableChangeWatch } from '@/lib/realtime-config'
export { type TableChangeWatch } from '@/lib/realtime-config'

type TableChangeSubscription =
    | { mode: 'per-watch'; watches: TableChangeWatch[] }
    | { mode: 'fallback'; watches: FallbackTableChangeWatch[]; onChange: () => void }

export type RealtimeSubscriptionStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR'
type SubscriptionWithStatus = TableChangeSubscription & {
    onStatus?: (status: RealtimeSubscriptionStatus) => void
}

export function subscribeToTableChanges(
    channelName: string,
    subscription: SubscriptionWithStatus,
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
    return channel.subscribe((status) => subscription.onStatus?.(status))
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

export async function unsubscribeFromTableChanges(channel: RealtimeChannel): Promise<void> {
    await supabase.removeChannel(channel)
}

export async function disposeTableChangeSubscription(
    channel: RealtimeChannel,
    refreshes: { cancel: () => void }[],
): Promise<void> {
    for (const refresh of refreshes) refresh.cancel()
    await unsubscribeFromTableChanges(channel)
}

export function reportRealtimeCleanup(label: string, cleanup: Promise<void>): void {
    void cleanup.catch((error) => {
        console.error(`Could not clean up ${label} realtime subscription.`, error)
    })
}
