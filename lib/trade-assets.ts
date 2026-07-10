import type { RosterPlayer } from '@/lib/roster'

export function isTradeableRosterPlayer(player: RosterPlayer): boolean {
    return !player.is_on_ir && !player.is_on_taxi
}
