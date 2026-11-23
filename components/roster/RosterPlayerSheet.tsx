import { PlayerPreviewSheet, type RosterSheetAction } from '@/components/player/PlayerPreviewSheet'
import { readAssetLocks } from '@/lib/locked-assets'
import { getEligiblePositions } from '@/lib/players'
import type { RosterPlayer } from '@/lib/roster'
import type { RosterAverage } from '@/lib/roster-stats'
import { rosterLocation } from '@/lib/roster-capacity'

export type { RosterSheetAction } from '@/components/player/PlayerPreviewSheet'

/** Everything you can do with one of your players, one tap from the roster. */
export function RosterPlayerSheet({
    player,
    avgFpts,
    stats,
    actions,
    onClose,
}: {
    player: RosterPlayer | null
    avgFpts?: number
    stats?: RosterAverage
    actions: RosterSheetAction[]
    onClose: () => void
}) {
    const info = player?.players
    const location = player ? rosterLocation(player) : null
    return (
        <PlayerPreviewSheet
            player={info ? {
                name: info.display_name, nbaId: info.nba_id, team: info.nba_team, positions: getEligiblePositions(info),
                birthdate: info.birthdate, yearsExp: info.years_exp, careerGames: info.career_regular_season_games, injuryStatus: info.injury_status,
                onTaxi: location === 'taxi', status: location === 'ir' ? 'On IR' : location === 'taxi' ? 'Taxi squad' : null, locks: readAssetLocks(player),
            } : null}
            avgFpts={avgFpts}
            stats={stats}
            actions={actions}
            onClose={onClose}
        />
    )
}
