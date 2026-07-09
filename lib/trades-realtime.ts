import { scopeWatchesToLeague, type TableChangeWatch } from '@/lib/realtime-config'

type TradeScreenRefreshes = {
    trades: () => void
    tradeBlock: () => void
    draftPicks: () => void
}

export function tradeScreenWatches(leagueId: string, refresh: TradeScreenRefreshes): TableChangeWatch[] {
    return scopeWatchesToLeague(leagueId, [
        { table: 'trades', onChange: refresh.trades },
        { table: 'trade_items', onChange: refresh.trades },
        { table: 'trade_participants', onChange: refresh.trades },
        { table: 'trade_vetos', onChange: refresh.trades },
        { table: 'trade_block_items', onChange: refresh.tradeBlock },
        { table: 'draft_picks', onChange: refresh.draftPicks },
    ])
}
