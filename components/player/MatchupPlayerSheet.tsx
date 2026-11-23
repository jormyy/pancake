import { useEffect, useState } from 'react'
import { PlayerPreviewSheet } from '@/components/player/PlayerPreviewSheet'
import { useScope } from '@/hooks/use-scope'
import type { LineupPlayer } from '@/lib/lineup'
import { getRosterStatsMaps, type RosterStatsMaps } from '@/lib/roster-stats'

/** Matchup's player preview: the same sheet as Roster, with only the player page action. */
export function MatchupPlayerSheet({ player, leagueId, onOpenPage, onClose }: {
    player: LineupPlayer | null
    leagueId: string | null | undefined
    onOpenPage: (player: LineupPlayer) => void
    onClose: () => void
}) {
    const playerId = player?.playerId ?? null
    const [loaded, setLoaded] = useState<{ playerId: string; maps: RosterStatsMaps } | null>(null)
    const scope = useScope(playerId, leagueId)

    useEffect(() => {
        if (!playerId || !leagueId) return
        const ticket = scope.latest()
        getRosterStatsMaps([playerId], leagueId)
            .then(maps => { ticket.commit(() => setLoaded({ playerId, maps })) })
            .catch(() => {})
    }, [playerId, leagueId, scope])

    // Never show a previous player's averages while the next player's load.
    const maps = loaded && loaded.playerId === playerId ? loaded.maps : null
    return (
        <PlayerPreviewSheet
            player={player ? {
                name: player.displayName, nbaId: player.nbaId, team: player.nbaTeam,
                positions: player.eligiblePositions.length ? player.eligiblePositions : player.position ? [player.position] : [],
                yearsExp: player.yearsExp, careerGames: player.careerGames, injuryStatus: player.injuryStatus,
            } : null}
            avgFpts={playerId ? maps?.avgMap.get(playerId) : undefined}
            stats={playerId ? maps?.avgStatsMap.get(playerId) : undefined}
            actions={player ? [{
                key: 'page',
                label: 'Player page',
                icon: 'person',
                accessibilityLabel: `View ${player.displayName} player page`,
                onPress: () => { onClose(); onOpenPage(player) },
            }] : []}
            onClose={onClose}
        />
    )
}
