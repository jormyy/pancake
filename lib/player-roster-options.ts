import type { RosterPlayer } from '@/lib/roster'
import { partitionRoster, rosterLocation, type RosterRow } from '@/lib/roster-capacity'

export function orderRosterOptions(roster: readonly RosterPlayer[]): RosterPlayer[] {
    return [...roster].sort((left, right) => left.players.display_name.localeCompare(right.players.display_name)
        || left.id.localeCompare(right.id))
}

export function groupRosterOptions(roster: readonly RosterPlayer[]): { label: string; players: RosterPlayer[] }[] {
    const { active, ir, taxi } = partitionRoster(roster)
    return [
        { label: 'Roster', players: active },
        { label: 'IR', players: ir },
        { label: 'Taxi', players: taxi },
    ].filter(group => group.players.length > 0)
}

export function rosterSlotLabel(player: RosterRow): string {
    const location = rosterLocation(player)
    return location === 'taxi' ? 'Taxi' : location === 'ir' ? 'IR' : 'Active'
}
