import type { RosterPlayer } from '@/lib/roster'
import { isTaxiEligible } from '@pancake/core'
import type { TradeItem } from '@/lib/trades'

export function isTradeableRosterPlayer(player: RosterPlayer, allowInactive = false): boolean {
    return allowInactive || !player.is_on_ir && !player.is_on_taxi
}

export function isTradeTaxiEligible(player: Extract<TradeItem, { kind: 'player' }>, extended = false): boolean {
    return isTaxiEligible(player.nbaDraftNumber ?? null, player.yearsExp ?? null, player.careerGames ?? null, extended)
}
