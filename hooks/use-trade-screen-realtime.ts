import { useEffect, useRef } from 'react'
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
    refreshTrades: () => void | Promise<void>
    refreshHistory: () => void | Promise<void>
    refreshTradeBlock: () => void | Promise<void>
    refreshDraftPicks: () => void | Promise<void>
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
    const activeTabRef = useRef(activeTab)
    activeTabRef.current = activeTab
    const reconnectPending = useRef(false)

    useEffect(() => {
        if (!online) {
            reconnectPending.current = true
            return
        }
        if (!focused || !reconnectPending.current || !memberId || !leagueId) return
        reconnectPending.current = false
        void refreshTrades()
        if (activeTabRef.current === 'history') void refreshHistory()
        if (activeTabRef.current === 'block' || activeTabRef.current === 'leagueBlock') void refreshTradeBlock()
    }, [focused, leagueId, memberId, online, refreshHistory, refreshTradeBlock, refreshTrades])

    useEffect(() => {
        if (!memberId || !leagueId) return
        const trades = debounceRealtimeRefresh(() => { void refreshTrades() })
        const history = debounceRealtimeRefresh(() => {
            if (activeTabRef.current === 'history') void refreshHistory()
        })
        // The block feed is only visible on the block tabs; those tabs refetch on
        // entry, so skip the (full block + roster) reload while elsewhere.
        const tradeBlock = debounceRealtimeRefresh(() => {
            if (activeTabRef.current === 'block' || activeTabRef.current === 'leagueBlock') void refreshTradeBlock()
        })
        const draftPicks = debounceRealtimeRefresh(() => { void refreshDraftPicks() })
        const channel = subscribeToTableChanges(`trades-screen:${leagueId}:${memberId}`, {
            mode: 'per-watch',
            watches: tradeScreenWatches(leagueId, {
                trades: () => {
                    trades.trigger()
                    history.trigger()
                },
                tradeBlock: tradeBlock.trigger,
                draftPicks: draftPicks.trigger,
            }),
        })
        return () => reportRealtimeCleanup(
            'trades',
            disposeTableChangeSubscription(channel, [trades, history, tradeBlock, draftPicks]),
        )
    }, [leagueId, memberId, refreshDraftPicks, refreshHistory, refreshTradeBlock, refreshTrades])
}
