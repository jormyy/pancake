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
    online = true,
    focused = true,
}: TradeScreenRealtimeOptions) {
    const [subscriptionEpoch, setSubscriptionEpoch] = useState(0)
    const activeTabRef = useRef(activeTab)
    activeTabRef.current = activeTab
    const visibility = useRef({ online, focused })
    visibility.current = { online, focused }
    const recovery = useRef<{ mark: () => void; flush: () => void } | null>(null)

    useEffect(() => {
        if (!memberId || !leagueId) return
        let disposed = false
        const feeds = { trades: refreshTrades, history: refreshHistory, block: refreshTradeBlock, picks: refreshDraftPicks }
        type Feed = keyof typeof feeds
        const pending = new Set<Feed>()
        let refreshing = false
        let retry: ReturnType<typeof setTimeout> | null = null
        let closed = false
        let reconnect: ReturnType<typeof setTimeout> | null = null
        const reconnectIfClosed = () => {
            if (disposed || !closed || reconnect || !visibility.current.online || !visibility.current.focused) return
            reconnect = setTimeout(() => {
                reconnect = null
                if (!disposed && closed && visibility.current.online && visibility.current.focused) {
                    setSubscriptionEpoch((epoch) => epoch + 1)
                }
            }, 15_000)
        }
        const visibleFeeds = (): Feed[] => {
            const tab = activeTabRef.current
            return ['trades',
                ...(tab === 'history' ? ['history' as const] : []),
                ...(tab === 'block' || tab === 'leagueBlock' ? ['block' as const] : []),
                ...(tab === 'block' || tab === 'picks' ? ['picks' as const] : []),
            ]
        }
        const mark = () => { for (const feed of Object.keys(feeds) as Feed[]) pending.add(feed) }
        const recover = async () => {
            if (disposed || refreshing || !visibility.current.online || !visibility.current.focused) return
            if (retry) clearTimeout(retry)
            retry = null
            const work = visibleFeeds().filter((feed) => pending.has(feed))
            if (!work.length) return
            for (const feed of work) pending.delete(feed)
            refreshing = true
            try {
                await Promise.all(work.map(async (feed) => {
                    try {
                        if (await feeds[feed]() === false) pending.add(feed)
                    } catch {
                        pending.add(feed)
                    }
                }))
            } finally {
                refreshing = false
                if (!disposed && visibleFeeds().some((feed) => pending.has(feed))) {
                    retry = setTimeout(() => { void recover() }, 15_000)
                }
            }
        }
        const ownerRecovery = { mark, flush: () => { void recover(); reconnectIfClosed() } }
        recovery.current = ownerRecovery
        const requestFeeds = (...changed: Feed[]) => {
            if (disposed) return
            for (const feed of changed) pending.add(feed)
            void recover()
        }
        const trades = debounceRealtimeRefresh(() => requestFeeds('trades', 'history'))
        const tradeBlock = debounceRealtimeRefresh(() => requestFeeds('block'))
        const draftPicks = debounceRealtimeRefresh(() => requestFeeds('picks'))
        const channel = subscribeToTableChanges(`trades-screen:${leagueId}:${memberId}`, {
            mode: 'per-watch',
            onStatus: (status) => {
                if (disposed) return
                mark()
                if (status === 'SUBSCRIBED') {
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
            if (retry) clearTimeout(retry)
            if (reconnect) clearTimeout(reconnect)
            if (recovery.current === ownerRecovery) recovery.current = null
            reportRealtimeCleanup('trades', disposeTableChangeSubscription(channel, [trades, tradeBlock, draftPicks]))
        }
    }, [leagueId, memberId, refreshDraftPicks, refreshHistory, refreshTradeBlock, refreshTrades, subscriptionEpoch])

    useEffect(() => {
        if (!online) recovery.current?.mark()
        else if (focused) recovery.current?.flush()
    }, [activeTab, focused, leagueId, memberId, online])
}
