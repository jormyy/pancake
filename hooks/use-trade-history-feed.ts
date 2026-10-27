import { useTradeViewPage } from '@/hooks/use-trade-view-page'

export function useTradeHistoryFeed(memberId: string, leagueId: string, enabled: boolean) {
    return useTradeViewPage(memberId, leagueId, 'history', enabled)
}
