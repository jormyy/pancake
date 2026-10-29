import type { RosterPlayer } from '@/lib/roster'
import type { TradeItem, TradeRosterPreview } from '@/lib/trades'

export function isTradeRosterLegal(team: TradeRosterPreview | undefined) {
    return Boolean(team && (team.legal ?? !team.error))
}

export function tradeLegalityStep(team: TradeRosterPreview, _roster: RosterPlayer[], _incoming: TradeItem[]) {
    return isTradeRosterLegal(team) ? 'Roster ready' : 'Make this roster legal'
}
