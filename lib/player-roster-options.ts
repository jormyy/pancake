import type { RosterPlayer } from '@/lib/roster'

export function orderRosterOptions(roster: readonly RosterPlayer[]): RosterPlayer[] {
    return [...roster].sort((left, right) => left.players.display_name.localeCompare(right.players.display_name)
        || left.id.localeCompare(right.id))
}
