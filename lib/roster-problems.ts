import { isIREligible } from '@pancake/core'
import type { RosterPlayer } from '@/lib/roster'
import { partitionRoster, rosterLocation } from '@/lib/roster-capacity'

export type RosterProblem = { kind: 'ir' | 'taxi'; player: RosterPlayer; message: string } | { kind: 'over_limit'; player: null; message: string }

export function getRosterProblems(roster: RosterPlayer[], rosterSize: number | null): RosterProblem[] {
    const problems: RosterProblem[] = []
    for (const player of roster) {
        const location = rosterLocation(player)
        if (location === 'ir' && !isIREligible(player.players.injury_status)) problems.push({ kind: 'ir', player, message: `${player.players.display_name} no longer qualifies for IR.` })
        if (location === 'taxi' && player.players.years_exp !== 0 && player.players.career_regular_season_games != null && player.players.career_regular_season_games >= 65) problems.push({ kind: 'taxi', player, message: `${player.players.display_name} no longer qualifies for taxi.` })
    }
    if (rosterSize != null) {
        const excess = partitionRoster(roster).active.length - rosterSize
        if (excess > 0) problems.push({ kind: 'over_limit', player: null, message: `Active roster is ${excess} over the limit.` })
    }
    return problems
}
