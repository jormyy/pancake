import { useEffect, useRef, useState } from 'react'
import type { TradeTabKey } from '@/lib/trade-ui-model'
import {
    debounceRealtimeRefresh,
    disposeTableChangeSubscription,
    reportRealtimeCleanup,
    subscribeToTableChanges,
} from '@/lib/realtime'
import { tradeScreenWatches } from '@/lib/trades-realtime'

type TradeScreenRealtimeOptions = {
    leagueId: string
    memberId: string
    activeTab: TradeTabKey
    refreshTrades: () => void | boolean | Promise<void | boolean>
    refreshHistory: () => void | boolean | Promise<void | boolean>
    refreshTradeBlock: () => void | boolean | Promise<void | boolean>
    refreshDraftPicks: () => void | boolean | Promise<void | boolean>
    initialTradesRead?: boolean
    draftPicksFresh?: boolean
    online?: boolean
    focused?: boolean
}

export function useTradeScreenRealtime({
    leagueId,
    memberId,
    activeTab,
    refreshTrades,
    refreshHistory,
    refreshTradeBlock,
    refreshDraftPicks,
    initialTradesRead = false,
    draftPicksFresh = false,
    online = true,
    focused = true,
}: TradeScreenRealtimeOptions) {
    const freshPicksRef = useRef(draftPicksFresh)
    freshPicksRef.current = draftPicksFresh
    const [subscriptionEpoch, setSubscriptionEpoch] = useState(0)
    const activeTabRef = useRef(activeTab)
    activeTabRef.current = activeTab
    const visibility = useRef({ online, focused })
    visibility.current = { online, focused }
    const recovery = useRef<{ flush: () => void; pause: () => void; enter: () => void } | null>(null)

    useEffect(() => {
        if (!memberId || !leagueId) return
        let disposed = false
        const feeds = { trades: refreshTrades, history: refreshHistory, block: refreshTradeBlock, picks: refreshDraftPicks }
        type Feed = keyof typeof feeds
        const pending = new Set<Feed>()
        let refreshing: object | null = null
        let retry: ReturnType<typeof setTimeout> | null = null
        let initial: ReturnType<typeof setTimeout> | null = null
        const visible = () => visibility.current.online && visibility.current.focused && (typeof document === 'undefined' || document.visibilityState !== 'hidden')
        let subscribed = false
        let closed = false
        let reconnect: ReturnType<typeof setTimeout> | null = null
        const reconnectIfClosed = () => {
            if (disposed || !closed || reconnect || !visible()) return
            reconnect = setTimeout(() => {
                reconnect = null
                if (!disposed && closed && visible()) {
                    setSubscriptionEpoch((epoch) => epoch + 1)
                }
            }, 15_000)
        }
        const visibleFeeds = (): Feed[] => {
            const tab = activeTabRef.current
            return ['trades',
                ...(tab === 'history' ? ['history' as const] : []),
                ...(tab === 'block' ? ['block' as const] : []),
                ...(tab === 'block' ? ['picks' as const] : []),
            ]
        }
        const mark = () => { for (const feed of Object.keys(feeds) as Feed[]) pending.add(feed) }
        const recover = async () => {
            if (disposed || refreshing || !visible()) return
            if (retry) clearTimeout(retry)
            retry = null
            const work = visibleFeeds().filter((feed) => pending.has(feed))
            if (!work.length) return
            if (work.includes('trades') && initial) { clearTimeout(initial); initial = null }
            for (const feed of work) pending.delete(feed)
            const request = {}
            refreshing = request
            try {
                await Promise.all(work.map(async (feed) => {
                    try {
                        if (await feeds[feed]() === false && refreshing === request && !disposed) pending.add(feed)
                    } catch {
                        if (refreshing === request && !disposed) pending.add(feed)
                    }
                }))
            } finally {
                if (refreshing === request) {
                    refreshing = null
                    if (!disposed) {
                        const next = visibleFeeds().filter(feed => pending.has(feed))
                        if (next.some(feed => !work.includes(feed))) void recover()
                        else if (next.length) retry = setTimeout(() => { void recover() }, 15_000)
                    }
                }
            }
        }
        const ownerRecovery = {
            enter: () => {
                if (activeTabRef.current === 'block') pending.add('block')
                if (activeTabRef.current === 'history') pending.add('history')
                void recover()
                reconnectIfClosed()
            },
            pause: () => {
                mark()
                refreshing = null
                if (retry) clearTimeout(retry)
                retry = null
            },
            flush: () => { void recover(); reconnectIfClosed() },
        }
        recovery.current = ownerRecovery
        const requestFeeds = (...changed: Feed[]) => {
            if (disposed) return
            for (const feed of changed) pending.add(feed)
            void recover()
        }
        const trades = debounceRealtimeRefresh(() => requestFeeds('trades', 'history'))
        const tradeBlock = debounceRealtimeRefresh(() => requestFeeds('block'))
        const draftPicks = debounceRealtimeRefresh(() => requestFeeds('picks'))
        if (initialTradesRead) initial = setTimeout(() => requestFeeds('trades'), 300)
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') ownerRecovery.pause()
            else ownerRecovery.flush()
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        const channel = subscribeToTableChanges(`trades-screen:${leagueId}:${memberId}`, {
            mode: 'per-watch',
            onStatus: (status) => {
                if (disposed) return
                const preserveFreshPicks = status === 'SUBSCRIBED' && !subscribed && freshPicksRef.current && !pending.has('picks')
                mark()
                if (preserveFreshPicks) pending.delete('picks')
                if (status === 'SUBSCRIBED') {
                    if (initial) clearTimeout(initial)
                    initial = null
                    subscribed = true
                    closed = false
                    if (reconnect) clearTimeout(reconnect)
                    reconnect = null
                    void recover()
                } else if (status === 'CLOSED') {
                    closed = true
                    void recover()
                    reconnectIfClosed()
                }
            },
            watches: tradeScreenWatches(leagueId, {
                trades: trades.trigger,
                tradeBlock: tradeBlock.trigger,
                draftPicks: draftPicks.trigger,
            }),
        })
        return () => {
            disposed = true
            if (initial) clearTimeout(initial)
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
            if (retry) clearTimeout(retry)
            if (reconnect) clearTimeout(reconnect)
            if (recovery.current === ownerRecovery) recovery.current = null
            reportRealtimeCleanup('trades', disposeTableChangeSubscription(channel, [trades, tradeBlock, draftPicks]))
        }
    }, [initialTradesRead, leagueId, memberId, refreshDraftPicks, refreshHistory, refreshTradeBlock, refreshTrades, subscriptionEpoch])

    useEffect(() => {
        if (!online || !focused) recovery.current?.pause()
        else recovery.current?.enter()
    }, [activeTab, focused, leagueId, memberId, online])
}
