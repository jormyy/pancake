import { useEffect, useMemo, useState } from 'react'
import { useScope } from '@/hooks/use-scope'
import { getRosterStatsMaps, type RosterStatsMaps } from '@/lib/roster-stats'
import { tradeActivityPlayerIds, withTradeAverages, type TransactionRow } from '@/lib/transactions'

export function useTradeActivityAverages(leagueId: string | undefined, rows: TransactionRow[]): TransactionRow[] {
    const playerKey = useMemo(() => tradeActivityPlayerIds(rows).join(','), [rows])
    const requestKey = leagueId && playerKey ? `${leagueId}:${playerKey}` : ''
    const scope = useScope(requestKey)
    const [loaded, setLoaded] = useState<{ key: string; stats: RosterStatsMaps } | null>(null)
    useEffect(() => {
        if (!leagueId || !playerKey) return
        const ticket = scope.latest()
        getRosterStatsMaps(playerKey.split(','), leagueId).then(
            (stats) => { ticket.commit(() => setLoaded({ key: `${leagueId}:${playerKey}`, stats })) },
            (error) => console.warn('Could not load trade player averages for activity.', error),
        )
    }, [leagueId, playerKey, scope])
    return useMemo(() => loaded && loaded.key === requestKey ? withTradeAverages(rows, loaded.stats) : rows, [loaded, requestKey, rows])
}
