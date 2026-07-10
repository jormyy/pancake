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
}

export function useTradeScreenRealtime({
    leagueId,
    memberId,
    activeTab,
    refreshTrades,
    refreshHistory,
    refreshTradeBlock,
    refreshDraftPicks,
}: TradeScreenRealtimeOptions) {
    const activeTabRef = useRef(activeTab)
    activeTabRef.current = activeTab

    useEffect(() => {
        if (!memberId || !leagueId) return
        const trades = debounceRealtimeRefresh(() => { void refreshTrades() })
        const history = debounceRealtimeRefresh(() => {
            if (activeTabRef.current === 'history') void refreshHistory()
        })
        const tradeBlock = debounceRealtimeRefresh(() => { void refreshTradeBlock() })
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
