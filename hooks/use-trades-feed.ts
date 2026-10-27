import { useCallback } from 'react'
import { useTradeViewPage } from '@/hooks/use-trade-view-page'
import type { TradeRosterPlan } from '@/lib/trades'

export function useTradesFeed(memberId: string, leagueId: string, online = true, options: { autoLoad?: boolean } = {}) {
    const feed = useTradeViewPage(memberId, leagueId, 'offers', online, options.autoLoad !== false)
    const updateTrades = feed.updateTrades
    const updateRosterPlan = useCallback((tradeId: string, plan: TradeRosterPlan) => {
        updateTrades(trades => trades.map(trade => trade.id !== tradeId ? trade : { ...trade,
            routedItems: trade.routedItems.map(item => item.kind === 'player' && item.toMemberId === memberId ? { ...item, toTaxi: item.fromTaxi === true || plan.taxiPlayerIds.includes(item.playerId), toIR: plan.irPlayerIds.includes(item.playerId) } : item),
            participants: trade.participants.map(participant => participant.memberId === memberId ? { ...participant, dropPlayerIds: plan.dropPlayerIds, rosterMoves: plan.rosterMoves ?? [] } : participant),
        }))
    }, [updateTrades, memberId])
    return { ...feed, updateRosterPlan }
}
