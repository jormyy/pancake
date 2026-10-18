import { useEffect } from 'react'
import { leagueChangeReceiver, notifyLeagueChange, setLeagueChangesConnected } from '@/lib/league-changes'
import { invalidateSeasonCache } from '@/lib/shared/season'
import { sessionGeneration } from '@/lib/session-cache-registry'

export function useLeagueChangeStream(leagueId: string | undefined, userId: string | null, validated: boolean) {
    useEffect(() => {
        if (!leagueId || !userId || !validated) return
        let disposed = false
        let cleanup: (() => void) | undefined
        const generation = sessionGeneration()
        const current = () => !disposed && generation === sessionGeneration()
        const receive = leagueChangeReceiver(leagueId, change => {
            if (!current()) return
            if (change.topic === 'inventory') invalidateSeasonCache(leagueId)
            notifyLeagueChange(leagueId, change)
        })
        void import('@/lib/realtime').then(({ subscribeToTableChanges, unsubscribeFromTableChanges, reportRealtimeCleanup }) => {
            if (!current()) return
            const channel = subscribeToTableChanges(`league-changes:${leagueId}:${userId}`, {
                mode: 'per-watch',
                onStatus: status => {
                    if (!current()) return
                    setLeagueChangesConnected(leagueId, status === 'SUBSCRIBED')
                    if (status === 'SUBSCRIBED') notifyLeagueChange(leagueId, { topic: 'catchup', scopes: null })
                },
                watches: [{ table: 'league_change_hints', filter: `league_id=eq.${leagueId}`, onChange: payload => {
                    if (current() && payload.eventType !== 'DELETE') receive(payload.new)
                } }],
            })
            cleanup = () => reportRealtimeCleanup('league changes', unsubscribeFromTableChanges(channel))
        }).catch(error => { if (current()) console.error('Could not subscribe to league changes.', error) })
        return () => {
            disposed = true
            setLeagueChangesConnected(leagueId, false)
            cleanup?.()
        }
    }, [leagueId, userId, validated])
}
