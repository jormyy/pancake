import { useTradeViewPage } from '@/hooks/use-trade-view-page'

export function useTradeHistoryFeed(memberId: string, leagueId: string, enabled: boolean, accountId?: string | null) {
    return useTradeViewPage(memberId, leagueId, 'history', enabled, true, accountId)
}
