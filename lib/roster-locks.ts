import { getStartedTeams } from '@/lib/lineup'
import type { RosterPlayer } from '@/lib/roster'
import { todayET } from '@/lib/shared/dates'

export async function getRosterStatusChangeLockMessage(rosterPlayer: RosterPlayer | null | undefined): Promise<string | null> {
    if (!rosterPlayer) return null

    const team = rosterPlayer.players.nba_team
    if (!team) return null

    const startedTeams = await getStartedTeams(todayET())
    if (!startedTeams.has(team)) return null

    return `${rosterPlayer.players.display_name}'s game has already started. IR and taxi changes are locked for today's slate.`
}
