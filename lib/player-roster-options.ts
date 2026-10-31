import type { RosterPlayer } from '@/lib/roster'

export function orderRosterOptions(roster: readonly RosterPlayer[]): RosterPlayer[] {
    return [...roster].sort((left, right) => left.players.display_name.localeCompare(right.players.display_name)
        || left.id.localeCompare(right.id))
}

export function rosterSlotLabel(player: Pick<RosterPlayer, 'is_on_taxi' | 'is_on_ir'>): string {
    return player.is_on_taxi ? 'Taxi' : player.is_on_ir ? 'IR' : 'Active'
}
