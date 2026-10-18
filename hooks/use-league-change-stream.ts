import { useEffect } from 'react'
import { deferLeagueRefresh, leagueChangeReceiver, notifyLeagueChange, setLeagueChangesConnected } from '@/lib/league-changes'
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
            if (change.topic === 'inventory' && (!change.details || change.details.some(detail => detail.resource === 'season'))) invalidateSeasonCache(leagueId)
            notifyLeagueChange(leagueId, change)
        })
        let joined = false
        let joinEpoch = 0
        const readBaseline = async () => {
            if (!current() || !joined) return true
            const epoch = joinEpoch
            const { supabase } = await import('@/lib/supabase')
            if (!current() || !joined || epoch !== joinEpoch) return true
            const { data, error } = await supabase.from('league_change_hints')
                .select('league_id,topic,revision,scopes,details,updated_at').eq('league_id', leagueId)
            if (!current() || !joined || epoch !== joinEpoch) return true
            if (error) return false
            const trusted = (data ?? []).map(row => receive(row)).every(Boolean)
            if (!trusted) return false
            setLeagueChangesConnected(leagueId, true)
            notifyLeagueChange(leagueId, { topic: 'catchup', scopes: null })
            return true
        }
        let baseline = deferLeagueRefresh(readBaseline, 0)
        void import('@/lib/realtime').then(({ subscribeToTableChanges, unsubscribeFromTableChanges, reportRealtimeCleanup }) => {
            if (!current()) return
            const channel = subscribeToTableChanges(`league-changes:${leagueId}:${userId}`, {
                mode: 'per-watch',
                onStatus: status => {
                    if (!current()) return
                    if (status === 'SUBSCRIBED' && joined) return
                    baseline.cancel()
                    baseline = deferLeagueRefresh(readBaseline, 0)
                    joinEpoch += 1
                    joined = status === 'SUBSCRIBED'
                    receive.reset()
                    setLeagueChangesConnected(leagueId, false)
                    if (joined) baseline.trigger()
                },
                watches: [{ table: 'league_change_hints', filter: `league_id=eq.${leagueId}`, onChange: payload => {
                    if (current() && payload.eventType !== 'DELETE' && !receive(payload.new)) {
                        setLeagueChangesConnected(leagueId, false)
                        baseline.trigger()
                    }
                } }],
            })
            cleanup = () => reportRealtimeCleanup('league changes', unsubscribeFromTableChanges(channel))
        }).catch(error => { if (current()) console.error('Could not subscribe to league changes.', error) })
        return () => {
            disposed = true
            baseline.cancel()
            setLeagueChangesConnected(leagueId, false)
            cleanup?.()
        }
    }, [leagueId, userId, validated])
}
