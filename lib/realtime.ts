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
const broadcastCleanups = new WeakMap<RealtimeChannel, () => Promise<void>>()
const broadcastHandles = new WeakSet<RealtimeChannel>()
type ChangePayload = Parameters<TableChangeWatch['onChange']>[0]
type HintBatch = { hints: { event?: ChangePayload['eventType']; row?: Record<string, unknown>; payload?: ChangePayload }[] }
type BroadcastListener = { receive: (payload: ChangePayload) => void; status: (status: RealtimeSubscriptionStatus) => void }
type BroadcastConnection = { channel: RealtimeChannel; listeners: Set<BroadcastListener>; status?: RealtimeSubscriptionStatus; started: boolean }
const broadcasts = new Map<string, BroadcastConnection>()
const retiringBroadcasts = new Map<string, { channel: RealtimeChannel; pending: Promise<unknown> }>()
const leagueBroadcastTables = new Set([
    'league_change_hints', 'league_members', 'roster_players', 'draft_picks', 'drafts',
    'matchup_forecasts', 'trade_block_items', 'trade_items', 'trade_participants', 'trade_vetos', 'trades',
])

function broadcastTopic(watch: FallbackTableChangeWatch): string | null {
    const match = /^(league_id|draft_id|member_id|user_id|id)=eq\.([^:]+)$/.exec(watch.filter ?? '')
    if (!match) return null
    const [, column, id] = match
    if (column === 'league_id' && leagueBroadcastTables.has(watch.table) || column === 'id' && watch.table === 'leagues') return `l1:league:${id}`
    if (column === 'draft_id' && ['draft_budgets', 'nominations', 'snake_draft_picks'].includes(watch.table)
        || column === 'id' && watch.table === 'drafts') return `l1:draft:${id}`
    if (column === 'member_id' && watch.table === 'waiver_claims') return `l1:member:${id}`
    if (column === 'user_id' && watch.table === 'league_members') return `l1:user:${id}`
    return null
}

function acquireBroadcast(topic: string, listener: BroadcastListener): BroadcastConnection {
    const existing = broadcasts.get(topic)
    if (existing) {
        existing.listeners.add(listener)
        if (existing.status) listener.status(existing.status)
        return existing
    }
    const retiring = retiringBroadcasts.get(topic)
    const connection: BroadcastConnection = {
        channel: retiring?.channel ?? supabase.channel(topic, { config: { private: true } }),
        listeners: new Set([listener]), started: false,
    }
    broadcasts.set(topic, connection)
    const start = () => {
        if (!connection.listeners.size) return
        if (retiring) connection.channel = supabase.channel(topic, { config: { private: true } })
        connection.started = true
        connection.channel.on('broadcast', { event: 'change' }, ({ payload }: { payload: ChangePayload | HintBatch }) => {
            if (!payload || typeof payload !== 'object') return
            const changes: ChangePayload[] = 'hints' in payload ? Array.isArray(payload.hints) ? payload.hints.flatMap(hint => {
                if (hint?.payload && typeof hint.payload === 'object') return [hint.payload]
                if (!hint || !hint.row || typeof hint.row !== 'object') return []
                const row = { league_id: topic.split(':')[2], ...hint.row }
                return [{ schema: 'public', table: 'league_change_hints', eventType: hint.event,
                    commit_timestamp: String(hint.row.updated_at ?? ''), errors: [],
                    new: hint.event === 'DELETE' ? {} : row, old: hint.event === 'DELETE' ? row : {},
                } as ChangePayload]
            }) : [] : [payload]
            for (const change of changes) {
                if (!change || change.schema !== 'public' || !['INSERT', 'UPDATE', 'DELETE'].includes(change.eventType)) continue
                for (const receiver of connection.listeners) receiver.receive(change)
            }
        }).subscribe(status => {
            connection.status = status
            for (const receiver of connection.listeners) receiver.status(status)
        })
    }
    if (retiring) void retiring.pending.then(start, () => listener.status('CHANNEL_ERROR'))
    else start()
    return connection
}

async function releaseBroadcast(topic: string, connection: BroadcastConnection, listener: BroadcastListener): Promise<void> {
    connection.listeners.delete(listener)
    if (connection.listeners.size) return
    if (broadcasts.get(topic) === connection) broadcasts.delete(topic)
    if (!connection.started) return
    const retiring = { channel: connection.channel, pending: supabase.removeChannel(connection.channel) }
    retiringBroadcasts.set(topic, retiring)
    try { await retiring.pending }
    finally { if (retiringBroadcasts.get(topic) === retiring) retiringBroadcasts.delete(topic) }
}

function subscribeToBroadcasts(subscription: SubscriptionWithStatus, topics: string[]): RealtimeChannel {
    let disposed = false
    let previous: RealtimeSubscriptionStatus | undefined
    const statuses = new Map<string, RealtimeSubscriptionStatus | undefined>(topics.map(topic => [topic, undefined]))
    const recovery = subscription.onReconnect ? reconnectRecovery(subscription.onReconnect) : null
    const entries = [...new Set(topics)].map(topic => {
        const listener: BroadcastListener = {
            receive: payload => {
                if (disposed) return
                for (const [index, watch] of subscription.watches.entries()) {
                    if (topics[index] !== topic || watch.table !== payload.table || watch.event && watch.event !== '*' && watch.event !== payload.eventType) continue
                    if (subscription.mode === 'per-watch') subscription.watches[index].onChange(payload)
                    else subscription.onChange()
                }
            },
            status: status => {
                statuses.set(topic, status)
                const combined = [...statuses.values()].every(value => value === 'SUBSCRIBED') ? 'SUBSCRIBED'
                    : [...statuses.values()].find(value => value && value !== 'SUBSCRIBED')
                queueMicrotask(() => {
                    if (disposed) return
                    if (!combined || combined === previous) return
                    previous = combined
                    subscription.onStatus?.(combined)
                    recovery?.onStatus(combined)
                })
            },
        }
        return { topic, listener, connection: acquireBroadcast(topic, listener) }
    })
    const handle = new Proxy(entries[0].connection.channel, {
        get: (_target, key) => {
            const channel = entries[0].connection.channel
            const value = Reflect.get(channel, key, channel)
            return typeof value === 'function' ? value.bind(channel) : value
        },
    })
    broadcastHandles.add(handle)
    broadcastCleanups.set(handle, async () => {
        disposed = true
        recovery?.cancel()
        await Promise.all(entries.map(({ topic, connection, listener }) => releaseBroadcast(topic, connection, listener)))
    })
    return handle
}

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
    const topics = subscription.watches.map(broadcastTopic)
    if (topics.length && topics.every((topic): topic is string => topic !== null)) return subscribeToBroadcasts(subscription, topics)
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
    const cleanup = broadcastCleanups.get(channel)
    if (cleanup) {
        broadcastCleanups.delete(channel)
        await cleanup()
        return
    }
    if (broadcastHandles.has(channel)) return
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
