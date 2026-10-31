import type { RosterPlayer } from '@/lib/roster'

export function orderRosterOptions(roster: readonly RosterPlayer[]): RosterPlayer[] {
    return [...roster].sort((left, right) => left.players.display_name.localeCompare(right.players.display_name)
        || left.id.localeCompare(right.id))
}

export function groupRosterOptions(roster: readonly RosterPlayer[]): { label: string; players: RosterPlayer[] }[] {
    return [
        { label: 'Roster', players: roster.filter(player => !player.is_on_ir && !player.is_on_taxi) },
        { label: 'IR', players: roster.filter(player => player.is_on_ir && !player.is_on_taxi) },
        { label: 'Taxi', players: roster.filter(player => player.is_on_taxi) },
    ].filter(group => group.players.length > 0)
}

export function rosterSlotLabel(player: Pick<RosterPlayer, 'is_on_taxi' | 'is_on_ir'>): string {
    return player.is_on_taxi ? 'Taxi' : player.is_on_ir ? 'IR' : 'Active'
}
