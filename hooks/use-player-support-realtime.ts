import { useEffect } from 'react'
import { deferLeagueRefresh } from '@/lib/league-changes'
import { invalidateSeasonCache } from '@/lib/shared/season'
import { reportRealtimeCleanup, subscribeToTableChanges, unsubscribeFromTableChanges } from '@/lib/realtime'

type Read = () => void | boolean | Promise<void | boolean>

export function usePlayerSupportRealtime(memberId: string | undefined, leagueId: string | null, refreshSupport: Read, recover: Read) {
    useEffect(() => {
        if (!leagueId || !memberId) return
        const refresh = deferLeagueRefresh(refreshSupport)
        const channel = subscribeToTableChanges(`players-screen:${leagueId}`, {
            mode: 'fallback',
            watches: [
                { table: 'roster_players', filter: `league_id=eq.${leagueId}` },
                { table: 'waiver_wire_log', filter: `league_id=eq.${leagueId}` },
                { table: 'waiver_claims', filter: `member_id=eq.${memberId}` },
                { table: 'league_members', filter: `league_id=eq.${leagueId}` },
            ],
            onChange: refresh.trigger,
            onReconnect: () => {
                invalidateSeasonCache(leagueId)
                return recover()
            },
        })
        return () => {
            refresh.cancel()
            reportRealtimeCleanup('players', unsubscribeFromTableChanges(channel))
        }
    }, [leagueId, memberId, recover, refreshSupport])
}
