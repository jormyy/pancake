import { useEffect, useMemo, useState } from 'react'
import type { LineupPlayer } from '@/lib/lineup'
import { getDayProjections } from '@/lib/projections'
import { useScope } from '@/hooks/use-scope'

type Lineup = { starters: { player: LineupPlayer | null }[]; bench: LineupPlayer[] }

const EMPTY = new Map<string, number>()

/** Sleeper projections, in league points, for both lineups' starters and bench on the selected day; empty until loaded. */
export function useDayProjections(leagueId: string | null | undefined, date: string | null | undefined, lineups: (Lineup | null | undefined)[],
    settings: Record<string, number>) {
    const players = useMemo(() => {
        const byId = new Map<string, LineupPlayer>()
        for (const lineup of lineups) {
            if (!lineup) continue
            for (const player of [...lineup.starters.map(slot => slot.player), ...lineup.bench]) if (player) byId.set(player.playerId, player)
        }
        return [...byId.values()].sort((a, b) => a.playerId.localeCompare(b.playerId))
    }, [lineups])
    const key = leagueId && date && players.length
        ? JSON.stringify([leagueId, date, players.map(player => [player.playerId, player.nbaTeam]), settings]) : null
    const [loaded, setLoaded] = useState<{ key: string; projections: Map<string, number> } | null>(null)
    const scope = useScope(key)

    useEffect(() => {
        if (!key || !leagueId || !date) return
        const ticket = scope.latest()
        getDayProjections(leagueId, date, players, settings)
            .then(projections => { ticket.commit(() => setLoaded({ key, projections })) })
            .catch(() => {})
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, scope])

    // Never show another day's projections while this day's load.
    return loaded && loaded.key === key ? loaded.projections : EMPTY
}
