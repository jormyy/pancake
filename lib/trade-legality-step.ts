import type { TradeRosterPreview } from '@/lib/trades'

export function isTradeRosterLegal(team: TradeRosterPreview | undefined) {
    return Boolean(team && (team.legal ?? !team.error))
}
