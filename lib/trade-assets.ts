import type { RosterPlayer } from '@/lib/roster'

export function isTradeableRosterPlayer(player: RosterPlayer, allowInactive = false): boolean {
    return allowInactive || !player.is_on_ir && !player.is_on_taxi
}
