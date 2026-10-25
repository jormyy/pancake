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
    onReconnect?: () => void | boolean | Promise<void | boolean>
}

let channelNonce = 0
const subscriptionCleanups = new WeakMap<RealtimeChannel, () => void>()

function reconnectRecovery(reload: NonNullable<SubscriptionWithStatus['onReconnect']>) {
    let disposed = false
    let joined = false
    let disconnected = false
    let pending = false
    let inFlight = false
    let attempts = 0
    let retry: ReturnType<typeof setTimeout> | null = null
    const canRead = () => !disposed && joined
        && (typeof navigator === 'undefined' || navigator.onLine !== false)
        && (typeof document === 'undefined' || document.visibilityState !== 'hidden')
    const run = async () => {
        if (!pending || inFlight || attempts >= 3 || !canRead()) return
        if (retry) clearTimeout(retry)
        retry = null
        pending = false
        inFlight = true
        attempts += 1
        try {
            if (await reload() === false) pending = true
        } catch (error) {
            pending = true
            if (!disposed) console.error('Could not recover missed realtime updates.', error)
        } finally {
            inFlight = false
            if (pending && canRead() && attempts < 3) {
                retry = setTimeout(() => { retry = null; void run() }, 2_000 * attempts)
            }
        }
    }
    const resume = () => {
        if (!canRead() || !pending) return
        attempts = 0
        void run()
    }
    if (typeof window !== 'undefined') window.addEventListener('online', resume)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resume)
    return {
        onStatus: (status: RealtimeSubscriptionStatus) => {
            if (disposed) return
            if (status !== 'SUBSCRIBED') {
                joined = false
                disconnected = true
                return
            }
            joined = true
            if (disconnected) {
                disconnected = false
                pending = true
                attempts = 0
            }
            void run()
        },
        cancel: () => {
            disposed = true
            pending = false
            if (retry) clearTimeout(retry)
            if (typeof window !== 'undefined') window.removeEventListener('online', resume)
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resume)
        },
    }
}

export function subscribeToTableChanges(
    channelName: string,
    subscription: SubscriptionWithStatus,
): RealtimeChannel {
    const channel = supabase.channel(`${channelName}:${++channelNonce}`, { config: { private: true } })
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
    const recovery = subscription.onReconnect ? reconnectRecovery(subscription.onReconnect) : null
    if (recovery) subscriptionCleanups.set(channel, recovery.cancel)
    return channel.subscribe((status) => {
        subscription.onStatus?.(status)
        recovery?.onStatus(status)
    })
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
    subscriptionCleanups.get(channel)?.()
    subscriptionCleanups.delete(channel)
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
