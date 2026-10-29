import type { LeagueWeekMatchup } from '@/lib/scoring'

export function orderedMatchups(matchups: readonly LeagueWeekMatchup[]): LeagueWeekMatchup[] {
    return [...matchups.filter(matchup => matchup.isMine), ...matchups.filter(matchup => !matchup.isMine)]
}

export function adjacentMatchupId(matchups: readonly LeagueWeekMatchup[], currentId: string, direction: -1 | 1): string | null {
    const ordered = orderedMatchups(matchups)
    const index = ordered.findIndex(matchup => matchup.id === currentId)
    if (index < 0) return null
    return ordered[(index + direction + ordered.length) % ordered.length].id
}
