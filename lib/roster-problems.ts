import { isIREligible, isTaxiEligible } from '@pancake/core'
import type { RosterPlayer } from '@/lib/roster'

export type RosterProblem = { kind: 'ir' | 'taxi'; player: RosterPlayer; message: string } | { kind: 'over_limit'; player: null; message: string }

export function getRosterProblems(roster: RosterPlayer[], rosterSize: number): RosterProblem[] {
    const problems: RosterProblem[] = []
    for (const player of roster) {
        if (player.is_on_ir && !isIREligible(player.players.injury_status)) problems.push({ kind: 'ir', player, message: `${player.players.display_name} no longer qualifies for IR.` })
        if (player.is_on_taxi && !isTaxiEligible(player.players.years_exp, player.players.career_regular_season_games ?? null)) problems.push({ kind: 'taxi', player, message: `${player.players.display_name} no longer qualifies for taxi.` })
    }
    const excess = roster.filter(player => !player.is_on_ir && !player.is_on_taxi).length - rosterSize
    if (excess > 0) problems.push({ kind: 'over_limit', player: null, message: `Active roster is ${excess} over the limit.` })
    return problems
}
